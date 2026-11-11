import { describe, expect, it } from 'vitest';
import { classify, readOnlyViolation, splitStatements, statementAt } from './sql';

const sqls = (text: string) => splitStatements(text).map((s) => s.sql);

describe('splitStatements', () => {
  it('splits on semicolons and trims', () => {
    expect(sqls('SELECT 1;  SELECT 2 ;\n\nSELECT 3')).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
  });

  it('ignores semicolons in strings, identifiers and comments', () => {
    const text = [
      'SELECT \'a;b\', "c;d", `e;f` FROM t; -- not; here',
      "SELECT 'it''s; fine', 'back\\'slash;';",
      '/* block; comment */ SELECT 2; # hash; comment',
    ].join('\n');
    expect(sqls(text)).toEqual([
      'SELECT \'a;b\', "c;d", `e;f` FROM t',
      "-- not; here\nSELECT 'it''s; fine', 'back\\'slash;'",
      '/* block; comment */ SELECT 2',
    ]);
  });

  it('drops statements that are only comments or whitespace', () => {
    expect(sqls('-- just a note\n;\n /* x */ ;  ; SELECT 1')).toEqual(['SELECT 1']);
  });

  it('keeps MySQL executable comments as SQL', () => {
    expect(sqls('/*!40101 SET NAMES utf8 */;')).toEqual(['/*!40101 SET NAMES utf8 */']);
  });

  it('honours DELIMITER for procedure bodies', () => {
    const text = [
      'DELIMITER $$',
      'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$',
      'DELIMITER ;',
      'CALL p();',
    ].join('\n');
    expect(sqls(text)).toEqual(['CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', 'CALL p()']);
  });

  it('reports offsets that point at the statement text', () => {
    const text = 'SELECT 1;\n  SELECT 22;';
    for (const s of splitStatements(text)) expect(text.slice(s.from, s.to)).toBe(s.sql);
  });

  it('handles an unterminated string without hanging', () => {
    expect(sqls("SELECT 'open")).toEqual(["SELECT 'open"]);
  });
});

describe('statementAt', () => {
  const text = 'SELECT 1;\nSELECT 2;\n\nSELECT 3';
  const statements = splitStatements(text);
  it.each([
    [0, 'SELECT 1'],
    [9, 'SELECT 1'], // right after the semicolon
    [12, 'SELECT 2'],
    [20, 'SELECT 2'], // blank line after it
    [text.length, 'SELECT 3'],
  ])('cursor %i is in %s', (cursor, sql) => {
    expect(statementAt(statements, cursor)?.sql).toBe(sql);
  });
});

describe('classify', () => {
  it.each([
    ['SELECT * FROM t', 'read'],
    ['  (SELECT 1) UNION (SELECT 2)', 'read'],
    ['show tables', 'read'],
    ['EXPLAIN SELECT 1', 'read'],
    ['WITH x AS (SELECT 1) SELECT * FROM x', 'read'],
    ['WITH x AS (SELECT 1) UPDATE t JOIN x SET a = 1', 'write'],
    ["SELECT * FROM t INTO OUTFILE '/tmp/x'", 'write'],
    ['INSERT INTO t VALUES (1)', 'write'],
    ['update t set a = 1 where id = 2', 'write'],
    ['DROP TABLE t', 'write'],
    ['CALL p()', 'write'],
    ['USE app_dev', 'session'],
    ['SET @x = 1', 'session'],
    ['BEGIN', 'session'],
    ['-- comment first\nSELECT 1', 'read'],
    ['SELEC 1', 'unknown'],
    ['TRUNCATE t', 'write'],
  ])('%s is %s', (sql, kind) => {
    expect(classify(sql).kind).toBe(kind);
  });

  it('flags UPDATE and DELETE without WHERE', () => {
    expect(classify('DELETE FROM t').unbounded).toBe(true);
    expect(classify('UPDATE t SET a = (SELECT 1 FROM u WHERE b)').unbounded).toBe(true);
    expect(classify('DELETE FROM t WHERE id = 1').unbounded).toBe(false);
    expect(classify("UPDATE t SET note = 'where'").unbounded).toBe(true);
  });
});

describe('readOnlyViolation', () => {
  it('allows reads and harmless session statements', () => {
    expect(readOnlyViolation('SELECT 1')).toBeNull();
    expect(readOnlyViolation('USE app_dev')).toBeNull();
    expect(readOnlyViolation('SET @x = 1')).toBeNull();
    expect(readOnlyViolation('START TRANSACTION READ ONLY')).toBeNull();
  });

  it('blocks writes and switching back to read-write', () => {
    expect(readOnlyViolation('DELETE FROM t')).toContain('DELETE');
    expect(readOnlyViolation('SET SESSION TRANSACTION READ WRITE')).not.toBeNull();
    expect(readOnlyViolation('SET @@session.transaction_read_only = 0')).not.toBeNull();
    expect(readOnlyViolation('SET tx_read_only = 0')).not.toBeNull();
    expect(readOnlyViolation('START TRANSACTION READ WRITE')).not.toBeNull();
  });
});
