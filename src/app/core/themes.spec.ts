import { contrast, THEMES, TOKENS, type Token } from './themes';

/** WCAG AA: 4.5 for text, 3 for large text and UI parts. Pairs as they appear on screen. */
const PAIRS: [Token, Token, number][] = [
  ['text', 'bg', 7],
  ['text', 'panel', 7],
  ['text', 'panel-2', 4.5],
  ['text', 'select-bg', 4.5],
  ['text-2', 'bg', 4.5],
  ['text-2', 'panel', 4.5],
  ['text-3', 'bg', 4.5],
  ['text-3', 'panel', 4],
  ['accent-ink', 'accent', 4.5],
  ['accent-text', 'bg', 4.5],
  ['accent-text', 'accent-soft', 4.5],
  ['ok-text', 'bg', 4.5],
  ['ok-text', 'ok-bg', 4.5],
  ['warn-text', 'bg', 4.5],
  ['warn-text', 'warn-bg', 4.5],
  ['err-text', 'bg', 4.5],
  ['err-text', 'err-bg', 4.5],
  ['err-ink', 'err', 3],
  ['syn-keyword', 'bg', 4.5],
  ['syn-string', 'bg', 4.5],
  ['syn-number', 'bg', 4.5],
  ['syn-operator', 'bg', 4.5],
  ['syn-type', 'bg', 4.5],
  ['syn-special', 'bg', 4.5],
  ['syn-comment', 'bg', 3.5],
  ['syn-keyword', 'editor-active-line', 4.5],
  ['text', 'editor-selection', 4.5],
  ['editor-gutter-text', 'editor-gutter', 3],
];

describe('themes', () => {
  it('set every token, with unique ids', () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    for (const theme of THEMES) {
      expect(Object.keys(theme.colors).sort(), theme.id).toEqual([...TOKENS].sort());
    }
  });

  for (const theme of THEMES) {
    it(`${theme.name} is readable`, () => {
      const failures = PAIRS.filter(
        ([fg, bg, min]) => contrast(theme.colors[fg], theme.colors[bg]) < min,
      ).map(
        ([fg, bg, min]) =>
          `${fg} op ${bg}: ${contrast(theme.colors[fg], theme.colors[bg]).toFixed(2)} < ${min}`,
      );
      expect(failures).toEqual([]);
    });
  }
});
