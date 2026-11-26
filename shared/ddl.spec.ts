import { describe, expect, it } from 'vitest';
import {
  addColumnSql,
  alterColumnSql,
  createTableSql,
  defaultAsSql,
  dropColumnSql,
  parseIndexes,
} from './ddl';

const c = {
  name: 'x',
  type: 'int',
  nullable: true,
  defaultValue: '',
  autoIncrement: false,
  comment: '',
};

describe('ddl', () => {
  it('reads a MySQL default back as SQL', () => {
    expect(defaultAsSql('Delft', 'mysql')).toBe("'Delft'");
    expect(defaultAsSql("it's", 'mysql')).toBe("'it''s'");
    expect(defaultAsSql('0', 'mysql')).toBe('0');
    expect(defaultAsSql('current_timestamp()', 'mysql')).toBe('current_timestamp()');
    expect(defaultAsSql("'open'::character varying", 'postgres')).toBe("'open'::character varying");
    expect(defaultAsSql(null, 'mysql')).toBe('');
  });
  it('writes column changes per dialect', () => {
    expect(addColumnSql('mssql', 'dbo', 't', { ...c, nullable: false, defaultValue: '0' })).toEqual(
      ['ALTER TABLE [dbo].[t] ADD [x] int NOT NULL DEFAULT 0'],
    );
    expect(
      alterColumnSql('postgres', 'public', 't', c, {
        ...c,
        type: 'bigint',
        nullable: false,
        comment: 'aantal',
      }),
    ).toEqual([
      'ALTER TABLE "public"."t" ALTER COLUMN "x" TYPE bigint USING "x"::bigint',
      'ALTER TABLE "public"."t" ALTER COLUMN "x" SET NOT NULL',
      `COMMENT ON COLUMN "public"."t"."x" IS 'aantal'`,
    ]);
    expect(dropColumnSql('mssql', 'dbo', 't', 'x')[0]).toContain('DROP CONSTRAINT');
    // SQL Server: the default comes off before ALTER COLUMN and goes back on after it.
    const ms = alterColumnSql(
      'mssql',
      'dbo',
      't',
      { ...c, defaultValue: '1' },
      { ...c, type: 'bigint', defaultValue: '1' },
    );
    expect(ms.map((s) => s.split(' ').slice(0, 4).join(' '))).toEqual([
      expect.stringMatching(/^DECLARE/),
      'ALTER TABLE [dbo].[t] ALTER',
      'ALTER TABLE [dbo].[t] ADD',
    ]);
    expect(() => addColumnSql('mysql', 'db', 't', { ...c, type: 'int; DROP TABLE t' })).toThrow(
      /;/,
    );
  });
  it('creates a SQLite table with INTEGER PRIMARY KEY AUTOINCREMENT on the column', () => {
    expect(
      createTableSql('sqlite', 'main', 't', [
        { ...c, name: 'id', type: 'INTEGER', nullable: false, autoIncrement: true, primary: true },
      ])[0],
    ).toBe('CREATE TABLE "main"."t" (\n  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT\n)');
  });
  it('groups index rows, primary first', () => {
    expect(
      parseIndexes([
        ['idx_b', '0', '0', 'b', '1'],
        ['PRIMARY', '1', '1', 'id', '1'],
        ['idx_b', '0', '0', 'c', '2'],
      ]),
    ).toEqual([
      { name: 'PRIMARY', columns: ['id'], unique: true, primary: true },
      { name: 'idx_b', columns: ['b', 'c'], unique: false, primary: false },
    ]);
  });
});
