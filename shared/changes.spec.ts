import { describe, expect, it } from 'vitest';
import { changeStatements, inlineParams, quoteIdent, type ChangeSet } from './changes';

const base: ChangeSet = { primaryKey: ['id'], deletes: [], updates: [], inserts: [] };

describe('changeStatements', () => {
  it('orders deletes, updates, inserts and limits each to one row', () => {
    const statements = changeStatements('app', 'orders', {
      ...base,
      inserts: [{ values: { status: 'new', note: null } }],
      updates: [{ key: { id: '2' }, values: { status: 'paid' } }],
      deletes: [{ key: { id: '3' } }],
    });
    expect(statements.map((s) => [s.kind, s.sql, s.params])).toEqual([
      ['delete', 'DELETE FROM `app`.`orders` WHERE `id` = ? LIMIT 1', ['3']],
      ['update', 'UPDATE `app`.`orders` SET `status` = ? WHERE `id` = ? LIMIT 1', ['paid', '2']],
      ['insert', 'INSERT INTO `app`.`orders` (`status`, `note`) VALUES (?, ?)', ['new', null]],
    ]);
  });

  it('handles composite keys and an insert of only defaults', () => {
    const statements = changeStatements('app', 'line', {
      primaryKey: ['order_id', 'line_no'],
      deletes: [{ key: { order_id: '7', line_no: '1' } }],
      updates: [],
      inserts: [{ values: {} }],
    });
    expect(statements[0]?.sql).toBe(
      'DELETE FROM `app`.`line` WHERE `order_id` = ? AND `line_no` = ? LIMIT 1',
    );
    expect(statements[0]?.params).toEqual(['7', '1']);
    expect(statements[1]?.sql).toBe('INSERT INTO `app`.`line` () VALUES ()');
  });

  it('skips updates without changed columns', () => {
    expect(
      changeStatements('a', 'b', { ...base, updates: [{ key: { id: '1' }, values: {} }] }),
    ).toEqual([]);
  });

  it('quotes awkward names', () => {
    const [s] = changeStatements('a', 'we`ird', {
      ...base,
      updates: [{ key: { id: '1' }, values: { 'Unit Price': '2' } }],
    });
    expect(s?.sql).toBe('UPDATE `a`.`we``ird` SET `Unit Price` = ? WHERE `id` = ? LIMIT 1');
    expect(quoteIdent('x`y')).toBe('`x``y`');
  });
});

describe('inlineParams', () => {
  it('fills in quoted literals and NULL', () => {
    expect(inlineParams('UPDATE t SET a = ?, b = ? WHERE id = ?', ["it's", null, '5'])).toBe(
      "UPDATE t SET a = 'it''s', b = NULL WHERE id = '5'",
    );
  });

  it('leaves question marks inside identifiers alone', () => {
    expect(inlineParams('UPDATE `what?` SET `a?` = ? WHERE `id` = ?', ['x', '1'])).toBe(
      "UPDATE `what?` SET `a?` = 'x' WHERE `id` = '1'",
    );
  });

  it('escapes backslashes', () => {
    expect(inlineParams('SELECT ?', ['C:\\temp'])).toBe("SELECT 'C:\\\\temp'");
  });
});

describe('changeStatements per dialect', () => {
  const cs: ChangeSet = {
    primaryKey: ['id'],
    deletes: [{ key: { id: '1' } }],
    updates: [{ key: { id: '2' }, values: { name: "it's", note: null } }],
    inserts: [{ values: {} }, { values: { name: 'x' } }],
  };

  it('PostgreSQL: double quotes, $n placeholders, no LIMIT, DEFAULT VALUES', () => {
    const s = changeStatements('public', 'my"t', cs, 'postgres');
    expect(s.map((x) => x.sql)).toEqual([
      'DELETE FROM "public"."my""t" WHERE "id" = $1',
      'UPDATE "public"."my""t" SET "name" = $1, "note" = $2 WHERE "id" = $3',
      'INSERT INTO "public"."my""t" DEFAULT VALUES',
      'INSERT INTO "public"."my""t" ("name") VALUES ($1)',
    ]);
    expect(s[1]!.params).toEqual(["it's", null, '2']);
    expect(s[1]!.preview).toBe(
      'UPDATE "public"."my""t" SET "name" = \'it\'\'s\', "note" = NULL WHERE "id" = \'2\'',
    );
  });

  it('SQL Server: brackets, @p placeholders and N-strings in the preview', () => {
    const s = changeStatements('dbo', 'a]b', cs, 'mssql');
    expect(s[1]!.sql).toBe('UPDATE [dbo].[a]]b] SET [name] = @p1, [note] = @p2 WHERE [id] = @p3');
    expect(s[0]!.preview).toBe("DELETE FROM [dbo].[a]]b] WHERE [id] = N'1'");
  });

  it('SQLite: ? placeholders without LIMIT; backslashes stay as they are', () => {
    const s = changeStatements(
      'main',
      't',
      { ...cs, updates: [{ key: { id: '2' }, values: { p: 'C:\\x' } }] },
      'sqlite',
    );
    expect(s[1]!.sql).toBe('UPDATE "main"."t" SET "p" = ? WHERE "id" = ?');
    expect(s[1]!.preview).toBe('UPDATE "main"."t" SET "p" = \'C:\\x\' WHERE "id" = \'2\'');
  });

  it('MySQL preview matches inlineParams', () => {
    for (const s of changeStatements('app', 'what?', cs)) {
      expect(s.preview).toBe(inlineParams(s.sql, s.params));
    }
  });

  it('writes SQL values as they are and numbers the parameters around them', () => {
    const cs: ChangeSet = {
      primaryKey: ['id'],
      deletes: [],
      updates: [
        { key: { id: '7' }, values: { seen: { sql: 'NOW()' }, naam: 'x', n: { sql: 'DEFAULT' } } },
      ],
      inserts: [{ values: { logo: { sql: "X'89504E47'", label: 'logo.png' }, naam: null } }],
    };
    const [update, insert] = changeStatements('app', 't', cs, 'postgres');
    expect(update!.sql).toBe(
      'UPDATE "app"."t" SET "seen" = NOW(), "naam" = $1, "n" = DEFAULT WHERE "id" = $2',
    );
    expect(update!.params).toEqual(['x', '7']);
    expect(update!.preview).toBe(
      `UPDATE "app"."t" SET "seen" = NOW(), "naam" = 'x', "n" = DEFAULT WHERE "id" = '7'`,
    );
    expect(insert!.sql).toBe(`INSERT INTO "app"."t" ("logo", "naam") VALUES (X'89504E47', $1)`);
    expect(insert!.params).toEqual([null]);
  });
});
