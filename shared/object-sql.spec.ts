import { describe, expect, it } from 'vitest';
import type { ColumnInfo, RoutineParam } from './models';
import {
  actionSql,
  actionStatements,
  callTemplate,
  canCreateContainer,
  canDropContainer,
  forceOption,
  insertTemplate,
  selectSql,
} from './object-sql';

const col = (name: string, type: string, extra = ''): ColumnInfo => ({
  name,
  type,
  nullable: true,
  key: null,
  defaultValue: null,
  extra,
  comment: '',
});

describe('actionSql', () => {
  it('empties a table, with DELETE on SQLite', () => {
    const a = { action: 'truncate', database: 'shop', name: 'or`ders' } as const;
    expect(actionSql('mysql', a)).toBe('TRUNCATE TABLE `shop`.`or``ders`');
    expect(actionSql('postgres', a)).toBe('TRUNCATE TABLE "shop"."or`ders"');
    expect(actionSql('mssql', a)).toBe('TRUNCATE TABLE [shop].[or`ders]');
    expect(actionSql('sqlite', a)).toBe('DELETE FROM "shop"."or`ders"');
  });

  it('drops each kind of object', () => {
    expect(actionSql('mysql', { action: 'drop', database: 'd', kind: 'view', name: 'v' })).toBe(
      'DROP VIEW `d`.`v`',
    );
    expect(
      actionSql('mssql', { action: 'drop', database: 'dbo', kind: 'procedure', name: 'p]' }),
    ).toBe('DROP PROCEDURE [dbo].[p]]]');
    expect(
      actionSql('postgres', { action: 'drop', database: 's', kind: 'function', name: 'f' }),
    ).toBe('DROP FUNCTION "s"."f"');
  });

  it('drops a MySQL database or a PostgreSQL schema, nothing else', () => {
    expect(actionSql('mysql', { action: 'drop-container', database: 'oud' })).toBe(
      'DROP DATABASE `oud`',
    );
    expect(actionSql('postgres', { action: 'drop-container', database: 'oud' })).toBe(
      'DROP SCHEMA "oud" CASCADE',
    );
    expect(canDropContainer('mssql')).toBe(false);
    expect(canDropContainer('sqlite')).toBe(false);
    expect(() => actionSql('sqlite', { action: 'drop-container', database: 'main' })).toThrow();
  });
});

describe('past foreign keys', () => {
  const truncate = { action: 'truncate', database: 'shop', name: 'articles', force: true } as const;
  const drop = {
    action: 'drop',
    database: 'shop',
    kind: 'table',
    name: 'articles',
    force: true,
  } as const;

  it('turns the checks off around the statement in MySQL', () => {
    expect(actionStatements('mysql', truncate)).toEqual([
      'SET FOREIGN_KEY_CHECKS = 0',
      'TRUNCATE TABLE `shop`.`articles`',
      'SET FOREIGN_KEY_CHECKS = 1',
    ]);
    expect(actionSql('mysql', drop)).toBe(
      'SET FOREIGN_KEY_CHECKS = 0;\nDROP TABLE `shop`.`articles`;\nSET FOREIGN_KEY_CHECKS = 1;',
    );
    expect(actionSql('mysql', { ...drop, force: false })).toBe('DROP TABLE `shop`.`articles`');
    expect(forceOption('mysql', drop)?.label).toBe('Foreign key checks uitzetten');
  });

  it('uses CASCADE in PostgreSQL and says what that does', () => {
    expect(actionSql('postgres', truncate)).toBe('TRUNCATE TABLE "shop"."articles" CASCADE');
    expect(actionSql('postgres', drop)).toBe('DROP TABLE "shop"."articles" CASCADE');
    expect(forceOption('postgres', truncate)?.label).toMatch(/leegmaken \(CASCADE\)/);
    expect(
      forceOption('postgres', { action: 'drop', database: 's', kind: 'function', name: 'f' }),
    ).toBeNull();
  });

  it('offers nothing where it does not apply', () => {
    expect(forceOption('sqlite', truncate)).toBeNull();
    expect(forceOption('mssql', drop)).toBeNull();
    expect(actionSql('mssql', truncate)).toBe('TRUNCATE TABLE [shop].[articles]');
  });
});

describe('create a database', () => {
  it('makes a database in MySQL and a schema elsewhere', () => {
    const create = { action: 'create-container', database: 'nieuw`e' } as const;
    expect(actionSql('mysql', create)).toBe('CREATE DATABASE `nieuw``e`');
    expect(actionSql('postgres', create)).toBe('CREATE SCHEMA "nieuw`e"');
    expect(actionSql('mssql', create)).toBe('CREATE SCHEMA [nieuw`e]');
    expect(canCreateContainer('sqlite')).toBe(false);
    expect(() => actionSql('sqlite', create)).toThrow();
  });
});

describe('templates', () => {
  it('selects the first 1000 rows', () => {
    expect(selectSql('mysql', 'shop', 'orders')).toBe(
      'SELECT *\nFROM `shop`.`orders`\nLIMIT 1000;',
    );
    expect(selectSql('mssql', 'dbo', 'orders')).toBe('SELECT TOP (1000) *\nFROM [dbo].[orders];');
  });

  it('inserts every column except those the server fills', () => {
    const sql = insertTemplate('mysql', 'shop', 'orders', [
      col('id', 'int', 'auto_increment'),
      col('email', 'varchar(255)'),
      col('total', 'decimal(10,2)'),
      col('full', 'varchar(9)', 'VIRTUAL GENERATED'),
    ]);
    expect(sql).toBe(
      'INSERT INTO `shop`.`orders` (\n  `email`,\n  `total`\n) VALUES (\n' +
        '  NULL, -- email varchar(255)\n  NULL -- total decimal(10,2)\n);',
    );
    expect(insertTemplate('postgres', 's', 't', [col('id', 'integer', 'identity')])).toBe(
      'INSERT INTO "s"."t" DEFAULT VALUES;',
    );
  });

  it('keeps odd names from breaking out of a comment', () => {
    const sql = insertTemplate('mysql', 'd', 't', [col('a\n*/x', 'int')]);
    // The quoted name may hold a line break; the comment after the value may not.
    expect(sql).toContain('  NULL -- a  x int\n);');
  });

  const params: RoutineParam[] = [
    { name: 'klant', mode: 'in', type: 'int' },
    { name: 'totaal', mode: 'out', type: 'decimal(10,2)' },
  ];

  it('calls a MySQL procedure with a variable for OUT parameters', () => {
    expect(callTemplate('mysql', 'shop', 'procedure', 'stats', params)).toBe(
      'CALL `shop`.`stats`(\n  NULL, -- klant int\n  @totaal -- totaal OUT decimal(10,2)\n);\n' +
        'SELECT @totaal;',
    );
    expect(callTemplate('mysql', 'shop', 'function', 'f', [])).toBe('SELECT `shop`.`f`();');
  });

  it('calls a PostgreSQL function without its OUT parameters', () => {
    expect(callTemplate('postgres', 'public', 'function', 'stats', params)).toBe(
      'SELECT * FROM "public"."stats"(\n  NULL -- klant int\n);',
    );
    expect(callTemplate('postgres', 'public', 'procedure', 'p', params)).toContain(
      'NULL -- totaal OUT decimal(10,2)',
    );
  });

  it('executes a SQL Server procedure with declared OUTPUT variables', () => {
    expect(
      callTemplate('mssql', 'dbo', 'procedure', 'stats', [
        { name: 'klant', mode: 'in', type: 'int' },
        { name: 'totaal', mode: 'inout', type: 'decimal' },
      ]),
    ).toBe(
      'DECLARE @totaal decimal;\nEXEC [dbo].[stats]\n  @klant = NULL, -- int\n' +
        '  @totaal = @totaal OUTPUT -- decimal;\nSELECT @totaal AS [totaal];',
    );
  });
});
