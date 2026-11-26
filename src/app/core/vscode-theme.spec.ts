import { CONTRAST_PAIRS, contrast, TOKENS } from './themes';
import { ensureContrast, importVsCodeTheme, parseJsonc } from './vscode-theme';

const dark = `{
  // A dark theme, written the way VS Code themes are: comments and trailing commas.
  "name": "Nachtblauw",
  "type": "dark",
  "colors": {
    "editor.background": "#1b2130",
    "editor.foreground": "#c8d0e0",
    "sideBar.background": "#161b27",
    "button.background": "#2f66c4",
    "button.foreground": "#ffffff",
    "editor.selectionBackground": "#3d7be055", /* with alpha */
    "editorLineNumber.foreground": "#4a5468",
    "list.hoverBackground": "#ffffff10",
  },
  "tokenColors": [
    { "scope": "comment", "settings": { "foreground": "#4a5468", "fontStyle": "italic" } },
    { "scope": ["keyword", "storage"], "settings": { "foreground": "#c792ea" } },
    { "scope": "keyword.operator", "settings": { "foreground": "#89ddff" } },
    { "scope": "string", "settings": { "foreground": "#a5d68a" } },
    { "scope": "constant.numeric, constant.language", "settings": { "foreground": "#f78c6c" } },
    { "scope": "meta.block keyword", "settings": { "foreground": "#ff0000" } },
  ],
}`;

describe('importVsCodeTheme', () => {
  it('reads JSON with comments and trailing commas', () => {
    expect(parseJsonc('{ "a": "// geen commentaar", /* weg */ "b": [1,], }')).toEqual({
      a: '// geen commentaar',
      b: [1],
    });
  });

  it('maps workbench and token colours onto every token', () => {
    const { theme } = importVsCodeTheme(dark);
    expect(theme.id).toBe('vscode-nachtblauw');
    expect(theme.name).toBe('Nachtblauw');
    expect(theme.dark).toBe(true);
    expect(Object.keys(theme.colors).sort()).toEqual([...TOKENS].sort());
    expect(theme.colors.bg).toBe('#1b2130');
    expect(theme.colors.panel).toBe('#161b27');
    expect(theme.colors.accent).toBe('#2f66c4');
    expect(theme.colors['syn-keyword']).toBe('#c792ea');
    expect(theme.colors['syn-string']).toBe('#a5d68a');
    // Transparency is flattened onto the background.
    expect(theme.colors['editor-selection']).toMatch(/^#[0-9a-f]{6}$/);
    expect(theme.colors.hover).not.toBe('#ffffff');
  });

  it('makes every imported theme pass the contrast checks', () => {
    const { theme, adjusted } = importVsCodeTheme(dark);
    for (const [fg, bg, min] of CONTRAST_PAIRS) {
      expect(contrast(theme.colors[fg], theme.colors[bg]), `${fg} op ${bg}`).toBeGreaterThanOrEqual(
        min,
      );
    }
    // The comment colour equals the line numbers here: too faint, so it was lifted.
    expect(adjusted).toContain('syn-comment');
  });

  it('builds a light theme from almost nothing', () => {
    const { theme } = importVsCodeTheme(
      JSON.stringify({ type: 'light', colors: { 'editor.background': '#fffdf5' } }),
      'zand-color-theme.json',
    );
    expect(theme.name).toBe('zand');
    expect(theme.dark).toBe(false);
    for (const [fg, bg, min] of CONTRAST_PAIRS) {
      expect(contrast(theme.colors[fg], theme.colors[bg])).toBeGreaterThanOrEqual(min);
    }
  });

  it('skips an accent that is grey or the background colour', () => {
    const { theme } = importVsCodeTheme(
      JSON.stringify({
        type: 'light',
        colors: {
          'editor.background': '#fafafa',
          'button.background': '#fafafa',
          focusBorder: '#e0e0e0',
          'activityBarBadge.background': '#526fff',
        },
      }),
    );
    expect(theme.colors.accent).toBe('#526fff');
  });

  it('keeps text light in a dark theme whose selection is lighter than the text', () => {
    const { theme } = importVsCodeTheme(
      JSON.stringify({
        type: 'dark',
        colors: {
          'editor.background': '#0a0c10',
          'editor.foreground': '#f0f3f6',
          'list.activeSelectionBackground': '#9ea7b366',
          'editor.selectionBackground': '#ffffffee',
        },
      }),
    );
    for (const [fg, bg, min] of CONTRAST_PAIRS) {
      expect(contrast(theme.colors[fg], theme.colors[bg]), `${fg} op ${bg}`).toBeGreaterThanOrEqual(
        min,
      );
    }
    expect(contrast(theme.colors.text, theme.colors.bg)).toBeGreaterThan(15);
  });

  it('refuses files that are not a theme', () => {
    expect(() => importVsCodeTheme('{ nope')).toThrow(/Geen geldig JSON/);
    expect(() => importVsCodeTheme('{"name":"x"}')).toThrow(/geen VS Code-thema/);
    expect(() => importVsCodeTheme('{"tokenColors":"./x.tmTheme"}')).toThrow(/ander bestand/);
  });

  it('repairs a background when the text alone cannot reach the contrast', () => {
    const colors = importVsCodeTheme(dark).theme.colors;
    colors['select-bg'] = '#777777';
    colors.text = '#808080';
    ensureContrast(colors, true);
    expect(contrast(colors.text, colors['select-bg'])).toBeGreaterThanOrEqual(4.5);
  });
});
