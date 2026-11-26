import { CONTRAST_PAIRS as PAIRS, contrast, LABEL_COLORS, THEMES, TOKENS } from './themes';

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

  // A connection's colour is a dot or bar: it must stand out from the background (3:1, as for
  // graphics), in every theme.
  for (const theme of THEMES) {
    it(`${theme.name} shows every connection colour`, () => {
      const labels = LABEL_COLORS[theme.dark ? 'dark' : 'light'];
      const failures = Object.entries(labels)
        .filter(([, c]) => contrast(c, theme.colors.panel) < 3)
        .map(([n, c]) => `${n} op panel: ${contrast(c, theme.colors.panel).toFixed(2)}`);
      expect(failures).toEqual([]);
    });
  }
});
