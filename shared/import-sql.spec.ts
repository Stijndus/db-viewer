import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from './models';
import { autoMap, importLiteral, insertRowsSql, isTextColumn } from './import-sql';

const col = (type: string): ColumnInfo => ({
  name: 'c',
  type,
  nullable: true,
  key: null,
  defaultValue: null,
  extra: '',
  comment: '',
});

describe('importLiteral', () => {
  it('quotes every value, also numbers', () => {
    expect(importLiteral(12, col('int'), 'mysql', false)).toBe("'12'");
    expect(importLiteral("it's", col('varchar(5)'), 'mssql', false)).toBe("N'it''s'");
    expect(importLiteral('a\\b', col('text'), 'mysql', false)).toBe("'a\\\\b'");
  });
  it('makes empty fields NULL where "" is no value', () => {
    expect(importLiteral('', col('int'), 'mysql', false)).toBe('NULL');
    expect(importLiteral('', col('date'), 'postgres', false)).toBe('NULL');
    expect(importLiteral('', col('varchar(10)'), 'mysql', false)).toBe("''");
    expect(importLiteral('', col('varchar(10)'), 'mysql', true)).toBe('NULL');
    expect(importLiteral(null, col('text'), 'sqlite', false)).toBe('NULL');
  });
  it('writes booleans as the column wants them', () => {
    expect(importLiteral(true, col('boolean'), 'postgres', false)).toBe("'true'");
    expect(importLiteral(true, col('tinyint(1)'), 'mysql', false)).toBe("'1'");
    expect(importLiteral(false, col('bit'), 'mssql', false)).toBe("N'0'");
  });
  it('knows text columns', () => {
    expect(isTextColumn("enum('a','b')")).toBe(true);
    expect(isTextColumn('character varying(20)')).toBe(true);
    expect(isTextColumn('decimal(10,2)')).toBe(false);
  });
});

describe('insertRowsSql', () => {
  const rows = [
    ["'1'", "'a'"],
    ["'2'", 'NULL'],
  ];
  it('appends with one multi-row INSERT', () => {
    expect(insertRowsSql('mysql', 'db', 't', ['id', 'naam'], rows, 'append')).toBe(
      "INSERT INTO `db`.`t` (`id`, `naam`) VALUES\n('1', 'a'),\n('2', NULL)",
    );
  });
  it('upserts in each dialect', () => {
    expect(insertRowsSql('mysql', 'db', 't', ['id', 'naam'], rows, 'upsert', ['id'])).toMatch(
      /ON DUPLICATE KEY UPDATE `naam` = VALUES\(`naam`\)$/,
    );
    expect(insertRowsSql('postgres', 's', 't', ['id', 'naam'], rows, 'upsert', ['id'])).toMatch(
      /ON CONFLICT \("id"\) DO UPDATE SET "naam" = excluded\."naam"$/,
    );
    expect(insertRowsSql('sqlite', 'main', 't', ['id'], [["'1'"]], 'upsert', ['id'])).toMatch(
      /DO NOTHING$/,
    );
    expect(insertRowsSql('mysql', 'db', 't', ['id'], [["'1'"]], 'upsert', ['id'])).toMatch(
      /^INSERT IGNORE INTO/,
    );
    const merge = insertRowsSql('mssql', 'dbo', 't', ['id', 'naam'], rows, 'upsert', ['id']);
    expect(merge).toContain('MERGE INTO [dbo].[t] WITH (HOLDLOCK) AS t');
    expect(merge).toContain('ON t.[id] = s.[id]');
    expect(merge).toContain('WHEN MATCHED THEN UPDATE SET t.[naam] = s.[naam]');
    expect(merge).toMatch(
      /WHEN NOT MATCHED THEN INSERT \(\[id\], \[naam\]\) VALUES \(s\.\[id\], s\.\[naam\]\);$/,
    );
  });
  it('needs the key columns to upsert', () => {
    expect(() => insertRowsSql('mysql', 'db', 't', ['naam'], [["'a'"]], 'upsert', ['id'])).toThrow(
      /sleutelkolom id/,
    );
  });
});

describe('autoMap', () => {
  it('matches exact names first, then loosely', () => {
    expect(autoMap(['Id', 'id', 'First Name', 'onbekend'], ['id', 'first_name', 'ID'])).toEqual([
      'ID',
      'id',
      'first_name',
      null,
    ]);
  });
});
