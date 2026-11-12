import { Injectable, signal } from '@angular/core';

export interface MenuAction {
  label: string;
  run: () => void;
  /** Shown on the right, e.g. "Enter" or "F5". Only a hint; the key itself works elsewhere. */
  shortcut?: string;
  /** Destructive: shown in red. Put these last, after a separator. */
  danger?: boolean;
}

export interface MenuSubmenu {
  label: string;
  items: (MenuAction | 'separator')[];
}

export type MenuEntry = MenuAction | MenuSubmenu | 'separator';

export interface OpenMenu {
  x: number;
  y: number;
  items: MenuEntry[];
  /** Accessible name, e.g. "Acties voor orders". */
  label: string;
  /** Gets the focus back when the menu closes without an action that moves it elsewhere. */
  returnFocus: HTMLElement | null;
}

export const isSubmenu = (entry: MenuEntry): entry is MenuSubmenu =>
  entry !== 'separator' && 'items' in entry;

/** One context menu for the whole app; the component in app.html shows it. */
@Injectable({ providedIn: 'root' })
export class ContextMenuStore {
  readonly menu = signal<OpenMenu | null>(null);

  /** Opens at the mouse, or under the element when opened with the keyboard. */
  open(event: MouseEvent | KeyboardEvent, label: string, items: MenuEntry[]): void {
    const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    let x: number;
    let y: number;
    if (event instanceof MouseEvent && (event.clientX || event.clientY)) {
      x = event.clientX;
      y = event.clientY;
    } else {
      const rect = target?.getBoundingClientRect();
      x = (rect?.left ?? 0) + 24;
      y = rect?.bottom ?? 0;
    }
    event.preventDefault();
    event.stopPropagation();
    const cleaned = tidy(items);
    if (cleaned.length === 0) return;
    this.menu.set({ x, y, items: cleaned, label, returnFocus: target });
  }

  close(): void {
    this.menu.set(null);
  }
}

/** Leaves out separators at the start and end and doubled ones (after dropping actions). */
export function tidy(items: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of items) {
    if (entry === 'separator' && (out.length === 0 || out.at(-1) === 'separator')) continue;
    out.push(entry);
  }
  if (out.at(-1) === 'separator') out.pop();
  return out;
}
