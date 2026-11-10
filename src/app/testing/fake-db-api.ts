import type { DbApi } from '../../../shared/ipc-contract';
import type { ConnectionProfile, Result } from '../../../shared/models';

export const PROFILE: ConnectionProfile = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'lokaal-dev',
  type: 'mysql',
  host: 'localhost',
  port: 3306,
  database: 'app_dev',
  user: 'root',
  ssl: false,
  allowSelfSigned: false,
  color: 'green',
  hasPassword: true,
};

const ok = <T>(data: T): Promise<Result<T>> => Promise.resolve({ ok: true, data });

/** In-memory DbApi for component and store tests. Override any method per test. */
export function fakeDbApi(overrides: Partial<DbApi> = {}): DbApi {
  return {
    appInfo: () => ok({ encryptionAvailable: true }),
    listConnections: () => ok([PROFILE]),
    saveConnection: () => ok(PROFILE),
    deleteConnection: () => ok(undefined),
    testConnection: () => ok({ latencyMs: 12, serverVersion: '8.0.40' }),
    connect: () => ok({ serverVersion: '8.0.40' }),
    disconnect: () => ok(undefined),
    ...overrides,
  };
}
