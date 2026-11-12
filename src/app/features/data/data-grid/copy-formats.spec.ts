import { formatBlock, incompleteCount } from './copy-formats';
import { DEFAULT_CELL, type GridCell } from './data-grid';

const columns = [
  { name: 'id', numeric: true },
  { name: 'naam', numeric: false },
  { name: 'bedrag', numeric: true },
];
const rows: GridCell[][] = [
  ['1', 'gewoon', '12.50'],
  ['2', 'tab\there, "quote"', null],
  ['3', 'a|b\nc', '99999999999999999.99'],
];
const opts = { header: true, dialect: 'mysql' as const, table: 'klanten' };

describe('copy formats', () => {
  it('tab-separated like a spreadsheet: quoted where needed, NULL empty, no trailing line', () => {
    expect(formatBlock({ columns, rows }, 'tsv', opts)).toBe(
      'id\tnaam\tbedrag\r\n1\tgewoon\t12.50\r\n2\t"tab\there, ""quote"""\t\r\n3\t"a|b\nc"\t99999999999999999.99',
    );
    expect(formatBlock({ columns, rows: [rows[0]!] }, 'tsv', { ...opts, header: false })).toBe(
      '1\tgewoon\t12.50',
    );
  });

  it('CSV with an empty string quoted and NULL empty', () => {
    expect(formatBlock({ columns, rows: [['1', '', null]] }, 'csv', opts)).toBe(
      'id,naam,bedrag\r\n1,"",\r\n',
    );
  });

  it('JSON keeps exact decimals as text and makes safe numbers numbers', () => {
    expect(JSON.parse(formatBlock({ columns, rows }, 'json', opts))).toEqual([
      { id: 1, naam: 'gewoon', bedrag: 12.5 },
      { id: 2, naam: 'tab\there, "quote"', bedrag: null },
      { id: 3, naam: 'a|b\nc', bedrag: '99999999999999999.99' },
    ]);
  });

  it('SQL INSERT in the dialect: numbers bare, text quoted, binary as a hex literal', () => {
    expect(formatBlock({ columns, rows: [rows[0]!, rows[1]!] }, 'sql', opts)).toBe(
      'INSERT INTO `klanten` (`id`, `naam`, `bedrag`) VALUES\n' +
        "(1, 'gewoon', 12.50),\n(2, 'tab\there, \"quote\"', NULL);",
    );
    const bin: GridCell[][] = [[{ kind: 'binary', bytes: 2, hex: 'dead' }, '0x12', DEFAULT_CELL]];
    expect(formatBlock({ columns, rows: bin }, 'sql', { ...opts, dialect: 'mssql' })).toBe(
      "INSERT INTO [klanten] ([id], [naam], [bedrag]) VALUES\n(0xDEAD, N'0x12', DEFAULT);",
    );
  });

  it('Markdown with pipes escaped, line breaks as <br> and NULL in italics', () => {
    expect(formatBlock({ columns, rows }, 'markdown', opts).split('\n')).toEqual([
      '| id | naam | bedrag |',
      '| --- | --- | --- |',
      '| 1 | gewoon | 12.50 |',
      '| 2 | tab\there, "quote" | *NULL* |',
      '| 3 | a\\|b<br>c | 99999999999999999.99 |',
      '',
    ]);
  });

  it('counts values the grid only shows in part', () => {
    expect(
      incompleteCount([
        [
          { kind: 'truncated', text: 'abc', length: 9000 },
          { kind: 'binary', bytes: 64, hex: 'ab' },
        ],
        [{ kind: 'binary', bytes: 1, hex: 'ab' }, 'x'],
      ]),
    ).toBe(2);
  });
});
