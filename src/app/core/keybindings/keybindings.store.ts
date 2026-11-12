import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import {
  COMMANDS,
  DEFAULT_BINDINGS,
  type BindingSource,
  type CommandInfo,
  type Keybinding,
} from './commands';
import { keyOf, label, matchesWhen, normalize, type Context } from './keys';

const STORAGE_KEY = 'dbv.keybindings';
/** How long the second half of a chord (Ctrl+K …) is awaited. */
const CHORD_MS = 1500;

/**
 * Runs a command; returns false when it did not apply right now (e.g. Esc with nothing running),
 * so the key goes on to whatever else handles it.
 */
export type CommandHandler = () => boolean | void;

/** A binding as in effect, with where it comes from. */
export interface EffectiveBinding extends Keybinding {
  source: BindingSource | 'Gebruiker';
}

/**
 * User changes, like VS Code's keybindings.json: an entry adds a key; a command starting with "-"
 * removes a default key ({ key: 'f9', command: '-sql.runAll' }).
 */
function loadUser(): Keybinding[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (b): b is Keybinding =>
          !!b && typeof b.key === 'string' && typeof b.command === 'string' && b.key.length < 64,
      )
      .map((b) => ({ key: normalize(b.key), command: b.command, ...(b.when && { when: b.when }) }));
  } catch {
    return [];
  }
}

/** The bindings in effect: defaults minus the removed ones, plus the user's own. */
export function effectiveBindings(user: Keybinding[]): EffectiveBinding[] {
  const removed = new Set(
    user.filter((b) => b.command.startsWith('-')).map((b) => `${b.key}|${b.command.slice(1)}`),
  );
  return [
    // The user's own first: they win over a default on the same key.
    ...user
      .filter((b) => !b.command.startsWith('-'))
      .map((b) => ({ ...b, source: 'Gebruiker' as const })),
    ...DEFAULT_BINDINGS.filter((b) => !removed.has(`${b.key}|${b.command}`)).map((b) => ({
      key: b.key,
      command: b.command,
      ...(b.when && { when: b.when }),
      source: b.source,
    })),
  ];
}

@Injectable({ providedIn: 'root' })
export class KeybindingsStore {
  readonly user = signal<Keybinding[]>(loadUser());
  readonly bindings = computed(() => effectiveBindings(this.user()));
  readonly commands: CommandInfo[] = COMMANDS;
  readonly editorOpen = signal(false);
  readonly paletteOpen = signal(false);

  private readonly handlers = new Map<string, CommandHandler[]>();
  private readonly contextProviders: (() => Context)[] = [];
  /** First half of a chord, waiting for the second. */
  private pendingChord: { key: string; until: number } | null = null;
  /** While recording a key in the editor, nothing runs. */
  readonly recording = signal(false);

  /**
   * Registers what a command does. Several components may handle the same command (one per tab);
   * the last registered that applies runs. Unregisters with the component when given its DestroyRef.
   */
  handle(command: string, handler: CommandHandler, destroyRef?: DestroyRef): () => void {
    const list = this.handlers.get(command) ?? [];
    list.push(handler);
    this.handlers.set(command, list);
    const remove = () => {
      const current = this.handlers.get(command) ?? [];
      const i = current.indexOf(handler);
      if (i >= 0) current.splice(i, 1);
    };
    destroyRef?.onDestroy(remove);
    return remove;
  }

  /** Adds context keys (tableTab, sqlTab, …) known outside the DOM. */
  provideContext(provider: () => Context): void {
    this.contextProviders.push(provider);
  }

  /** Runs a command now (palette, menus); true when something handled it. */
  run(command: string): boolean {
    const list = this.handlers.get(command) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!() !== false) return true;
    }
    return false;
  }

  /** The first key of a command, for hints in menus and tooltips ("Ctrl+C"); '' when none. */
  keyLabel(command: string): string {
    const binding = this.bindings().find((b) => b.command === command);
    return binding ? label(binding.key) : '';
  }

  title(command: string): string {
    return this.commands.find((c) => c.id === command)?.title ?? command;
  }

  // ── Changing keys (from the keyboard shortcuts editor) ─────────────
  /** Gives a command this key instead of the one it had (`oldKey`), or adds it (no oldKey). */
  setKey(command: string, newKey: string, oldKey?: string, when?: string): void {
    const user = [...this.user()];
    const key = normalize(newKey);
    if (oldKey) this.dropKey(user, command, oldKey);
    if (!user.some((b) => b.key === key && b.command === command)) {
      // Back to a default key that was removed: just undo the removal.
      const removal = user.findIndex((b) => b.key === key && b.command === `-${command}`);
      if (removal >= 0) user.splice(removal, 1);
      else if (!DEFAULT_BINDINGS.some((b) => b.key === key && b.command === command))
        user.push({ key, command, ...(when && { when }) });
    }
    this.save(user);
  }

  removeKey(command: string, key: string): void {
    const user = [...this.user()];
    this.dropKey(user, command, key);
    this.save(user);
  }

  /** Back to the default keys of one command. */
  reset(command: string): void {
    this.save(this.user().filter((b) => b.command !== command && b.command !== `-${command}`));
  }

  resetAll(): void {
    this.save([]);
  }

  isChanged(command: string): boolean {
    return this.user().some((b) => b.command === command || b.command === `-${command}`);
  }

  private dropKey(user: Keybinding[], command: string, key: string): void {
    const own = user.findIndex((b) => b.key === key && b.command === command);
    if (own >= 0) user.splice(own, 1);
    else if (DEFAULT_BINDINGS.some((b) => b.key === key && b.command === command))
      user.push({ key, command: `-${command}` });
  }

  private save(user: Keybinding[]): void {
    this.user.set(user);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    } catch {
      // Not saved: the keys still work until the app closes.
    }
  }

  // ── Dispatching ────────────────────────────────────────────────────
  /** What is true now: focus from the DOM, the rest from the providers. */
  context(): Context {
    const active = document.activeElement as HTMLElement | null;
    const inEditor = !!active?.closest('.cm-editor');
    const isInput =
      !inEditor &&
      !!active &&
      (['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.isContentEditable);
    const ctx: Context = {
      editorFocus: inEditor,
      inputFocus: isInput,
      gridFocus: !isInput && !!active?.closest('app-data-grid'),
      treeFocus: !isInput && !!active?.closest('app-schema-tree'),
    };
    for (const provide of this.contextProviders) Object.assign(ctx, provide());
    return ctx;
  }

  /**
   * The app-wide key handler (capture phase, before the editor and the grid). Runs the command
   * bound to the key, if any applies here, and keeps the key from doing anything else.
   */
  onKeydown(event: KeyboardEvent): void {
    if (this.recording() || event.defaultPrevented) return;
    const key = keyOf(event);
    if (!key) return;
    // Modal dialogs and context menus have their own keys; only the palette opens over nothing.
    if (document.querySelector('dialog[open], .ctx-menu')) {
      this.pendingChord = null;
      return;
    }
    const now = Date.now();
    let full = key;
    if (this.pendingChord && now < this.pendingChord.until)
      full = `${this.pendingChord.key} ${key}`;
    this.pendingChord = null;

    const bindings = this.bindings();
    const ctx = this.context();
    const candidates = bindings.filter((b) => b.key === full && matchesWhen(b.when, ctx));
    for (const binding of candidates) {
      if (this.run(binding.command)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    // The start of a chord (Ctrl+K): wait for the second key.
    if (
      full === key &&
      bindings.some((b) => b.key.startsWith(key + ' ') && matchesWhen(b.when, ctx))
    ) {
      this.pendingChord = { key, until: now + CHORD_MS };
      event.preventDefault();
      event.stopPropagation();
    }
  }
}
