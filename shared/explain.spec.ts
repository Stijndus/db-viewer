import { describe, expect, it } from 'vitest';
import { explainStatements, isExplain } from './explain';

describe('explainStatements', () => {
  it('prefixes per dialect and drops the semicolon', () => {
    expect(explainStatements(['SELECT 1;'], 'mysql').statements).toEqual(['EXPLAIN SELECT 1']);
    expect(explainStatements(['SELECT 1'], 'postgres').statements).toEqual(['EXPLAIN SELECT 1']);
    expect(explainStatements(['SELECT 1'], 'sqlite').statements).toEqual([
      'EXPLAIN QUERY PLAN SELECT 1',
    ]);
  });
  it('wraps SQL Server statements in SHOWPLAN and switches it off afterwards', () => {
    const plan = explainStatements(['SELECT 1', 'SELECT 2'], 'mssql');
    expect(plan.statements).toEqual([
      'SET SHOWPLAN_TEXT ON',
      'SELECT 1',
      'SELECT 2',
      'SET SHOWPLAN_TEXT OFF',
    ]);
    expect(plan.planAt).toEqual([1, 2]);
    expect(plan.cleanup).toEqual(['SET SHOWPLAN_TEXT OFF']);
  });
  it('leaves an EXPLAIN as it is', () => {
    expect(isExplain('explain analyze select 1')).toBe(true);
    expect(isExplain('SELECT 1')).toBe(false);
    expect(explainStatements(['EXPLAIN SELECT 1'], 'mysql').statements).toEqual([
      'EXPLAIN SELECT 1',
    ]);
  });
});
