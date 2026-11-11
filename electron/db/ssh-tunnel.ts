import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import { Client, type ConnectConfig } from 'ssh2';
import type { SshSettings } from '../../shared/models';
import { AppError } from '../ipc/errors';

export const SSH_TIMEOUT_MS = 10_000;

/** Where the database lives, as seen from the SSH server. */
export interface TunnelTarget {
  host: string;
  port: number;
}

export interface Tunnel {
  /** Local address the driver connects to instead of the database host. */
  readonly host: '127.0.0.1';
  readonly port: number;
  /** Why the last forward through SSH failed (database not reachable from the SSH server). */
  lastForwardError(): AppError | null;
  close(): Promise<void>;
}

/** OpenSSH-style fingerprint of a raw host key: `SHA256:` + unpadded base64. */
export function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

/**
 * Opens an SSH connection and a local TCP listener on 127.0.0.1; every socket to it is forwarded
 * through SSH to the target, like `ssh -L`. Database drivers connect to the listener, so pools and
 * the SQL editor's extra connections all go through one SSH login. If SSH drops, the next socket
 * logs in again.
 */
export async function openTunnel(
  settings: SshSettings,
  secret: string | undefined,
  target: TunnelTarget,
): Promise<Tunnel> {
  const config = await connectConfig(settings, secret);
  let client: Client | null = await login(settings, config);
  let connecting: Promise<Client> | null = null;
  let forwardError: AppError | null = null;
  let closed = false;
  const sockets = new Set<net.Socket>();

  const current = (): Promise<Client> => {
    if (client) return Promise.resolve(client);
    connecting ??= login(settings, config)
      .then((c) => (client = watch(c)))
      .finally(() => (connecting = null));
    return connecting;
  };
  const watch = (c: Client) => {
    c.on('close', () => {
      if (client === c) client = null;
    });
    c.on('error', () => undefined); // reported through the forwarded sockets
    return c;
  };
  watch(client);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.pause();
    current().then(
      (c) =>
        c.forwardOut(
          '127.0.0.1',
          socket.remotePort ?? 0,
          target.host,
          target.port,
          (err, stream) => {
            if (err) {
              forwardError = new AppError(
                'SSH_FORWARD_FAILED',
                `De SSH-server kan ${target.host}:${target.port} niet bereiken.`,
                `Controleer host en poort van de database, gezien vanaf ${settings.host} (vaak localhost). Server: ${err.message}`,
              );
              socket.destroy();
              return;
            }
            forwardError = null;
            socket.pipe(stream).pipe(socket);
            stream.on('error', () => socket.destroy());
            socket.on('close', () => stream.close());
            socket.resume();
          },
        ),
      (err: unknown) => {
        forwardError = err instanceof AppError ? err : null;
        socket.destroy();
      },
    );
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
  } catch (err) {
    client.end();
    throw err;
  }
  const port = (server.address() as net.AddressInfo).port;

  return {
    host: '127.0.0.1',
    port,
    lastForwardError: () => forwardError,
    async close() {
      if (closed) return;
      closed = true;
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      client?.end();
      client = null;
    },
  };
}

async function connectConfig(
  settings: SshSettings,
  secret: string | undefined,
): Promise<ConnectConfig> {
  const base: ConnectConfig = {
    host: settings.host,
    port: settings.port,
    username: settings.user,
    readyTimeout: SSH_TIMEOUT_MS,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 4,
  };
  switch (settings.auth) {
    case 'password':
      if (!secret) throw secretRequired('password');
      // Some servers only offer keyboard-interactive; answer its prompts with the password too.
      return { ...base, password: secret, tryKeyboard: true };
    case 'key': {
      let privateKey: Buffer;
      try {
        privateKey = await fs.readFile(settings.keyFile);
      } catch {
        throw new AppError(
          'SSH_KEY_UNREADABLE',
          'SSH-sleutelbestand kan niet worden gelezen.',
          `Bestaat ${settings.keyFile || '(geen bestand gekozen)'} en mag de app het lezen?`,
        );
      }
      return { ...base, privateKey, passphrase: secret || undefined };
    }
    case 'agent':
      return { ...base, agent: agentSocket() };
    case 'pageant':
      return { ...base, agent: 'pageant' };
  }
}

/** The OpenSSH agent: SSH_AUTH_SOCK, or the Windows OpenSSH agent service's pipe. */
function agentSocket(): string {
  const sock = process.env['SSH_AUTH_SOCK'];
  if (sock) return sock;
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  throw new AppError(
    'SSH_AGENT_UNAVAILABLE',
    'Geen SSH-agent gevonden.',
    'Start ssh-agent en voeg je sleutel toe (ssh-add), of kies een sleutelbestand.',
  );
}

function login(settings: SshSettings, config: ConnectConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let presented: string | null = null;
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(err);
    };

    client.on('ready', () => {
      settled = true;
      resolve(client);
    });
    client.on('error', (err) => fail(translate(err, settings, presented)));
    client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
      finish(prompts.map(() => config.password ?? ''));
    });
    try {
      client.connect({
        ...config,
        hostVerifier: (key: Buffer) => {
          presented = fingerprintOf(key);
          return presented === settings.hostKey;
        },
      });
    } catch (err) {
      fail(translate(err, settings, presented));
    }
  });
}

type SshError = Error & { level?: string; code?: string };

function translate(err: unknown, settings: SshSettings, presented: string | null): unknown {
  const e = err as SshError;
  const where = `${settings.host}:${settings.port}`;
  if (presented && presented !== settings.hostKey) {
    const known = Boolean(settings.hostKey);
    return Object.assign(
      new AppError(
        known ? 'SSH_HOST_KEY_CHANGED' : 'SSH_HOST_KEY_UNKNOWN',
        known
          ? `De sleutel van SSH-server ${settings.host} is veranderd.`
          : `Onbekende SSH-server ${settings.host}.`,
        known
          ? 'Dit kan betekenen dat iemand de verbinding onderschept. Is de server opnieuw geïnstalleerd, vergelijk dan de vingerafdruk met de beheerder voordat je hem vertrouwt.'
          : 'Controleer de vingerafdruk voordat je de server vertrouwt.',
      ),
      { fingerprint: presented },
    );
  }
  if (e?.level === 'client-authentication') {
    return new AppError(
      'SSH_AUTH_FAILED',
      'Inloggen op de SSH-server mislukt.',
      settings.auth === 'password'
        ? `Controleer SSH-gebruiker en -wachtwoord voor ${settings.user}@${settings.host}.`
        : settings.auth === 'key'
          ? 'De server accepteert deze sleutel niet voor deze gebruiker.'
          : 'De agent heeft geen sleutel die de server accepteert (ssh-add -l).',
    );
  }
  if (e?.level === 'client-timeout') {
    return new AppError(
      'SSH_TIMEOUT',
      `SSH-server ${where} reageert niet.`,
      'Firewall, verkeerde poort, of een server die geen SSH spreekt.',
    );
  }
  if (e?.code === 'ECONNREFUSED') {
    return new AppError(
      'SSH_UNREACHABLE',
      `SSH-server ${where} weigert de verbinding.`,
      'Draait sshd en klopt de SSH-poort (meestal 22)?',
    );
  }
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') {
    return new AppError(
      'SSH_UNREACHABLE',
      `SSH-host ${settings.host} niet gevonden.`,
      'Controleer de hostnaam of je VPN.',
    );
  }
  if (e?.code === 'ETIMEDOUT' || e?.code === 'EHOSTUNREACH' || e?.code === 'ENETUNREACH') {
    return new AppError(
      'SSH_UNREACHABLE',
      `SSH-server ${where} is niet bereikbaar.`,
      'Controleer host, poort en firewall.',
    );
  }
  const message = e?.message ?? '';
  if (/integrity check failed|bad passphrase|bad decrypt/i.test(message)) {
    return new AppError(
      'SSH_KEY_PASSPHRASE_WRONG',
      'Wachtwoordzin van de SSH-sleutel klopt niet.',
      'Voer de wachtwoordzin opnieuw in.',
    );
  }
  if (/no passphrase given/i.test(message)) return secretRequired('key');
  if (
    /Cannot parse privateKey|Unsupported key format|Malformed|Unsupported OpenSSH/i.test(message)
  ) {
    return new AppError(
      'SSH_KEY_INVALID',
      'SSH-sleutelbestand wordt niet herkend.',
      'Gebruik een OpenSSH-sleutel (id_ed25519, id_rsa) of een PuTTY .ppk-bestand.',
    );
  }
  if (/agent/i.test(message)) {
    return new AppError(
      'SSH_AGENT_UNAVAILABLE',
      'SSH-agent niet bereikbaar.',
      settings.auth === 'pageant'
        ? 'Start Pageant en laad je sleutel.'
        : 'Draait de OpenSSH Authentication Agent en is je sleutel toegevoegd (ssh-add)?',
    );
  }
  return new AppError('SSH_FAILED', 'SSH-verbinding mislukt.', message || undefined);
}

function secretRequired(kind: 'password' | 'key'): AppError {
  return new AppError(
    'SSH_SECRET_REQUIRED',
    kind === 'password' ? 'SSH-wachtwoord nodig.' : 'Wachtwoordzin voor de SSH-sleutel nodig.',
  );
}
