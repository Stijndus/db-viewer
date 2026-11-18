import { quoteIdent, stringLiteral } from '../../../../shared/dialect';
import type { DatabaseModel, DbType, ForeignKey } from '../../../../shared/models';

/** Keys of this table that point elsewhere. */
export function keysFrom(model: DatabaseModel, database: string, table: string): ForeignKey[] {
  return model.foreignKeys.filter((k) => k.database === database && k.table === table);
}

/** Keys elsewhere that point to this table. */
export function keysTo(model: DatabaseModel, database: string, table: string): ForeignKey[] {
  return model.foreignKeys.filter((k) => k.refDatabase === database && k.refTable === table);
}

/**
 * The WHERE that finds rows with these values: `col` = 'value' AND …, `col` IS NULL for NULL.
 * Values are compared as text literals, which every dialect converts to the column's type.
 */
export function matchWhere(dialect: DbType, columns: string[], values: (string | null)[]): string {
  return columns
    .map((c, i) => {
      const v = values[i] ?? null;
      const col = quoteIdent(c, dialect);
      return v === null ? `${col} IS NULL` : `${col} = ${stringLiteral(v, dialect)}`;
    })
    .join(' AND ');
}

/** "customers" or "shop.customers" when it is in another database. */
export function tableLabel(database: string, table: string, from: string): string {
  return database === from ? table : `${database}.${table}`;
}
