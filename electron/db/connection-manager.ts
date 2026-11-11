import type { ConnectionInput, ConnectResult, DbType, TestResult } from '../../shared/models';
import { AppError } from '../ipc/errors';
import type { ConnectionStore } from '../store/connection-store';
import type { ConnectionConfig, DbDriver, DbSession } from './driver';

export type DriverLookup = (type: DbType) => DbDriver;

/** Owns every open database session, keyed by connection profile id. */
export class ConnectionManager {
  private readonly sessions = new Map<string, DbSession>();
  private readonly pending = new Map<string, Promise<DbSession>>();

  constructor(
    private readonly store: ConnectionStore,
    private readonly getDriver: DriverLookup,
  ) {}

  /** Opens a throwaway session, measures latency and closes it again. */
  async test(input: ConnectionInput, id?: string): Promise<TestResult> {
    let password = input.password;
    if (!password && id) password = await this.store.getPassword(id);
    const config = toConfig(input, password ?? '');

    const started = performance.now();
    const session = await this.getDriver(config.type).open(config);
    const latencyMs = Math.round(performance.now() - started);
    try {
      return { latencyMs, serverVersion: await session.serverVersion() };
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  async connect(id: string, password?: string): Promise<ConnectResult> {
    const session = await this.openSession(id, password);
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

  private openSession(id: string, password?: string): Promise<DbSession> {
    const open = this.sessions.get(id);
    if (open) return Promise.resolve(open);
    // Double-clicking "connect" must not open two pools.
    const inFlight = this.pending.get(id);
    if (inFlight) return inFlight;

    const opening = (async () => {
      const profile = await this.store.get(id);
      const secret = password || (await this.store.getPassword(id));
      if (secret === undefined) {
        throw new AppError('PASSWORD_REQUIRED', 'Wachtwoord nodig om te verbinden.');
      }
      const session = await this.getDriver(profile.type).open(
        toConfig({ ...profile, savePassword: false }, secret),
      );
      this.sessions.set(id, session);
      return session;
    })();

    this.pending.set(id, opening);
    return opening.finally(() => this.pending.delete(id));
  }
}

function toConfig(input: Omit<ConnectionInput, 'password'>, password: string): ConnectionConfig {
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
