import { describe, expect, it } from 'vitest';
import { buildCount, buildSelect, MAX_TEXT_LENGTH, quoteIdent, toCell } from './mysql.data';

describe('quoteIdent', () => {
  it('wraps in backticks and doubles backticks inside', () => {
    expect(quoteIdent('orders')).toBe('`orders`');
    expect(quoteIdent('Order Items')).toBe('`Order Items`');
    expect(quoteIdent('we`ird')).toBe('`we``ird`');
    expect(quoteIdent('x`; DROP TABLE y; --')).toBe('`x``; DROP TABLE y; --`');
  });
});

describe('buildSelect', () => {
  it('builds a plain paged select', () => {
    expect(buildSelect('app', 'orders', { offset: 0, limit: 100, orderBy: [] })).toBe(
      'SELECT * FROM `app`.`orders` LIMIT 101 OFFSET 0',
    );
  });

  it('adds sort keys in order', () => {
    const sql = buildSelect('app', 'orders', {
      offset: 0,
      limit: 100,
      orderBy: [
        { column: 'created_at', direction: 'desc' },
        { column: 'id', direction: 'asc' },
      ],
    });
    expect(sql).toBe(
      'SELECT * FROM `app`.`orders` ORDER BY `created_at` DESC, `id` ASC LIMIT 101 OFFSET 0',
    );
  });

  it('puts the filter on its own lines so a comment cannot remove LIMIT', () => {
    const sql = buildSelect('app', 'orders', {
      offset: 0,
      limit: 100,
      orderBy: [],
      where: "status = 'paid') -- ",
    });
    expect(sql).toBe(
      "SELECT * FROM `app`.`orders` WHERE (\nstatus = 'paid') --\n) LIMIT 101 OFFSET 0",
    );
    // The comment ends at the newline: the closing parenthesis and LIMIT stay in force.
    expect(sql.split('\n').at(-1)).toBe(') LIMIT 101 OFFSET 0');
  });

  it('ignores an empty or blank filter', () => {
    const base = { offset: 0, limit: 1, orderBy: [] };
    expect(buildSelect('a', 'b', { ...base, where: '   ' })).not.toContain('WHERE');
  });

  it('builds a count with the same filter', () => {
    expect(buildCount('app', 'orders', 'id > 5')).toBe(
      'SELECT COUNT(*) AS n FROM `app`.`orders` WHERE (\nid > 5\n)',
    );
  });
});

describe('toCell', () => {
  it('keeps null and text, turns numbers into text', () => {
    expect(toCell(null)).toBeNull();
    expect(toCell(undefined)).toBeNull();
    expect(toCell('abc')).toBe('abc');
    expect(toCell(42)).toBe('42');
    expect(toCell(1n)).toBe('1');
  });

  it('summarises binary values', () => {
    expect(toCell(Buffer.from('deadbeef', 'hex'))).toEqual({
      kind: 'binary',
      bytes: 4,
      hex: 'deadbeef',
    });
    const big = toCell(Buffer.alloc(100, 0xab));
    expect(big).toMatchObject({ kind: 'binary', bytes: 100 });
    expect((big as { hex: string }).hex).toHaveLength(64);
  });

  it('cuts long text and reports the full length', () => {
    const cell = toCell('y'.repeat(MAX_TEXT_LENGTH + 10));
    expect(cell).toEqual({
      kind: 'truncated',
      text: 'y'.repeat(MAX_TEXT_LENGTH),
      length: MAX_TEXT_LENGTH + 10,
    });
  });

  it('serialises objects such as spatial values', () => {
    expect(toCell({ x: 1, y: 2 })).toBe('{"x":1,"y":2}');
  });
});
