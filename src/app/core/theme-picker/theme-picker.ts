import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ThemeStore } from '../theme.store';
import { SYSTEM, THEMES, type Theme } from '../themes';

interface Option {
  id: string;
  name: string;
  description: string;
  /** Colours for the swatch strip. */
  theme: Theme;
}

/**
 * Picks a colour theme like VS Code's Ctrl+K Ctrl+T: arrow keys or the mouse show a theme at once,
 * Enter or a click keeps it, Escape goes back to the one you had.
 */
@Component({
  selector: 'app-theme-picker',
  template: `
    <dialog
      #dialog
      class="dialog theme-picker"
      aria-labelledby="tp-title"
      (close)="onClose()"
      (keydown)="onKey($event)"
    >
      <div class="dialog-head">
        <h2 id="tp-title">Thema</h2>
        <span class="muted small">↑↓ bekijken · Enter kiezen · Esc terug</span>
      </div>
      <div
        class="theme-list"
        role="listbox"
        aria-labelledby="tp-title"
        [attr.aria-activedescendant]="'tp-' + options()[index()]?.id"
      >
        @for (o of options(); track o.id; let i = $index) {
          <div
            class="theme-option"
            role="option"
            [id]="'tp-' + o.id"
            [class.active]="i === index()"
            [attr.aria-selected]="i === index()"
            (mouseenter)="focus(i)"
            (click)="pick(o.id)"
          >
            <span class="theme-swatches" aria-hidden="true">
              <span [style.background]="o.theme.colors.bg"></span>
              <span [style.background]="o.theme.colors.panel"></span>
              <span [style.background]="o.theme.colors.accent"></span>
              <span [style.background]="o.theme.colors['syn-keyword']"></span>
              <span [style.background]="o.theme.colors['syn-string']"></span>
              <span [style.background]="o.theme.colors['syn-number']"></span>
            </span>
            <span class="theme-text">
              <strong>{{ o.name }}</strong>
              <span class="muted small">{{ o.description }}</span>
            </span>
            @if (o.id === store.choice()) {
              <span class="theme-current small">huidig</span>
            }
          </div>
        }
      </div>
    </dialog>
  `,
})
export class ThemePicker {
  protected readonly store = inject(ThemeStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private picked = false;

  protected readonly options = computed<Option[]>(() => [
    {
      id: SYSTEM,
      name: 'Systeem volgen',
      description: 'Donker of Licht, zoals Windows is ingesteld',
      theme: this.store.active(),
    },
    ...THEMES.map((t) => ({ id: t.id, name: t.name, description: t.description, theme: t })),
  ]);
  protected readonly index = signal(0);

  constructor() {
    this.index.set(
      Math.max(
        0,
        this.options().findIndex((o) => o.id === this.store.choice()),
      ),
    );
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      this.scrollToActive();
    });
  }

  protected focus(i: number): void {
    this.index.set(i);
    this.store.preview.set(this.options()[i]!.id);
    this.scrollToActive();
  }

  protected pick(id: string): void {
    this.picked = true;
    this.store.choose(id);
    this.dialog().nativeElement.close();
  }

  protected onKey(event: KeyboardEvent): void {
    const n = this.options().length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.focus((this.index() + (event.key === 'ArrowDown' ? 1 : -1) + n) % n);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      this.focus(event.key === 'Home' ? 0 : n - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.pick(this.options()[this.index()]!.id);
    }
  }

  /** Escape, a click outside or picking: a preview that was not picked goes away. */
  protected onClose(): void {
    if (!this.picked) this.store.preview.set(null);
    this.store.pickerOpen.set(false);
  }

  private scrollToActive(): void {
    queueMicrotask(() =>
      this.dialog()
        .nativeElement.querySelector('.theme-option.active')
        ?.scrollIntoView({ block: 'nearest' }),
    );
  }
}
