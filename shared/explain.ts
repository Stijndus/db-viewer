/**
 * EXPLAIN per dialect: the statements that show how the server would run a query, without running
 * it. None of these execute the statement itself, so a write needs no confirmation.
 */
import type { DbType } from './models';

export interface ExplainPlan {
  /** What to send, in order. */
  statements: string[];
  /** For each explained statement, the index of its plan among the results. */
  planAt: number[];
  /** To run afterwards even when the plan failed (SQL Server: switch SHOWPLAN off again). */
  cleanup: string[];
}

const strip = (sql: string) => sql.trim().replace(/;\s*$/, '');

/** True when the statement already asks for a plan; it is then sent as it is. */
export function isExplain(sql: string): boolean {
  return /^\s*(EXPLAIN|DESCRIBE\s+(SELECT|INSERT|UPDATE|DELETE|WITH))\b/i.test(sql);
}

export function explainStatements(sqls: string[], dialect: DbType): ExplainPlan {
  const queries = sqls.map(strip).filter(Boolean);
  if (dialect === 'mssql') {
    // SHOWPLAN must be its own batch; while it is on, statements are only compiled.
    return {
      statements: ['SET SHOWPLAN_TEXT ON', ...queries, 'SET SHOWPLAN_TEXT OFF'],
      planAt: queries.map((_, i) => i + 1),
      cleanup: ['SET SHOWPLAN_TEXT OFF'],
    };
  }
  const prefix = dialect === 'sqlite' ? 'EXPLAIN QUERY PLAN ' : 'EXPLAIN ';
  return {
    statements: queries.map((q) => (isExplain(q) ? q : prefix + q)),
    planAt: queries.map((_, i) => i),
    cleanup: [],
  };
}
