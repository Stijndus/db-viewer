import { describe, expect, it } from 'vitest';
import { mapColumnRow, mapTableRow, normalizeDefault } from './mysql.metadata';

describe('normalizeDefault', () => {
  it('keeps MySQL values as they are', () => {
    expect(normalizeDefault(null, false)).toBeNull();
    expect(normalizeDefault('abc', false)).toBe('abc');
    expect(normalizeDefault('CURRENT_TIMESTAMP', false)).toBe('CURRENT_TIMESTAMP');
    expect(normalizeDefault('0.00', false)).toBe('0.00');
  });

  it('turns MariaDB quoting into MySQL form', () => {
    expect(normalizeDefault('NULL', true)).toBeNull();
    expect(normalizeDefault(null, true)).toBeNull();
    expect(normalizeDefault("'open'", true)).toBe('open');
    expect(normalizeDefault("'it''s'", true)).toBe("it's");
    expect(normalizeDefault("''", true)).toBe('');
    expect(normalizeDefault('current_timestamp()', true)).toBe('current_timestamp()');
    expect(normalizeDefault('0.00', true)).toBe('0.00');
  });
});

describe('mapTableRow', () => {
  it('maps base tables with a row estimate', () => {
    expect(
      mapTableRow({ name: 'orders', type: 'BASE TABLE', row_estimate: '1200', comment: '' }),
    ).toEqual({
      name: 'orders',
      kind: 'table',
      rowEstimate: 1200,
      comment: '',
    });
  });

  it('maps views and system views without an estimate', () => {
    expect(mapTableRow({ name: 'v', type: 'VIEW', row_estimate: null, comment: 'VIEW' }).kind).toBe(
      'view',
    );
    expect(
      mapTableRow({ name: 'TABLES', type: 'SYSTEM VIEW', row_estimate: '0', comment: '' }),
    ).toMatchObject({
      kind: 'view',
      rowEstimate: null,
    });
  });
});

describe('mapColumnRow', () => {
  it('maps keys, nullability and strips DEFAULT_GENERATED', () => {
    const col = mapColumnRow(
      {
        name: 'created_at',
        type: 'datetime',
        nullable: 'NO',
        col_key: 'MUL',
        default_value: 'CURRENT_TIMESTAMP',
        extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP',
        comment: '',
      },
      false,
    );
    expect(col).toEqual({
      name: 'created_at',
      type: 'datetime',
      nullable: false,
      key: 'index',
      defaultValue: 'CURRENT_TIMESTAMP',
      extra: 'on update CURRENT_TIMESTAMP',
      comment: '',
    });
  });

  it.each([
    ['PRI', 'primary'],
    ['UNI', 'unique'],
    ['MUL', 'index'],
    ['', null],
  ])('maps COLUMN_KEY %s to %s', (raw, key) => {
    expect(mapColumnRow({ name: 'c', type: 'int', nullable: 'YES', col_key: raw }, false).key).toBe(
      key,
    );
  });
});
