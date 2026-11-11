import type pg from 'pg';
import type { ApplyResult, ChangeSet } from '../../shared/changes';
import { qualifiedName } from '../../shared/dialect';
import type { RowsPage, RowsRequest } from '../../shared/models';
import {
  orderByClause,
  QUERY_TIMEOUT_MS,
  saveChanges,
  toCell,
  whereClause,
  type EditTarget,
} from './common';
import { pgError } from './postgres.common';

/** Extended protocol: exactly one statement per query. (@types/pg doesn't know `queryMode` yet.) */
function extended(text: string, values?: unknown[]): pg.QueryConfig {
  return { text, values, queryMode: 'extended' } as pg.QueryConfig;
}

export function buildSelect(schema: string, table: string, req: RowsRequest): string {
  const limit = Math.trunc(req.limit) + 1; // one extra row reveals whether a next page exists
  const offset = Math.trunc(req.offset);
  return (
    `SELECT * FROM ${qualifiedName(schema, table, 'postgres')}` +
    whereClause(req.where) +
    orderByClause(req.orderBy, 'postgres') +
    ` LIMIT ${limit} OFFSET ${offset}`
  );
}

export function buildCount(schema: string, table: string, where?: string): string {
  return `SELECT COUNT(*) AS n FROM ${qualifiedName(schema, table, 'postgres')}${whereClause(where)}`;
}

/**
 * Runs `fn` on a dedicated connection inside a READ ONLY transaction with a statement timeout.
 * Queries use the extended protocol, which accepts exactly one statement: a `;` in the user's filter
 * cannot start a second one.
 */
async function readOnly<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
    return await fn(client);
  } catch (err) {
    const e = pgError(err) as Error & { fatal?: boolean; code?: string; message: string };
    if (e.fatal) broken = e;
    if (e.code === '57014' && /timeout/i.test(e.message)) e.code = 'PROTOCOL_SEQUENCE_TIMEOUT';
    throw e;
  } finally {
    if (!broken) await client.query('ROLLBACK').catch(() => undefined);
    client.release(broken);
  }
}

export function readRows(
  pool: pg.Pool,
  schema: string,
  table: string,
  req: RowsRequest,
): Promise<RowsPage> {
  return readOnly(pool, async (client) => {
    const started = performance.now();
    const res = await client.query<unknown[]>({
      ...extended(buildSelect(schema, table, req)),
      rowMode: 'array',
    } as pg.QueryArrayConfig);
    const durationMs = Math.round(performance.now() - started);
    return {
      columns: res.fields.map((f) => f.name),
      rows: res.rows.slice(0, req.limit).map((row) => row.map(toCell)),
      hasMore: res.rows.length > req.limit,
      durationMs,
    };
  });
}

export function countRows(
  pool: pg.Pool,
  schema: string,
  table: string,
  where?: string,
): Promise<number> {
  return readOnly(pool, async (client) => {
    const res = await client.query<{ n: string }>(extended(buildCount(schema, table, where)));
    return Number(res.rows[0]?.n ?? 0);
  });
}

export async function applyChanges(
  pool: pg.Pool,
  schema: string,
  table: string,
  changes: ChangeSet,
): Promise<ApplyResult> {
  const client = await pool.connect();
  let broken: Error | undefined;
  const q = async (text: string, values?: unknown[]) => {
    try {
      return await client.query(extended(text, values));
    } catch (err) {
      const e = pgError(err) as Error & { fatal?: boolean };
      if (e.fatal) broken = e;
      throw e;
    }
  };
  try {
    return await saveChanges(
      {
        target: () => readTarget(q, schema, table),
        begin: async () => void (await q('BEGIN')),
        execute: async (s) => (await q(s.sql, s.params)).rowCount ?? 0,
        commit: async () => void (await q('COMMIT')),
        rollback: async () => void (await q('ROLLBACK')),
      },
      schema,
      table,
      changes,
      'postgres',
    );
  } finally {
    client.release(broken);
  }
}

type Query = (text: string, values?: unknown[]) => Promise<pg.QueryResult>;

async function readTarget(q: Query, schema: string, table: string): Promise<EditTarget> {
  const rel = await q(
    `SELECT c.oid, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, table],
  );
  const row = rel.rows[0] as { oid: string; relkind: string } | undefined;
  if (!row) return { type: null, columns: [], primaryKey: [] };
  const cols = await q(
    `SELECT a.attname AS name,
            EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)) AS pk
       FROM pg_attribute a
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [row.oid],
  );
  const rows = cols.rows as { name: string; pk: string | boolean }[];
  return {
    type: row.relkind === 'r' || row.relkind === 'p' ? 'table' : 'view',
    columns: rows.map((c) => c.name),
    primaryKey: rows.filter((c) => c.pk === true || c.pk === 't').map((c) => c.name),
  };
}
