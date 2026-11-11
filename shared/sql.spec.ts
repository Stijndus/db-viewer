import { describe, expect, it } from 'vitest';
import type { DbType } from './models';
import { classify, readOnlyViolation, ScriptSplitter, splitStatements, statementAt } from './sql';

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

describe('dialects', () => {
  const split = (text: string, d: Parameters<typeof splitStatements>[1]) =>
    splitStatements(text, d).map((s) => s.sql);

  it('PostgreSQL: dollar quotes, E-strings and nested comments', () => {
    const text = [
      "DO $$ BEGIN RAISE NOTICE 'a;b'; END $$;",
      'CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql;',
      "SELECT E'it\\'s; ok', $1;",
      '/* outer /* inner; */ still; */ SELECT 2;',
      "SELECT 'C:\\'; SELECT 3",
    ].join('\n');
    expect(split(text, 'postgres')).toEqual([
      "DO $$ BEGIN RAISE NOTICE 'a;b'; END $$",
      'CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql',
      "SELECT E'it\\'s; ok', $1",
      '/* outer /* inner; */ still; */ SELECT 2',
      "SELECT 'C:\\'",
      'SELECT 3',
    ]);
  });

  it('PostgreSQL: # is an operator, not a comment', () => {
    expect(split('SELECT 5 # 3; SELECT 4', 'postgres')).toEqual(['SELECT 5 # 3', 'SELECT 4']);
  });

  it('SQL Server: batches split on GO only; brackets and nested comments', () => {
    const text = [
      'CREATE PROCEDURE p AS BEGIN SELECT [a;b] FROM t; SELECT 2 END',
      'GO',
      "DECLARE @x int = 1; SELECT N'x;y', @x",
      'go 2',
      '/* a /* GO */ b */ SELECT 3; SELECT 4',
    ].join('\n');
    expect(split(text, 'mssql')).toEqual([
      'CREATE PROCEDURE p AS BEGIN SELECT [a;b] FROM t; SELECT 2 END',
      "DECLARE @x int = 1; SELECT N'x;y', @x",
      '/* a /* GO */ b */ SELECT 3; SELECT 4',
    ]);
  });

  it('SQL Server: a batch is a write when any statement in it writes', () => {
    expect(classify('SELECT 1; DELETE FROM t', 'mssql')).toEqual({
      kind: 'write',
      keyword: 'DELETE',
      unbounded: true,
    });
    expect(classify('SELECT 1 UPDATE t SET a = 1 WHERE id = 2', 'mssql')).toMatchObject({
      kind: 'write',
      unbounded: false,
    });
    expect(classify('SELECT * INTO #tmp FROM t', 'mssql').keyword).toBe('SELECT INTO');
    expect(classify("SELECT [delete], 'update' FROM t -- drop", 'mssql').kind).toBe('read');
    expect(classify('DECLARE @x int = 1; SELECT @x', 'mssql').kind).toBe('session');
  });

  it('SQL Server: GO ends a batch even without a semicolon', () => {
    expect(split('SELECT 1\nGO\nSELECT 2\nGO', 'mssql')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('only MySQL knows DELIMITER', () => {
    expect(split('DELIMITER $$\nSELECT 1$$', 'postgres')).toEqual(['DELIMITER $$\nSELECT 1$$']);
  });

  it('classifies dialect-specific statements', () => {
    expect(classify('DO $$ BEGIN DELETE FROM t; END $$', 'postgres').kind).toBe('write');
    expect(classify('DO SLEEP(1)', 'mysql').kind).toBe('session');
    expect(classify('SELECT * INTO new_t FROM t', 'postgres').kind).toBe('write');
    expect(classify('SELECT * INTO new_t FROM t', 'mssql').kind).toBe('write');
    expect(classify('SELECT 1 INTO @x', 'mysql').kind).toBe('read');
    expect(classify('EXEC sp_who', 'mssql').kind).toBe('write');
    expect(classify('MERGE INTO t USING s ON 1=1 WHEN MATCHED THEN DELETE', 'mssql').kind).toBe(
      'write',
    );
    expect(classify('COPY t TO STDOUT', 'postgres').kind).toBe('write');
    expect(classify('EXPLAIN ANALYZE DELETE FROM t', 'postgres').kind).toBe('write');
    expect(classify('EXPLAIN ANALYZE SELECT 1', 'postgres').kind).toBe('read');
    expect(classify('PRAGMA table_info(t)', 'sqlite').kind).toBe('session');
  });

  it('keeps read-only PostgreSQL sessions read-only', () => {
    expect(readOnlyViolation('SELECT 1', 'postgres')).toBeNull();
    expect(readOnlyViolation('SET default_transaction_read_only = off', 'postgres')).not.toBeNull();
    expect(
      readOnlyViolation(
        "SELECT set_config('default_transaction_read_only', 'off', false)",
        'postgres',
      ),
    ).not.toBeNull();
    expect(readOnlyViolation('BEGIN READ WRITE', 'postgres')).not.toBeNull();
    expect(readOnlyViolation('RESET ALL', 'postgres')).not.toBeNull();
    expect(readOnlyViolation('SET search_path TO app', 'postgres')).toBeNull();
  });

  it('SQL Server read-only: only recognised harmless statements', () => {
    expect(readOnlyViolation('SELECT 1', 'mssql')).toBeNull();
    expect(readOnlyViolation('DECLARE @x int', 'mssql')).toBeNull();
    expect(readOnlyViolation('IF 1=1 DROP TABLE t', 'mssql')).not.toBeNull();
    expect(readOnlyViolation('EXEC sp_who', 'mssql')).not.toBeNull();
  });
});

describe('ScriptSplitter', () => {
  const scripts: [DbType, string][] = [
    [
      'mysql',
      "SET NAMES utf8mb4;\n/*!40101 SET @x=1 */;\nINSERT INTO t VALUES (1,'a;b'),(2,'it''s');\nDELIMITER ;;\nCREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; END ;;\nDELIMITER ;\n-- klaar; echt\nINSERT INTO t VALUES (3, \"x;y\");\nSELECT 1",
    ],
    [
      'postgres',
      "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;\nCOPY_LIKE /* nested /* ; */ */ 1;\nSELECT E'a\\';b';\nSELECT 2;",
    ],
    [
      'mssql',
      'CREATE PROCEDURE p AS\nBEGIN\n  SELECT 1; SELECT 2;\nEND\nGO\nDECLARE @a int = 1;\nPRINT @a\nGO\nSELECT [a;b] FROM t\n',
    ],
  ];

  it.each(scripts)('gives the same statements as splitting at once (%s)', (dialect, script) => {
    const whole = splitStatements(script, dialect).map((s) => s.sql);
    for (const size of [1, 2, 3, 7, 16, 1000]) {
      const splitter = new ScriptSplitter(dialect);
      const got: string[] = [];
      for (let i = 0; i < script.length; i += size)
        got.push(...splitter.push(script.slice(i, i + size)));
      got.push(...splitter.end());
      expect(got, `pieces of ${size}`).toEqual(whole);
    }
  });

  it('hands out complete statements before the end, and waits for an unfinished one', () => {
    const splitter = new ScriptSplitter('mysql');
    expect(splitter.push('INSERT INTO t VALUES (1);\nINSERT INTO t VALUES (')).toEqual([
      'INSERT INTO t VALUES (1)',
    ]);
    expect(splitter.push("'a\n;b');\n")).toEqual(["INSERT INTO t VALUES ('a\n;b')"]);
    expect(splitter.end()).toEqual([]);
  });
});
