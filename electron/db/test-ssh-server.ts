import net from 'node:net';
import { Server, utils, type AuthContext } from 'ssh2';

export interface TestSshServer {
  port: number;
  /** Fingerprint of the server's host key, as the tunnel reports it. */
  fingerprint: string;
  /** Number of logins so far. */
  logins(): number;
  /** Drops every client connection (to test reconnecting). */
  dropClients(): void;
  close(): Promise<void>;
}

export interface TestSshOptions {
  user?: string;
  password?: string;
  /** Public key (OpenSSH format) accepted for public key login. */
  publicKey?: string;
  /** Host key; a fresh one is generated when omitted. */
  hostKey?: string;
}

/** A minimal SSH server for tests: password and/or key login, and `direct-tcpip` forwarding. */
export async function startTestSshServer(options: TestSshOptions = {}): Promise<TestSshServer> {
  const { user = 'tunnel', password = 'geheim' } = options;
  const hostKey = options.hostKey ?? utils.generateKeyPairSync('ed25519').private;
  const parsedHost = utils.parseKey(hostKey);
  if (parsedHost instanceof Error) throw parsedHost;
  const hostPublic = (Array.isArray(parsedHost) ? parsedHost[0] : parsedHost)!.getPublicSSH();
  const allowedKey = options.publicKey ? utils.parseKey(options.publicKey) : null;
  if (allowedKey instanceof Error) throw allowedKey;
  const allowed = Array.isArray(allowedKey) ? allowedKey[0] : allowedKey;

  let logins = 0;
  const clients = new Set<{ end(): void }>();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => undefined);
    client.on('authentication', (ctx: AuthContext) => {
      if (ctx.username !== user) return ctx.reject();
      if (ctx.method === 'password' && options.password !== '' && ctx.password === password)
        return ctx.accept();
      if (ctx.method === 'publickey' && allowed) {
        const same =
          ctx.key.algo === allowed.type && ctx.key.data.equals(allowed.getPublicSSH() as Buffer);
        if (!same) return ctx.reject();
        if (!ctx.signature || !ctx.blob) return ctx.accept(); // key check before signing
        return allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject();
      }
      ctx.reject(allowed ? ['password', 'publickey'] : ['password']);
    });
    client.on('ready', () => {
      logins++;
      client.on('tcpip', (accept, reject, info) => {
        const upstream = net.connect(info.destPort, info.destIP);
        upstream.once('connect', () => {
          const stream = accept();
          stream.pipe(upstream).pipe(stream);
          stream.on('error', () => upstream.destroy());
          upstream.on('error', () => stream.close());
        });
        upstream.once('error', () => reject());
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { createHash } = await import('node:crypto');
  return {
    port: (server.address() as net.AddressInfo).port,
    fingerprint:
      'SHA256:' +
      createHash('sha256')
        .update(hostPublic as Buffer)
        .digest('base64')
        .replace(/=+$/, ''),
    logins: () => logins,
    dropClients: () => {
      for (const c of clients) c.end();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.end();
        server.close(() => resolve());
      }),
  };
}
