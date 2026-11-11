import pg from 'pg';
import { refuseReadOnly } from './common';
import type { ConnectionConfig, DbDriver, DbSession } from './driver';
import * as data from './postgres.data';
import * as exporter from './postgres.export';
import { clientConfig, pgError } from './postgres.common';
import { PgEditorSessions } from './postgres.editor';
import * as meta from './postgres.metadata';

export const postgresDriver: DbDriver = {
  type: 'postgres',

  async open(cfg: ConnectionConfig): Promise<DbSession> {
    const pool = new pg.Pool({ ...clientConfig(cfg), max: 5, idleTimeoutMillis: 30_000 });
    pool.on('error', () => undefined); // an idle connection dropped; the next query reconnects
    let version: string;
    try {
      version = await readVersion(pool);
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw pgError(err);
    }
    const editors = new PgEditorSessions(cfg, pool);
    const guard = <T>(promise: Promise<T>): Promise<T> =>
      promise.catch((err: unknown) => {
        throw pgError(err);
      });

    return {
      serverVersion: async () => version,
      listDatabases: () => guard(meta.listSchemas(pool)),
      listObjects: (schema) => guard(meta.listObjects(pool, schema)),
      listColumns: (schema, table) => guard(meta.listColumns(pool, schema, table)),
      listAllColumns: (schema) => guard(meta.listAllColumns(pool, schema)),
      readRows: (schema, table, request) => guard(data.readRows(pool, schema, table, request)),
      streamRows: (source, onBatch, signal) => exporter.streamRows(pool, source, onBatch, signal),
      tableDdl: (schema, table) => guard(exporter.tableDdl(pool, schema, table)),
      countRows: (schema, table, where) => guard(data.countRows(pool, schema, table, where)),
      async applyChanges(schema, table, changes) {
        refuseReadOnly(cfg.readOnly);
        return data.applyChanges(pool, schema, table, changes);
      },
      runScript: (tabId, request) => editors.run(tabId, request),
      cancelScript: (tabId) => editors.cancel(tabId),
      closeEditor: (tabId) => editors.close(tabId),
      async query(sql, params) {
        const res = await guard(pool.query(sql, params));
        return { rows: res.rows, fields: res.fields.map((f) => f.name) };
      },
      async close() {
        await editors.closeAll();
        await pool.end();
      },
    };
  },
};

async function readVersion(pool: pg.Pool): Promise<string> {
  const res = await pool.query<{ v: string }>("SELECT current_setting('server_version') AS v");
  return `PostgreSQL ${String(res.rows[0]?.v ?? 'onbekend').split(' ')[0]}`;
}
