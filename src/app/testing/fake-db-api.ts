import type { DbApi } from '../../../shared/ipc-contract';
import type {
  ColumnInfo,
  ConnectionProfile,
  DatabaseInfo,
  Result,
  RowsPage,
  RowsRequest,
  RunRequest,
  RunResult,
  SchemaObject,
} from '../../../shared/models';

/**
 * Fake SQL execution: SELECT returns one row with the statement's number, `SELEC` is a syntax
 * error, anything else is a write that changed one row. Stops at the first error, like the server.
 */
export function fakeRun(request: RunRequest): RunResult {
  const results: RunResult['results'] = [];
  for (const [index, sql] of request.statements.entries()) {
    if (/^selec\b/i.test(sql)) {
      results.push({
        kind: 'error',
        index,
        sql,
        durationMs: 1,
        error: { code: 'ER_PARSE_ERROR', message: `syntax error near '${sql}'` },
      });
      break;
    }
    if (/^select/i.test(sql)) {
      results.push({
        kind: 'rows',
        index,
        sql,
        durationMs: 1,
        columns: [
          { name: 'n', type: 'int' },
          { name: 'n', type: 'int' },
        ],
        rows: [[String(index + 1), null]],
        truncated: false,
      });
    } else {
      results.push({
        kind: 'ok',
        index,
        sql,
        durationMs: 1,
        affectedRows: 1,
        insertId: null,
        warnings: 0,
        info: '',
      });
    }
  }
  return { results, database: request.database ?? 'app_dev' };
}

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
  readOnly: false,
  hasPassword: true,
  ssh: null,
  hasSshSecret: false,
  temporary: false,
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

/** A fake `customers` table with 450 rows: id, email, status (every 7th status NULL). */
export const FAKE_ROW_COUNT = 450;

export function fakeRows(request: RowsRequest): RowsPage {
  let ids = Array.from({ length: FAKE_ROW_COUNT }, (_, i) => i + 1);
  if (request.where) ids = ids.filter((id) => id % 2 === 0); // any filter: even ids only
  if (request.orderBy[0]?.direction === 'desc') ids.reverse();
  const slice = ids.slice(request.offset, request.offset + request.limit);
  return {
    columns: ['id', 'email', 'status'],
    rows: slice.map((id) => [String(id), `user${id}@example.com`, id % 7 === 0 ? null : 'open']),
    hasMore: request.offset + request.limit < ids.length,
    durationMs: 3,
  };
}

/** In-memory DbApi for component and store tests. Override any method per test. */
export function fakeDbApi(overrides: Partial<DbApi> = {}): DbApi {
  return {
    appInfo: () => ok({ encryptionAvailable: true, version: '0.0.0-test' }),
    pickDatabaseFile: () => ok('/home/test/app.db'),
    listConnections: () => ok([PROFILE]),
    saveConnection: () => ok(PROFILE),
    deleteConnection: () => ok(undefined),
    testConnection: () => ok({ latencyMs: 12, serverVersion: '8.0.40' }),
    connect: () => ok({ serverVersion: '8.0.40' }),
    trustHostKey: (_id, fingerprint) =>
      ok({ ...PROFILE, ssh: PROFILE.ssh && { ...PROFILE.ssh, hostKey: fingerprint } }),
    pickKeyFile: () => ok(null),
    disconnect: () => ok(undefined),
    listDatabases: () => ok(DATABASES),
    listObjects: () => ok(OBJECTS),
    listColumns: () => ok(COLUMNS),
    readRows: (_id, _db, _table, request) => ok(fakeRows(request)),
    countRows: (_id, _db, _table, where) => ok(where ? FAKE_ROW_COUNT / 2 : FAKE_ROW_COUNT),
    listAllColumns: () => ok({ customers: ['id', 'email', 'status'], orders: ['id', 'total'] }),
    applyChanges: (_id, _db, _table, changes) =>
      ok({
        deleted: changes.deletes.length,
        updated: changes.updates.length,
        inserted: changes.inserts.length,
      }),
    runScript: (_id, _tab, request) => ok(fakeRun(request)),
    cancelScript: () => ok(undefined),
    closeEditor: () => ok(undefined),
    updateState: () => ok({ status: 'unsupported' as const }),
    checkForUpdates: () => ok({ status: 'current' as const }),
    installUpdate: () => ok(undefined),
    releaseNotes: () => ok([]),
    pickImportFile: () => ok('/home/test/dump.sql'),
    inspectImportFile: (file) =>
      ok({
        file,
        name: file.split('/').pop() ?? file,
        size: 1234,
        kind: 'script' as const,
        entries: [],
      }),
    startSqlImport: () => ok({ jobId: 'job-00000001' }),
    cancelTransfer: () => ok(undefined),
    onTransfer: () => () => undefined,
    takeLaunch: () => ok(null),
    onLaunch: () => () => undefined,
    onUpdateState: () => () => undefined,
    ...overrides,
  };
}
