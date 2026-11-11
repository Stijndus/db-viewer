import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { utils } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SshSettings } from '../../shared/models';
import { openTunnel, type Tunnel } from './ssh-tunnel';
import { startTestSshServer, type TestSshServer } from './test-ssh-server';

/** A TCP service on "the other machine": replies with what it got, upper-cased. */
async function startEcho(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((s) => s.on('data', (d) => s.write(d.toString().toUpperCase())));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    socket.once('data', (d) => {
      resolve(d.toString());
      socket.end();
    });
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('closed')));
  });
}

const settings = (ssh: TestSshServer, extra: Partial<SshSettings> = {}): SshSettings => ({
  host: '127.0.0.1',
  port: ssh.port,
  user: 'tunnel',
  auth: 'password',
  keyFile: '',
  hostKey: ssh.fingerprint,
  ...extra,
});

describe('openTunnel', () => {
  let ssh: TestSshServer;
  let echo: Awaited<ReturnType<typeof startEcho>>;
  let tunnel: Tunnel | null = null;

  beforeEach(async () => {
    ssh = await startTestSshServer();
    echo = await startEcho();
  });
  afterEach(async () => {
    await tunnel?.close();
    tunnel = null;
    await ssh.close();
    await echo.close();
  });

  it('forwards local sockets through SSH to the target', async () => {
    tunnel = await openTunnel(settings(ssh), 'geheim', { host: '127.0.0.1', port: echo.port });
    expect(tunnel.host).toBe('127.0.0.1');
    expect(await roundTrip(tunnel.port, 'hallo')).toBe('HALLO');
    // Pools open several connections: all go through the one SSH login.
    const both = await Promise.all([roundTrip(tunnel.port, 'a'), roundTrip(tunnel.port, 'b')]);
    expect(both).toEqual(['A', 'B']);
    expect(ssh.logins()).toBe(1);
  });

  it('reports an unknown host key with its fingerprint', async () => {
    const err = await openTunnel(settings(ssh, { hostKey: '' }), 'geheim', {
      host: '127.0.0.1',
      port: echo.port,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SSH_HOST_KEY_UNKNOWN', fingerprint: ssh.fingerprint });
  });

  it('refuses a changed host key', async () => {
    const other = await startTestSshServer();
    const err = await openTunnel(settings(other, { hostKey: ssh.fingerprint }), 'geheim', {
      host: '127.0.0.1',
      port: echo.port,
    }).catch((e: unknown) => e);
    await other.close();
    expect(err).toMatchObject({ code: 'SSH_HOST_KEY_CHANGED', fingerprint: other.fingerprint });
  });

  it('says when the password is wrong or missing', async () => {
    const target = { host: '127.0.0.1', port: echo.port };
    await expect(openTunnel(settings(ssh), 'fout', target)).rejects.toMatchObject({
      code: 'SSH_AUTH_FAILED',
    });
    await expect(openTunnel(settings(ssh), undefined, target)).rejects.toMatchObject({
      code: 'SSH_SECRET_REQUIRED',
    });
  });

  it('says when the SSH server is not there', async () => {
    const free = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const port = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(port));
      });
    });
    await expect(
      openTunnel(settings(ssh, { port: free }), 'geheim', { host: '127.0.0.1', port: echo.port }),
    ).rejects.toMatchObject({ code: 'SSH_UNREACHABLE' });
  });

  it('logs in with a private key, and asks for the passphrase of an encrypted one', async () => {
    const keys = utils.generateKeyPairSync('ed25519', {
      passphrase: 'zin',
      cipher: 'aes256-cbc',
      rounds: 16,
    });
    await ssh.close();
    ssh = await startTestSshServer({ publicKey: keys.public });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbv-ssh-'));
    const keyFile = path.join(dir, 'id_ed25519');
    await fs.writeFile(keyFile, keys.private);
    const target = { host: '127.0.0.1', port: echo.port };
    const keyed = settings(ssh, { auth: 'key', keyFile });

    await expect(openTunnel(keyed, undefined, target)).rejects.toMatchObject({
      code: 'SSH_SECRET_REQUIRED',
    });
    await expect(openTunnel(keyed, 'verkeerd', target)).rejects.toMatchObject({
      code: 'SSH_KEY_PASSPHRASE_WRONG',
    });
    tunnel = await openTunnel(keyed, 'zin', target);
    expect(await roundTrip(tunnel.port, 'sleutel')).toBe('SLEUTEL');

    await expect(
      openTunnel({ ...keyed, keyFile: path.join(dir, 'bestaat-niet') }, 'zin', target),
    ).rejects.toMatchObject({ code: 'SSH_KEY_UNREADABLE' });
  });

  it('remembers why a forward failed (database not reachable from the SSH server)', async () => {
    const closedPort = echo.port;
    await echo.close();
    echo = await startEcho();
    tunnel = await openTunnel(settings(ssh), 'geheim', { host: '127.0.0.1', port: closedPort });
    await expect(roundTrip(tunnel.port, 'x')).rejects.toThrow();
    expect(tunnel.lastForwardError()).toMatchObject({ code: 'SSH_FORWARD_FAILED' });
  });

  it('logs in again after the SSH connection dropped', async () => {
    tunnel = await openTunnel(settings(ssh), 'geheim', { host: '127.0.0.1', port: echo.port });
    expect(await roundTrip(tunnel.port, 'een')).toBe('EEN');
    ssh.dropClients();
    await new Promise((r) => setTimeout(r, 100));
    expect(await roundTrip(tunnel.port, 'twee')).toBe('TWEE');
    expect(ssh.logins()).toBe(2);
  });
});
