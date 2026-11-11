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
