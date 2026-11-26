/**
 * A VS Code colour theme (.json) turned into a DB Viewer theme: the workbench colours become the
 * app's surfaces, the token colours the syntax colours. What the theme leaves out is derived from
 * its background and text, and colours that are hard to read are nudged until they pass the same
 * contrast checks as the built-in themes.
 */
import { CONTRAST_PAIRS, contrast, luminance, TOKENS, type Theme, type Token } from './themes';

export interface ImportedTheme {
  theme: Theme;
  /** Tokens whose colour was changed to be readable. */
  adjusted: Token[];
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface TokenColor {
  scope?: string | string[];
  settings?: { foreground?: string };
}

interface VsCodeTheme {
  name?: unknown;
  type?: unknown;
  colors?: Record<string, unknown>;
  tokenColors?: unknown;
}

/** JSON with comments and trailing commas, as VS Code writes its themes. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function parseColor(value: unknown): Rgba | null {
  if (typeof value !== 'string') return null;
  const m = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const n = (k: number) => parseInt(h.slice(k, k + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

const hex = ({ r, g, b }: { r: number; g: number; b: number }) =>
  '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');

/** How colourful: 0 for grey, white and black, up to 1 for a pure colour. */
function chroma(color: string): number {
  const { r, g, b } = parseColor(color)!;
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

/** a moved towards b by t (0 = a, 1 = b). */
export function mix(a: string, b: string, t: number): string {
  const x = parseColor(a)!;
  const y = parseColor(b)!;
  return hex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

/** A colour with transparency, as it looks on the given background. */
function over(c: Rgba, base: string): string {
  return mix(base, hex(c), c.a);
}

/** The colour of the most specific rule that applies to one of the scopes, in order of preference. */
function tokenColor(rules: TokenColor[], scopes: string[]): string | null {
  for (const target of scopes) {
    let best: { len: number; color: string } | null = null;
    for (const rule of rules) {
      const fg = rule.settings?.foreground;
      if (!fg || !parseColor(fg)) continue;
      const list = Array.isArray(rule.scope)
        ? rule.scope
        : typeof rule.scope === 'string'
          ? rule.scope.split(',')
          : [];
      for (const raw of list) {
        const s = raw.trim();
        // Descendant selectors ("meta.x keyword") only apply inside something; skip them.
        if (!s || /\s/.test(s)) continue;
        if ((target === s || target.startsWith(s + '.')) && s.length > (best?.len ?? -1)) {
          best = { len: s.length, color: fg };
        }
      }
    }
    if (best) return best.color;
  }
  return null;
}

export function importVsCodeTheme(text: string, fileName = ''): ImportedTheme {
  let json: VsCodeTheme;
  try {
    json = parseJsonc(text) as VsCodeTheme;
  } catch (e) {
    throw new Error(`Geen geldig JSON-bestand: ${(e as Error).message}`);
  }
  if (!json || typeof json !== 'object' || (!json.colors && !json.tokenColors)) {
    throw new Error('Dit lijkt geen VS Code-thema: er staan geen "colors" of "tokenColors" in.');
  }
  if (typeof json.tokenColors === 'string') {
    throw new Error(
      'De syntaxkleuren staan in een ander bestand (tokenColors verwijst naar een bestand). Kies het thema-bestand waarin ze zelf staan.',
    );
  }
  const colors = (json.colors ?? {}) as Record<string, unknown>;
  const rules = (Array.isArray(json.tokenColors) ? json.tokenColors : []) as TokenColor[];

  const editorBg = parseColor(colors['editor.background']);
  const typeName = typeof json.type === 'string' ? json.type.toLowerCase() : '';
  const dark = typeName
    ? !typeName.includes('light')
    : editorBg
      ? luminance(hex(editorBg)) < 0.4
      : true;
  const bg = editorBg ? over(editorBg, dark ? '#000000' : '#ffffff') : dark ? '#1e1e1e' : '#ffffff';
  /** A workbench colour, flattened onto the background; null when the theme has none. */
  const ui = (...keys: string[]): string | null => {
    for (const k of keys) {
      const c = parseColor(colors[k]);
      if (c) return over(c, bg);
    }
    return null;
  };
  const syntax = (...scopes: string[]): string | null => {
    const c = parseColor(tokenColor(rules, scopes));
    return c ? over(c, bg) : null;
  };

  const text0 =
    ui('editor.foreground', 'foreground') ??
    syntax('source', 'text') ??
    (dark ? '#d4d4d4' : '#333333');
  // The accent: the first colour the theme uses for emphasis that is neither grey nor close to
  // the background (many themes give buttons the background colour, or a grey).
  const accent =
    [
      'focusBorder',
      'button.background',
      'activityBarBadge.background',
      'progressBar.background',
      'textLink.foreground',
      'editorCursor.foreground',
    ]
      .map((k) => ui(k))
      .find((c) => c !== null && chroma(c) > 0.2 && contrast(c, bg) >= 2) ??
    syntax('keyword.control', 'keyword') ??
    (dark ? '#4c8dff' : '#0b63c5');
  const ok =
    ui('terminal.ansiGreen', 'gitDecoration.addedResourceForeground') ??
    (dark ? '#3fb950' : '#1a7f37');
  const warn =
    ui('editorWarning.foreground', 'terminal.ansiYellow', 'list.warningForeground') ??
    (dark ? '#d29922' : '#9a6700');
  const err =
    ui('errorForeground', 'editorError.foreground', 'terminal.ansiRed') ??
    (dark ? '#f85149' : '#cf222e');
  const panel = ui('sideBar.background', 'panel.background') ?? mix(bg, text0, 0.03);
  // Borders only when they are quiet: some themes draw them in a bright accent, which would
  // outline every field and button.
  const border =
    ['editorGroup.border', 'sideBar.border', 'panel.border', 'contrastBorder']
      .map((k) => ui(k))
      .find((c) => c !== null && chroma(c) < 0.2 && contrast(c, bg) < 3) ?? mix(bg, text0, 0.15);
  const inkOn = (c: string) => (luminance(c) > 0.35 ? '#000000' : '#ffffff');
  const comment = syntax('comment') ?? mix(text0, bg, 0.45);
  const keyword = syntax('keyword.control', 'keyword', 'storage') ?? accent;

  const out: Record<Token, string> = {
    bg,
    panel,
    'panel-2': ui('input.background', 'dropdown.background') ?? mix(panel, text0, 0.05),
    'row-alt': mix(bg, text0, 0.025),
    border,
    'border-soft': mix(bg, border, 0.6),
    'grid-line': mix(bg, text0, 0.07),
    tabbar: ui('editorGroupHeader.tabsBackground', 'tab.inactiveBackground') ?? panel,
    hover: ui('list.hoverBackground') ?? mix(bg, text0, 0.06),
    'select-bg':
      ui('list.activeSelectionBackground', 'list.inactiveSelectionBackground') ??
      mix(bg, accent, 0.25),
    text: text0,
    'text-2': ui('descriptionForeground') ?? mix(text0, bg, 0.25),
    'text-3': mix(text0, bg, 0.4),
    accent,
    'accent-ink': inkOn(accent),
    'accent-soft': mix(bg, accent, 0.18),
    'accent-text': ui('textLink.foreground') ?? accent,
    'accent-border': mix(bg, accent, 0.5),
    ok,
    'ok-text': ok,
    'ok-bg': mix(bg, ok, 0.14),
    'ok-border': mix(bg, ok, 0.45),
    warn,
    'warn-text': warn,
    'warn-bg': mix(bg, warn, 0.14),
    'warn-border': mix(bg, warn, 0.45),
    'warn-soft': mix(bg, warn, 0.25),
    err,
    'err-text': err,
    'err-bg': mix(bg, err, 0.14),
    'err-border': mix(bg, err, 0.45),
    'err-ink': inkOn(err),
    'label-blue': ui('terminal.ansiBlue') ?? accent,
    shadow: dark ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.18)',
    backdrop: dark ? 'rgba(0, 0, 0, 0.55)' : 'rgba(0, 0, 0, 0.3)',
    'syn-keyword': keyword,
    'syn-string': syntax('string.quoted', 'string') ?? text0,
    'syn-number': syntax('constant.numeric', 'constant') ?? text0,
    'syn-comment': comment,
    'syn-operator': syntax('keyword.operator', 'punctuation') ?? text0,
    'syn-type': syntax('storage.type', 'entity.name.type', 'support.type') ?? keyword,
    'syn-special':
      syntax('constant.language', 'support.function', 'entity.name.function', 'variable') ?? accent,
    'editor-gutter': ui('editorGutter.background') ?? bg,
    'editor-gutter-text': ui('editorLineNumber.foreground') ?? mix(text0, bg, 0.45),
    'editor-active-line': ui('editor.lineHighlightBackground') ?? mix(bg, text0, 0.04),
    'editor-selection': ui('editor.selectionBackground') ?? mix(bg, accent, 0.3),
    'editor-match': ui('editor.findMatchHighlightBackground') ?? mix(bg, warn, 0.25),
    'editor-selection-match': ui('editor.selectionHighlightBackground') ?? mix(bg, accent, 0.18),
  };

  const adjusted = ensureContrast(out, dark);
  const name =
    (typeof json.name === 'string' && json.name.trim()) ||
    fileName.replace(/\.json$/i, '').replace(/-color-theme$/i, '') ||
    'VS Code-thema';
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return {
    theme: {
      id: `vscode-${slug || 'thema'}`,
      name,
      description: 'Geïmporteerd VS Code-thema',
      dark,
      colors: out,
    },
    adjusted,
  };
}

/**
 * Makes every pair from the contrast checks readable. Text moves towards white in a dark theme and
 * towards black in a light one; text on a filled colour (a button) moves to whichever end reads
 * better. When the text alone cannot get there, its background moves the other way. Returns the
 * tokens that changed.
 */
export function ensureContrast(colors: Record<Token, string>, dark: boolean): Token[] {
  const changed = new Set<Token>();
  const step = (token: Token, towards: string, ok: () => boolean) => {
    const start = colors[token];
    for (let t = 0.05; !ok() && t <= 1.0001; t += 0.05) colors[token] = mix(start, towards, t);
  };
  for (let pass = 0; pass < 6; pass++) {
    let clean = true;
    for (const [fg, bgToken, min] of CONTRAST_PAIRS) {
      const ok = () => contrast(colors[fg], colors[bgToken]) >= min;
      if (ok()) continue;
      clean = false;
      const ink = fg.endsWith('-ink');
      const light = ink
        ? contrast('#ffffff', colors[bgToken]) >= contrast('#000000', colors[bgToken])
        : dark;
      step(fg, light ? '#ffffff' : '#000000', ok);
      changed.add(fg);
      if (!ok()) {
        step(bgToken, light ? '#000000' : '#ffffff', ok);
        changed.add(bgToken);
      }
    }
    if (clean) break;
  }
  return TOKENS.filter((t) => changed.has(t));
}
