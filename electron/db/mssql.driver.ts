import sql from 'mssql';
import { refuseReadOnly } from './common';
import type { ConnectionConfig, DbDriver, DbSession } from './driver';
import { mssqlError, poolConfig } from './mssql.common';
import * as data from './mssql.data';
import { MssqlEditorSessions } from './mssql.editor';
import * as meta from './mssql.metadata';

export const mssqlDriver: DbDriver = {
  type: 'mssql',

  async open(cfg: ConnectionConfig): Promise<DbSession> {
    const pool = new sql.ConnectionPool(poolConfig(cfg));
    pool.on('error', () => undefined); // a dropped idle connection; the next request reconnects
    let version: string;
    try {
      await pool.connect();
      const res = await pool
        .request()
        .query<{ v: string; e: string }>(
          "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS v, CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS e",
        );
      const row = res.recordset[0];
      version = `SQL Server ${row?.v ?? 'onbekend'}${row?.e ? ` (${row.e})` : ''}`;
    } catch (err) {
      await pool.close().catch(() => undefined);
      throw mssqlError(err, 'connect');
    }
    const editors = new MssqlEditorSessions(cfg);
    const guard = <T>(promise: Promise<T>): Promise<T> =>
      promise.catch((err: unknown) => {
        throw mssqlError(err);
      });

    return {
      serverVersion: async () => version,
      listDatabases: () => guard(meta.listSchemas(pool)),
      listObjects: (schema) => guard(meta.listObjects(pool, schema)),
      listColumns: (schema, table) => guard(meta.listColumns(pool, schema, table)),
      listAllColumns: (schema) => guard(meta.listAllColumns(pool, schema)),
      readRows: (schema, table, request) => data.readRows(pool, schema, table, request),
      countRows: (schema, table, where) => data.countRows(pool, schema, table, where),
      async applyChanges(schema, table, changes) {
        refuseReadOnly(cfg.readOnly);
        return data.applyChanges(pool, schema, table, changes);
      },
      runScript: (tabId, request) => editors.run(tabId, request),
      cancelScript: (tabId) => editors.cancel(tabId),
      closeEditor: (tabId) => editors.close(tabId),
      async query(text, params) {
        const request = pool.request();
        (params ?? []).forEach((v, i) => request.input(`p${i + 1}`, v));
        const res = await guard(request.query(text));
        return { rows: res.recordset ?? [], fields: Object.keys(res.recordset?.columns ?? {}) };
      },
      async close() {
        await editors.closeAll();
        await pool.close();
      },
    };
  },
};
