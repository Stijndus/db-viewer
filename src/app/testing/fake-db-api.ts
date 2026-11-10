import type { DbApi } from '../../../shared/ipc-contract';
import type {
  ColumnInfo,
  ConnectionProfile,
  DatabaseInfo,
  Result,
  SchemaObject,
} from '../../../shared/models';

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

export const DATABASES: DatabaseInfo[] = [
  { name: 'app_dev', system: false },
  { name: 'information_schema', system: true },
  { name: 'shop', system: false },
];

export const OBJECTS: SchemaObject[] = [
  { name: 'customers', kind: 'table', rowEstimate: 1200, comment: 'Klanten' },
  { name: 'orders', kind: 'table', rowEstimate: 98000, comment: '' },
  { name: 'paid_orders', kind: 'view', rowEstimate: null, comment: 'VIEW' },
  { name: 'refresh_stats', kind: 'procedure', rowEstimate: null, comment: '' },
];

export const COLUMNS: ColumnInfo[] = [
  {
    name: 'id',
    type: 'int',
    nullable: false,
    key: 'primary',
    defaultValue: null,
    extra: 'auto_increment',
    comment: '',
  },
  {
    name: 'email',
    type: 'varchar(255)',
    nullable: false,
    key: 'unique',
    defaultValue: null,
    extra: '',
    comment: '',
  },
  {
    name: 'status',
    type: "enum('open','closed')",
    nullable: false,
    key: 'index',
    defaultValue: 'open',
    extra: '',
    comment: '',
  },
];

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
    listDatabases: () => ok(DATABASES),
    listObjects: () => ok(OBJECTS),
    listColumns: () => ok(COLUMNS),
    ...overrides,
  };
}
