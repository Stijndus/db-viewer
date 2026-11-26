import { randomUUID } from 'node:crypto';
import { createIndexSql } from '../../shared/ddl';
import { qualifiedName, quoteIdent, stringLiteral } from '../../shared/dialect';
import type { DbType, TableDefinition } from '../../shared/models';
import type { DbSession } from './driver';
import { listIndexes } from './structure';

/**
 * Everything that makes up a table, as SQL: its CREATE TABLE, the indexes and foreign keys that
 * statement leaves out (PostgreSQL and SQL Server build it from the columns), and its triggers.
 * MySQL's SHOW CREATE TABLE already holds the keys; SQLite keeps each statement as written.
 */
export async function tableDefinition(
  session: DbSession,
  dialect: DbType,
  database: string,
  table: string,
): Promise<TableDefinition> {
  const tab = `definition-${randomUUID()}`;
  const rows = async (sql: string): Promise<(string | null)[][]> => {
    const result = await session.runScript(tab, { statements: [sql], maxRows: 10_000 });
    const r = result.results[0];
    if (r?.kind === 'error') throw new Error(r.error.message);
    return r?.kind === 'rows'
      ? r.rows.map((row) => row.map((c) => (typeof c === 'string' ? c : null)))
      : [];
  };
  const s = (v: string) => stringLiteral(v, dialect);
  try {
    const create = await session.tableDdl(database, table);
    const extras: string[] = [];
    const triggers: { name: string; sql: string }[] = [];

    if (dialect === 'postgres' || dialect === 'mssql') {
      // Indexes that are not the primary key (unique constraints show up as unique indexes).
      for (const index of await listIndexes(session, dialect, database, table)) {
        if (index.primary) continue;
        extras.push(...createIndexSql(dialect, database, table, index));
      }
      const model = await session.databaseModel(database);
      for (const fk of model.foreignKeys) {
        if (fk.database !== database || fk.table !== table) continue;
        const q = (n: string) => quoteIdent(n, dialect);
        extras.push(
          `ALTER TABLE ${qualifiedName(database, table, dialect)} ADD CONSTRAINT ${q(fk.name)} ` +
            `FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ` +
            `${qualifiedName(fk.refDatabase, fk.refTable, dialect)} (${fk.refColumns.map(q).join(', ')})`,
        );
      }
    }

    switch (dialect) {
      case 'mysql': {
        const names = await rows(
          `SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ${s(database)} AND EVENT_OBJECT_TABLE = ${s(table)} ORDER BY ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER`,
        );
        for (const [name] of names) {
          if (!name) continue;
          const def = await rows(`SHOW CREATE TRIGGER ${qualifiedName(database, name, 'mysql')}`);
          // Trigger, sql_mode, SQL Original Statement, …
          const sql = def[0]?.[2];
          // Without DEFINER the statement also works for another user.
          if (sql)
            triggers.push({ name, sql: sql.replace(/^CREATE\s+DEFINER\s*=\s*\S+\s+/i, 'CREATE ') });
        }
        break;
      }
      case 'postgres':
        for (const [name, sql] of await rows(
          `SELECT t.tgname, pg_get_triggerdef(t.oid, true) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = ${s(database)} AND c.relname = ${s(table)} ORDER BY t.tgname`,
        )) {
          if (name && sql) triggers.push({ name, sql });
        }
        break;
      case 'mssql':
        for (const [name, sql] of await rows(
          `SELECT t.name, OBJECT_DEFINITION(t.object_id) FROM sys.triggers t WHERE t.parent_id = OBJECT_ID(${s(`${quoteIdent(database, 'mssql')}.${quoteIdent(table, 'mssql')}`)}) ORDER BY t.name`,
        )) {
          if (name && sql) triggers.push({ name, sql: sql.trim() });
        }
        break;
      case 'sqlite':
        for (const [type, name, sql] of await rows(
          `SELECT type, name, sql FROM ${qualifiedName(database, 'sqlite_schema', 'sqlite')} WHERE tbl_name = ${s(table)} AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name`,
        )) {
          if (!name || !sql) continue;
          if (type === 'trigger') triggers.push({ name, sql });
          else extras.push(sql);
        }
        break;
    }
    return { create, extras, triggers };
  } finally {
    await session.closeEditor(tab).catch(() => undefined);
  }
}
