import { TestBed } from '@angular/core/testing';
import { COMMANDS, DEFAULT_BINDINGS } from './commands';
import { effectiveBindings, KeybindingsStore } from './keybindings.store';
import { keyOf, label, matchesWhen, normalize, type Context } from './keys';

const press = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { bubbles: true, ...init });

describe('keys', () => {
  it('reads a key press from the physical key, whatever the layout or Shift', () => {
    expect(keyOf(press({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true }))).toBe(
      'ctrl+shift+t',
    );
    expect(keyOf(press({ key: 'F9', code: 'F9', ctrlKey: true }))).toBe('ctrl+f9');
    expect(keyOf(press({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }))).toBe(
      'ctrl+shift+1',
    );
    expect(keyOf(press({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }))).toBe(
      'ctrl+shift+=',
    );
    expect(keyOf(press({ key: 'Control', code: 'ControlLeft', ctrlKey: true }))).toBeNull();
    expect(keyOf(press({ key: 'Delete', code: 'Delete' }))).toBe('delete');
  });

  it('normalizes and labels bindings, chords too', () => {
    expect(normalize('Shift+Ctrl+F9')).toBe('ctrl+shift+f9');
    expect(normalize('ctrl+K  ctrl+T')).toBe('ctrl+k ctrl+t');
    expect(label('ctrl+k ctrl+t')).toBe('Ctrl+K Ctrl+T');
    expect(label('ctrl+alt+pagedown')).toBe('Ctrl+Alt+PageDown');
    expect(label('alt+arrowleft')).toBe('Alt+←');
  });

  it('evaluates when clauses with &&, ! and ||', () => {
    const ctx = { tableTab: true, treeFocus: false, connected: true };
    expect(matchesWhen(undefined, ctx)).toBe(true);
    expect(matchesWhen('tableTab && !treeFocus', ctx)).toBe(true);
    expect(matchesWhen('treeFocus || connected && !tableTab', ctx)).toBe(false);
    expect(matchesWhen('treeFocus || connected', ctx)).toBe(true);
  });
});

describe('default keys', () => {
  it('only bind commands that exist, with valid keys', () => {
    const ids = new Set(COMMANDS.map((c) => c.id));
    for (const b of DEFAULT_BINDINGS) {
      expect(ids.has(b.command), b.command).toBe(true);
      expect(normalize(b.key), b.key).toBe(b.key);
    }
  });

  it('keep DB Viewer keys and add HeidiSQL ones', () => {
    const keysOf = (command: string) =>
      DEFAULT_BINDINGS.filter((b) => b.command === command).map((b) => b.key);
    expect(keysOf('sql.runCurrent')).toEqual(['ctrl+enter', 'ctrl+shift+f9', 'ctrl+f9']);
    expect(keysOf('sql.runAll')).toEqual(['ctrl+shift+enter', 'f9']);
    expect(keysOf('data.save')).toEqual(['ctrl+s', 'ctrl+enter']);
    expect(keysOf('workbench.zoomReset')).toEqual(['ctrl+0']);
    expect(keysOf('workbench.theme')).toEqual(['ctrl+k ctrl+t']);
    expect(keysOf('tabs.newSql')).toEqual(['ctrl+t']);
  });

  it('never give one key two commands in the same place', () => {
    // Contexts that can be true together, to check every pair of defaults on the same key.
    const contexts: Context[] = [
      { connected: true, sqlTab: true, editorFocus: true },
      { connected: true, sqlTab: true, gridFocus: true },
      { connected: true, sqlTab: true },
      { connected: true, tableTab: true, gridFocus: true },
      { connected: true, tableTab: true, inputFocus: true },
      { connected: true, tableTab: true, treeFocus: true },
      { connected: true, tableTab: true },
      { connected: true, treeFocus: true },
      { connected: true },
      {},
    ];
    for (const ctx of contexts) {
      const seen = new Map<string, string>();
      for (const b of DEFAULT_BINDINGS.filter((b) => matchesWhen(b.when, ctx))) {
        const other = seen.get(b.key);
        // Esc may fall through (sql.stop only acts while running); everything else must be unique.
        if (other && other !== b.command) expect(`${b.key}: ${other} / ${b.command}`).toBe('');
        seen.set(b.key, b.command);
      }
    }
  });
});

describe('KeybindingsStore', () => {
  let store: KeybindingsStore;
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    store = TestBed.inject(KeybindingsStore);
  });

  it('changes, removes and resets keys, remembered like keybindings.json', () => {
    store.setKey('sql.runAll', 'ctrl+r', 'f9');
    expect(store.user()).toEqual([
      { key: 'f9', command: '-sql.runAll' },
      { key: 'ctrl+r', command: 'sql.runAll' },
    ]);
    const keys = store.bindings().filter((b) => b.command === 'sql.runAll');
    expect(keys.map((b) => [b.key, b.source])).toEqual([
      ['ctrl+r', 'Gebruiker'],
      ['ctrl+shift+enter', 'DB Viewer'],
    ]);
    expect(JSON.parse(localStorage.getItem('dbv.keybindings')!)).toHaveLength(2);

    store.removeKey('sql.runAll', 'ctrl+r');
    store.setKey('sql.runAll', 'f9');
    expect(store.user()).toEqual([]);

    store.removeKey('tabs.newSql', 'ctrl+t');
    expect(store.keyLabel('tabs.newSql')).toBe('');
    store.reset('tabs.newSql');
    expect(store.keyLabel('tabs.newSql')).toBe('Ctrl+T');
  });

  it('runs the command for a key, with chords, and lets keys through that do not apply', () => {
    const ran: string[] = [];
    store.handle('workbench.theme', () => void ran.push('theme'));
    store.handle('sql.stop', () => false); // nothing running
    store.handle('tabs.newSql', () => void ran.push('new'));
    store.provideContext(() => ({ connected: true, sqlTab: true }));

    const k = press({ key: 'k', code: 'KeyK', ctrlKey: true, cancelable: true });
    store.onKeydown(k);
    expect(k.defaultPrevented).toBe(true);
    store.onKeydown(press({ key: 't', code: 'KeyT', ctrlKey: true, cancelable: true }));
    expect(ran).toEqual(['theme']);

    store.onKeydown(press({ key: 't', code: 'KeyT', ctrlKey: true, cancelable: true }));
    expect(ran).toEqual(['theme', 'new']);

    const esc = press({ key: 'Escape', code: 'Escape', cancelable: true });
    store.onKeydown(esc);
    expect(esc.defaultPrevented).toBe(false);
  });

  it('a user key wins over a default on the same key', () => {
    const bindings = effectiveBindings([{ key: 'f9', command: 'tabs.newSql' }]);
    expect(bindings.find((b) => b.key === 'f9')?.command).toBe('tabs.newSql');
  });
});
