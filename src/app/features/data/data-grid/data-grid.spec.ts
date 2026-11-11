import { copyText, viewOf } from './data-grid';

describe('cell display', () => {
  it('shows NULL, empty text, binary and long text distinctly', () => {
    expect(viewOf(null)).toMatchObject({ text: 'NULL', cls: 'is-null' });
    expect(viewOf('')).toMatchObject({ text: "''", cls: 'is-empty' });
    expect(viewOf('abc')).toMatchObject({ text: 'abc', cls: '' });
    expect(viewOf({ kind: 'binary', bytes: 4, hex: 'deadbeef' })).toMatchObject({
      text: '0xDEADBEEF',
      cls: 'is-binary',
      title: 'Binair, 4 bytes',
    });
    expect(viewOf({ kind: 'binary', bytes: 100, hex: 'ab'.repeat(32) }).text.endsWith('…')).toBe(
      true,
    );
    expect(viewOf({ kind: 'truncated', text: 'xx', length: 5000 })).toMatchObject({
      cls: 'is-truncated',
      title: 'Lange tekst: 5.000 tekens, eerste 2 getoond',
    });
  });

  it('copies values the way they would be typed in SQL', () => {
    expect(copyText(null)).toBe('NULL');
    expect(copyText('a b')).toBe('a b');
    expect(copyText({ kind: 'binary', bytes: 2, hex: 'beef' })).toBe('0xBEEF');
    expect(copyText({ kind: 'truncated', text: 'start', length: 9000 })).toBe('start');
  });
});
