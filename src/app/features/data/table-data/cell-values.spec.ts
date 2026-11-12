import { parseTsv } from '../data-grid/data-grid';
import {
  base64Bytes,
  binaryValue,
  bytesBase64,
  dateValues,
  guidValues,
  isBinaryType,
  utf8Text,
} from './cell-values';

describe('insert values', () => {
  it('gives the date and time like HeidiSQL, local and UTC', () => {
    const now = new Date(Date.UTC(2026, 10, 12, 16, 19, 14));
    const { local, utc } = dateValues(now);
    const offset = -now.getTimezoneOffset();
    expect(utc.map((v) => v.make())).toEqual(['2026-11-12 16:19:14', '2026-11-12', '16:19:14']);
    expect(local[4]!.make()).toBe(String(now.getTime() / 1000));
    expect(local[3]!.make()).toBe('2026');
    if (offset === 0) expect(local[0]!.make()).toBe('2026-11-12 16:19:14');
    expect(local[0]!.label).toMatch(/^Datum en tijd: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });

  it('makes a new GUID per cell in four forms', () => {
    const [braces, plain, lower, lowerPlain] = guidValues('d9479124-1565-4a27-8694-dc8a3e7e5df2');
    expect(braces!.label).toBe('GUID: {D9479124-1565-4A27-8694-DC8A3E7E5DF2}');
    expect(lowerPlain!.label).toBe(
      'GUID kleine letters zonder accolades: d9479124-1565-4a27-8694-dc8a3e7e5df2',
    );
    expect(plain!.make()).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    expect(lower!.make()).toMatch(/^\{[0-9a-f-]{36}\}$/);
    expect(plain!.make()).not.toBe(plain!.make());
  });

  it('turns a file into a binary literal per dialect', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(binaryValue(bytes, 'logo.png', 'mysql')).toEqual({
      sql: "X'89504E47'",
      label: 'logo.png (4 B)',
    });
    expect(binaryValue(bytes, 'a', 'postgres').sql).toBe("'\\x89504E47'::bytea");
    expect(binaryValue(bytes, 'a', 'mssql').sql).toBe('0x89504E47');
    expect(binaryValue(new Uint8Array(), 'a', 'mssql').sql).toBe('0x');
    expect(isBinaryType('longblob')).toBe(true);
    expect(isBinaryType('varbinary(16)')).toBe(true);
    expect(isBinaryType('text')).toBe(false);
  });

  it('reads text files as UTF-8 and refuses other bytes', () => {
    expect(utf8Text(new TextEncoder().encode('één'))).toBe('één');
    expect(utf8Text(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
    const big = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(base64Bytes(bytesBase64(big))).toEqual(big);
  });
});

describe('paste', () => {
  it('reads what Excel puts on the clipboard', () => {
    expect(parseTsv('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseTsv('"met\ttab"\t"twee\nregels"\t"""quote"""')).toEqual([
      ['met\ttab', 'twee\nregels', '"quote"'],
    ]);
    expect(parseTsv('één')).toEqual([['één']]);
    expect(parseTsv('a\t\tc')).toEqual([['a', '', 'c']]);
    expect(parseTsv('')).toEqual([]);
  });
});
