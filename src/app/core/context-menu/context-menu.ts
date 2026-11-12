import {
  afterRenderEffect,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ContextMenuStore, isSubmenu, type MenuAction, type MenuEntry } from './context-menu.store';

const MARGIN = 8;

/**
 * The app's context menu (right click, Shift+F10 or the menu key). Arrow keys, Home/End and the
 * first letter move through it, Enter runs, Right opens a submenu, Left and Escape go back.
 */
@Component({
  selector: 'app-context-menu',
  host: {
    '(window:pointerdown)': 'onOutside($event)',
    '(window:keydown.escape)': 'onEscape()',
    '(window:resize)': 'store.close()',
    '(window:blur)': 'store.close()',
    '(document:scroll)': 'store.close()',
  },
  template: `
    @if (store.menu(); as m) {
      <div
        #root
        class="ctx-menu"
        role="menu"
        [attr.aria-label]="m.label"
        [style.left.px]="pos().x"
        [style.top.px]="pos().y"
        (keydown)="onKey($event, m.items, null)"
        (focusout)="onFocusOut($event)"
      >
        @for (entry of m.items; track $index) {
          @if (entry === 'separator') {
            <div class="ctx-sep" role="separator"></div>
          } @else if (isSubmenu(entry)) {
            <button
              type="button"
              role="menuitem"
              tabindex="-1"
              class="ctx-item"
              aria-haspopup="menu"
              [attr.aria-expanded]="openSub() === $index"
              (click)="showSub($index, true)"
              (pointerenter)="showSub($index, false)"
            >
              <span class="ctx-label">{{ entry.label }}</span>
              <span class="ctx-arrow" aria-hidden="true">›</span>
            </button>
            @if (openSub() === $index) {
              <div
                #sub
                class="ctx-menu ctx-sub"
                role="menu"
                [attr.aria-label]="entry.label"
                [style.left.px]="subPos().x"
                [style.top.px]="subPos().y"
                (keydown)="onKey($event, entry.items, $index)"
              >
                @for (item of entry.items; track $index) {
                  <button
                    type="button"
                    role="menuitem"
                    tabindex="-1"
                    class="ctx-item"
                    [class.danger]="item.danger"
                    (click)="run(item)"
                  >
                    <span class="ctx-label">{{ item.label }}</span>
                  </button>
                }
              </div>
            }
          } @else {
            <button
              type="button"
              role="menuitem"
              tabindex="-1"
              class="ctx-item"
              [class.danger]="entry.danger"
              (click)="run(entry)"
              (pointerenter)="openSub.set(null)"
            >
              <span class="ctx-label">{{ entry.label }}</span>
              @if (entry.shortcut) {
                <kbd class="ctx-key">{{ entry.shortcut }}</kbd>
              }
            </button>
          }
        }
      </div>
    }
  `,
})
export class ContextMenu {
  protected readonly store = inject(ContextMenuStore);
  protected readonly isSubmenu = isSubmenu;

  private readonly root = viewChild<ElementRef<HTMLElement>>('root');
  private readonly sub = viewChild<ElementRef<HTMLElement>>('sub');

  /** Index of the open submenu entry, or null. */
  protected readonly openSub = signal<number | null>(null);
  /** Where the menu actually goes after keeping it inside the window. */
  protected readonly pos = signal({ x: 0, y: 0 });
  protected readonly subPos = signal({ x: 0, y: 0 });
  /** Focus the submenu's first item once it is rendered. */
  private focusSub = false;
  private readonly menuKey = computed(() => this.store.menu());
  /** The menu that was last positioned (an effect may run again for the same one). */
  private placed: unknown = null;

  constructor() {
    // A new menu: once rendered at the requested spot, pull it inside the window and focus it.
    afterRenderEffect({
      write: () => {
        const menu = this.menuKey();
        const el = this.root()?.nativeElement;
        untracked(() => {
          this.openSub.set(null);
          if (!menu || !el || this.placed === menu) return;
          this.placed = menu;
          el.style.left = `${menu.x}px`;
          el.style.top = `${menu.y}px`;
          const r = el.getBoundingClientRect();
          this.pos.set({
            x: Math.max(MARGIN, Math.min(menu.x, innerWidth - r.width - MARGIN)),
            y: Math.max(MARGIN, Math.min(menu.y, innerHeight - r.height - MARGIN)),
          });
          this.items(el).at(0)?.focus();
        });
      },
    });
    // A submenu: to the right of its entry, or to the left when there is no room.
    afterRenderEffect({
      write: () => {
        const index = this.openSub();
        const root = this.root()?.nativeElement;
        const sub = this.sub()?.nativeElement;
        if (index === null || !root || !sub) return;
        const anchor =
          root.querySelectorAll<HTMLElement>(':scope > .ctx-item')[this.itemIndex(index)];
        if (!anchor) return;
        const a = anchor.getBoundingClientRect();
        const m = root.getBoundingClientRect();
        const s = sub.getBoundingClientRect();
        // Coordinates relative to the menu (the submenu is positioned inside it).
        const right = a.right + s.width + MARGIN <= innerWidth;
        const x = right ? m.width - 4 : -s.width + 4;
        const y = Math.min(a.top - m.top - 5, innerHeight - m.top - s.height - MARGIN);
        this.subPos.set({ x, y });
        if (this.focusSub) {
          this.focusSub = false;
          this.items(sub).at(0)?.focus();
        }
      },
    });
  }

  protected run(item: MenuAction): void {
    // Focus back where the menu was opened first; an action that opens a tab or dialog moves it on.
    this.closeAndRestore();
    item.run();
  }

  /** Opens a submenu (hover, click, Right); with `focus` its first item gets the focus. */
  protected showSub(index: number, focus: boolean): void {
    if (this.openSub() === index) {
      // Opened by hovering a moment ago: it may not be rendered yet; focus it once it is.
      const sub = this.sub()?.nativeElement;
      if (focus && sub) this.items(sub).at(0)?.focus();
      else if (focus) this.focusSub = true;
      return;
    }
    this.focusSub = focus;
    this.openSub.set(index);
  }

  /** Escape while the focus is not (yet) in the menu. */
  protected onEscape(): void {
    if (this.store.menu() && !document.activeElement?.closest('.ctx-menu')) this.closeAndRestore();
  }

  protected onOutside(event: Event): void {
    if (!this.store.menu()) return;
    if ((event.target as HTMLElement | null)?.closest('.ctx-menu')) return;
    this.store.close();
  }

  /** Tabbing or clicking out of the menu closes it. */
  protected onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget as HTMLElement | null;
    if (next && !next.closest('.ctx-menu')) this.store.close();
  }

  protected onKey(event: KeyboardEvent, entries: MenuEntry[], subIndex: number | null): void {
    event.stopPropagation();
    const container = event.currentTarget as HTMLElement;
    const items = this.items(container);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const focus = (i: number) => items.at((i + items.length) % items.length)?.focus();

    switch (event.key) {
      case 'ArrowDown':
        focus(current + 1);
        break;
      case 'ArrowUp':
        focus(current < 0 ? -1 : current - 1);
        break;
      case 'Home':
        focus(0);
        break;
      case 'End':
        focus(-1);
        break;
      case 'ArrowRight': {
        if (subIndex !== null) break;
        const entryIndex = this.entryIndex(entries, current);
        if (entryIndex !== null && isSubmenu(entries[entryIndex]!)) this.showSub(entryIndex, true);
        break;
      }
      case 'ArrowLeft':
      case 'Escape':
        if (subIndex !== null) {
          this.openSub.set(null);
          this.items(this.root()!.nativeElement).at(this.itemIndex(subIndex))?.focus();
        } else if (event.key === 'Escape') {
          this.closeAndRestore();
        }
        break;
      case 'Tab':
        this.closeAndRestore();
        break;
      default: {
        // First letter: the next item that starts with it.
        if (event.key.length !== 1 || event.ctrlKey || event.altKey || event.metaKey) return;
        const letter = event.key.toLowerCase();
        const labels = items.map((b) => b.textContent?.trim().toLowerCase() ?? '');
        for (let step = 1; step <= items.length; step++) {
          const i = (current + step) % items.length;
          if (labels[i]?.startsWith(letter)) {
            items[i]?.focus();
            break;
          }
        }
        if (event.key === ' ') return; // Space activates the focused button
      }
    }
    event.preventDefault();
  }

  /** The menu's own items, not those of a submenu inside it. */
  private items(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(':scope > .ctx-item'));
  }

  /** Position among the buttons of entry `index` (separators are not buttons). */
  private itemIndex(index: number): number {
    const entries = this.store.menu()?.items ?? [];
    return entries.slice(0, index).filter((e) => e !== 'separator').length;
  }

  private entryIndex(entries: MenuEntry[], itemIndex: number): number | null {
    let seen = -1;
    for (const [i, e] of entries.entries()) {
      if (e === 'separator') continue;
      if (++seen === itemIndex) return i;
    }
    return null;
  }

  private closeAndRestore(): void {
    const opener = this.store.menu()?.returnFocus;
    this.store.close();
    if (opener?.isConnected) opener.focus();
  }
}
