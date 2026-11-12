/**
 * Keys as text, like VS Code's keybindings: `ctrl+shift+f9`, chords as two parts separated by a
 * space (`ctrl+k ctrl+t`). Letters and digits come from the physical key (event.code), so a
 * binding works the same with every keyboard layout and with Shift held.
 */

const MODIFIERS = ['ctrl', 'shift', 'alt', 'meta'] as const;

const CODE_NAMES: Record<string, string> = {
  Equal: '=',
  Minus: '-',
  NumpadAdd: 'numpad_add',
  NumpadSubtract: 'numpad_subtract',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Space: 'space',
  NumpadEnter: 'enter',
};

/** One key press as text, e.g. `ctrl+shift+f9`; null for a modifier on its own. */
export function keyOf(event: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(event.key)) return null;
  let key: string;
  const code = event.code ?? '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^Numpad\d$/.test(code)) key = `numpad${code.slice(6)}`;
  else if (CODE_NAMES[code]) key = CODE_NAMES[code]!;
  else key = event.key.toLowerCase();
  if (key === ' ') key = 'space';
  if (key === 'esc') key = 'escape';
  if (key === 'del') key = 'delete';
  const parts: string[] = [];
  // Cmd on a Mac does what Ctrl does elsewhere.
  if (event.ctrlKey || event.metaKey) parts.push('ctrl');
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');
  parts.push(key);
  return parts.join('+');
}

/** A binding as written by a user, in a fixed order (`Shift+Ctrl+X` → `ctrl+shift+x`). */
export function normalize(binding: string): string {
  return binding
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((part) => {
      const pieces = part.split('+');
      // "ctrl++" means ctrl and the plus key.
      const key = part.endsWith('++') ? '+' : pieces.pop()!;
      const mods = new Set(pieces.filter((p) => p !== ''));
      return [...MODIFIERS.filter((m) => mods.has(m)), key].join('+');
    })
    .join(' ');
}

const KEY_LABELS: Record<string, string> = {
  ctrl: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  meta: 'Meta',
  enter: 'Enter',
  escape: 'Esc',
  tab: 'Tab',
  delete: 'Del',
  insert: 'Ins',
  backspace: 'Backspace',
  space: 'Spatie',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  contextmenu: 'Menutoets',
  numpad_add: 'Num +',
  numpad_subtract: 'Num -',
};

/** For people: `Ctrl+Shift+F9`, `Ctrl+K Ctrl+T`. */
export function label(binding: string): string {
  return binding
    .split(' ')
    .map((part) =>
      part
        .split('+')
        .map((p) => KEY_LABELS[p] ?? (p.length === 1 ? p.toUpperCase() : p.toUpperCase()))
        .join('+'),
    )
    .join(' ');
}

/** What is true right now, for `when` clauses. */
export type Context = Record<string, boolean>;

/**
 * A `when` clause: terms joined with `&&`, each optionally negated with `!`, alternatives with
 * `||` (e.g. `sqlTab && editorFocus || gridFocus`). Empty or missing means always.
 */
export function matchesWhen(when: string | undefined, context: Context): boolean {
  if (!when || !when.trim()) return true;
  return when.split('||').some((alternative) =>
    alternative
      .split('&&')
      .map((t) => t.trim())
      .filter(Boolean)
      .every((term) => (term.startsWith('!') ? !context[term.slice(1).trim()] : !!context[term])),
  );
}

const CONTEXT_WORDS: Record<string, string> = {
  connected: 'verbonden',
  tableTab: 'tabel-tabblad',
  sqlTab: 'SQL-tabblad',
  editorFocus: 'in de editor',
  gridFocus: 'in het grid',
  treeFocus: 'in de boom',
  inputFocus: 'in een tekstveld',
};

/** A when clause in words: `tableTab && !inputFocus` → "tabel-tabblad, niet in een tekstveld". */
export function whenInWords(when: string | undefined): string {
  if (!when) return '';
  return when
    .split('||')
    .map((alt) =>
      alt
        .split('&&')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) =>
          t.startsWith('!')
            ? `niet ${CONTEXT_WORDS[t.slice(1).trim()] ?? t.slice(1)}`
            : (CONTEXT_WORDS[t] ?? t),
        )
        .join(', '),
    )
    .join(' of ');
}
