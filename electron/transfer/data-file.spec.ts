import { mkdtempSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CsvParser,
  detectDelimiter,
  detectEncoding,
  excelDate,
  parseDateStyles,
  parseJsonRecords,
  parseSharedStrings,
  previewDataFile,
  sheetRows,
} from './data-file';

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-datafile-'));
afterAll(() => fs.rm(dir, { recursive: true, force: true }));
const write = async (name: string, content: string | Buffer) => {
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return file;
};

describe('CsvParser', () => {
  it('handles quotes, doubled quotes and line breaks in fields, across chunks', () => {
    const p = new CsvParser(',');
    const text = 'a,"b ""c""",d\r\n"x\r\ny",,z\n';
    const rows = [...text].flatMap((ch) => p.push(ch));
    rows.push(...p.end());
    expect(rows).toEqual([
      ['a', 'b "c"', 'd'],
      ['x\r\ny', '', 'z'],
    ]);
  });
  it('skips empty lines and reads a last line without a line end', () => {
    const p = new CsvParser(';');
    expect([...p.push('1;2\n\n3;4'), ...p.end()]).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });
});

describe('detection', () => {
  it('finds the delimiter that splits lines evenly', () => {
    expect(detectDelimiter('a;b;c\n1;2,5;3\n4;5;6\n')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2\n')).toBe('\t');
    expect(detectDelimiter('"a,b";c\n"x,y";z\n')).toBe(';');
    expect(detectDelimiter('enkel\n')).toBe(',');
  });
  it('tells UTF-8 from Windows-1252', () => {
    expect(detectEncoding(Buffer.from('café', 'utf8'))).toBe('utf-8');
    expect(detectEncoding(Buffer.from('café;x', 'latin1'))).toBe('windows-1252');
    expect(detectEncoding(Buffer.from([0xff, 0xfe, 0x61, 0]))).toBe('utf-16le');
  });
});

describe('previewDataFile', () => {
  it('reads a CSV with header, also gzipped', async () => {
    const csv = 'id;naam\n1;één\n2;"twee; drie"\n';
    for (const file of [await write('a.csv', csv), await write('a.csv.gz', gzipSync(csv))]) {
      expect(await previewDataFile({ file })).toEqual({
        format: 'csv',
        columns: ['id', 'naam'],
        rows: [
          ['1', 'één'],
          ['2', 'twee; drie'],
        ],
        delimiter: ';',
        encoding: 'utf-8',
      });
    }
  });
  it('names columns itself without a header, and pads short rows', async () => {
    const file = await write('b.csv', 'x,y,z\n1\n');
    const p = await previewDataFile({ file, header: false });
    expect(p.columns).toEqual(['Kolom 1', 'Kolom 2', 'Kolom 3']);
    expect(p.rows).toEqual([
      ['x', 'y', 'z'],
      ['1', null, null],
    ]);
  });
  it('gives duplicate header names a number', async () => {
    const file = await write('c.csv', 'a,a,\n1,2,3\n');
    expect((await previewDataFile({ file })).columns).toEqual(['a', 'a (2)', 'Kolom 3']);
  });
  it('reads JSON: all keys, nested values as JSON', async () => {
    const file = await write('d.json', '[{"a":1,"b":{"c":true}},{"a":2,"d":null,"e":"x"}]');
    expect(await previewDataFile({ file })).toEqual({
      format: 'json',
      columns: ['a', 'b', 'd', 'e'],
      rows: [
        ['1', '{"c":true}', null, null],
        ['2', null, null, 'x'],
      ],
      rowCount: 2,
    });
  });
  it('reads Excel: shared and rich strings, dates, times, numbers, sheets', async () => {
    const file = path.join(__dirname, 'fixtures', 'sample.xlsx');
    const p = await previewDataFile({ file });
    expect(p.sheets).toEqual(['Klanten', 'Producten']);
    expect(p.columns).toEqual(['id', 'naam', 'geboren', 'tijdstip', 'saldo', 'actief', 'notitie']);
    expect(p.rows[0]).toEqual([
      '1',
      'Anna & Bob',
      '1990-05-17',
      '2024-03-01 13:45:00',
      '12.5',
      'true',
      null,
    ]);
    expect(p.rows[1]?.[4]).toBe('0.3');
    expect(p.rows[2]?.[1]).toBe('Vet en gewoon');
    expect(p.rows[4]?.[3]).toBe('08:30:00');
    expect((await previewDataFile({ file, sheet: 'Producten' })).rows).toEqual([['P1', '9.99']]);
  });
  it('refuses what it can not read', async () => {
    await expect(previewDataFile({ file: await write('e.json', '{"a":') })).rejects.toThrow(
      /geen geldige JSON/,
    );
    await expect(previewDataFile({ file: await write('f.xlsx', 'geen zip') })).rejects.toThrow(
      /geen leesbaar Excel/,
    );
    await expect(previewDataFile({ file: await write('g.pdf', 'x') })).rejects.toThrow(
      /geen CSV-, JSON- of Excel/,
    );
  });
});

describe('JSON shapes', () => {
  it('takes an object holding one array, and JSON Lines', () => {
    expect(parseJsonRecords('{"data":[{"a":1}],"meta":1}')).toEqual([{ a: 1 }]);
    expect(parseJsonRecords('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(() => parseJsonRecords('[1,2]')).toThrow(/is een object/);
  });
});

describe('Excel parts', () => {
  it('converts serial numbers to dates and times', () => {
    expect(excelDate(45352, 'date')).toBe('2024-03-01');
    expect(excelDate(45352.5729166667, 'datetime')).toBe('2024-03-01 13:45:00');
    expect(excelDate(0.25, 'time')).toBe('06:00:00');
    expect(excelDate(0, 'date', true)).toBe('1904-01-01');
  });
  it('finds date styles, built in and custom', () => {
    const styles = parseDateStyles(
      '<numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/><numFmt numFmtId="165" formatCode="&quot;€&quot; #,##0.00"/></numFmts>' +
        '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs>',
    );
    expect(styles).toEqual([null, 'date', 'datetime', null]);
  });
  it('streams rows, also when a row is cut across chunks', async () => {
    const strings = parseSharedStrings(
      '<sst><si><t>a &amp; b</t></si><si><r><t>x</t></r><r><t>y</t></r></si></sst>',
    );
    const xml =
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
      '<row r="2"/><row r="3"><c r="B3" t="inlineStr"><is><t>in_x000D_line</t></is></c><c r="C3" t="b"><v>0</v></c></row></sheetData></worksheet>';
    const chunks = xml.match(/.{1,7}/gs)!;
    const rows = [];
    for await (const r of sheetRows(chunks, strings, [])) rows.push(r);
    expect(rows).toEqual([
      ['a & b', null, 'xy'],
      [null, 'in\rline', false],
    ]);
  });
});
