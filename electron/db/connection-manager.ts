import type {
  ConnectionInput,
  ConnectResult,
  ConnectSecrets,
  DbType,
  SshSettings,
  TestResult,
} from '../../shared/models';
import { AppError } from '../ipc/errors';
import type { ConnectionStore } from '../store/connection-store';
import type { ConnectionConfig, DbDriver, DbSession } from './driver';
import { openTunnel, type Tunnel, type TunnelTarget } from './ssh-tunnel';

export type DriverLookup = (type: DbType) => DbDriver;
export type TunnelOpener = (
  settings: SshSettings,
  secret: string | undefined,
  target: TunnelTarget,
) => Promise<Tunnel>;

/** Owns every open database session, keyed by connection profile id. */
export class ConnectionManager {
  private readonly sessions = new Map<string, DbSession>();
  private readonly pending = new Map<string, Promise<DbSession>>();

  constructor(
    private readonly store: ConnectionStore,
    private readonly getDriver: DriverLookup,
    private readonly tunnel: TunnelOpener = openTunnel,
  ) {}

  /** Opens a throwaway session, measures latency and closes it again. */
  async test(input: ConnectionInput, id?: string): Promise<TestResult> {
    let password = input.password;
    if (!password && id) password = await this.store.getPassword(id);
    let sshSecret = input.sshSecret;
    if (!sshSecret && id && input.ssh) sshSecret = await this.store.getSshSecret(id);

    const started = performance.now();
    const session = await this.open(
      toConfig(input, password ?? ''),
      input.type === 'sqlite' ? null : (input.ssh ?? null),
      sshSecret,
    );
    const latencyMs = Math.round(performance.now() - started);
    try {
      return { latencyMs, serverVersion: await session.serverVersion() };
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  async connect(id: string, secrets: ConnectSecrets = {}): Promise<ConnectResult> {
    const session = await this.openSession(id, secrets);
    return { serverVersion: await session.serverVersion() };
  }

  /** The open session for a profile; later steps (schema tree, table view) query through this. */
  session(id: string): DbSession {
    const session = this.sessions.get(id);
    if (!session) throw new AppError('NOT_CONNECTED', 'Niet verbonden met deze database.');
    return session;
  }

  isConnected(id: string): boolean {
    return this.sessions.has(id);
  }

  async disconnect(id: string): Promise<void> {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    await session?.close();
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.disconnect(id)));
  }

  private openSession(id: string, secrets: ConnectSecrets): Promise<DbSession> {
    const open = this.sessions.get(id);
    if (open) return Promise.resolve(open);
    // Double-clicking "connect" must not open two pools.
    const inFlight = this.pending.get(id);
    if (inFlight) return inFlight;

    const opening = (async () => {
      const profile = await this.store.get(id);
      // SQLite has no password: the file is the whole connection.
      const secret =
        profile.type === 'sqlite' ? '' : secrets.password || (await this.store.getPassword(id));
      const ssh = profile.type === 'sqlite' ? null : profile.ssh;
      const sshSecret =
        ssh && (ssh.auth === 'password' || ssh.auth === 'key')
          ? secrets.sshSecret || (await this.store.getSshSecret(id))
          : undefined;
      if (ssh?.auth === 'password' && sshSecret === undefined) {
        throw new AppError('SSH_SECRET_REQUIRED', 'SSH-wachtwoord nodig.');
      }
      if (secret === undefined) {
        throw new AppError('PASSWORD_REQUIRED', 'Wachtwoord nodig om te verbinden.');
      }
      const session = await this.open(
        toConfig({ ...profile, savePassword: false }, secret),
        ssh,
        sshSecret,
      );
      this.sessions.set(id, session);
      return session;
    })();

    this.pending.set(id, opening);
    return opening.finally(() => this.pending.delete(id));
  }

  /** Opens the driver session, through an SSH tunnel when the profile has one. */
  private async open(
    config: ConnectionConfig,
    ssh: SshSettings | null,
    sshSecret: string | undefined,
  ): Promise<DbSession> {
    const driver = this.getDriver(config.type);
    if (!ssh) return driver.open(config);

    // The database host is resolved on the SSH server: "localhost" there is that machine.
    const tunnel = await this.tunnel(ssh, sshSecret, {
      host: config.host || 'localhost',
      port: config.port,
    });
    let session: DbSession;
    try {
      session = await driver.open({
        ...config,
        host: tunnel.host,
        port: tunnel.port,
        tlsServerName: config.host,
      });
    } catch (err) {
      await tunnel.close();
      // A refused forward shows up in the driver as a dropped connection; say what happened.
      throw tunnel.lastForwardError() ?? err;
    }
    const close = session.close.bind(session);
    return Object.assign(session, {
      async close() {
        try {
          await close();
        } finally {
          await tunnel.close();
        }
      },
    });
  }
}

function toConfig(
  input: Omit<ConnectionInput, 'password' | 'ssh'>,
  password: string,
): ConnectionConfig {
  return {
    type: input.type,
    host: input.host,
    port: input.port,
    database: input.database,
    user: input.user,
    ssl: input.ssl,
    allowSelfSigned: input.allowSelfSigned,
    readOnly: input.readOnly ?? false,
    password,
  };
}
