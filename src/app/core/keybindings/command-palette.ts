import {
  afterRenderEffect,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { KeybindingsStore } from './keybindings.store';

/** Every command by name, with its key (Ctrl+Shift+P or F1), like VS Code's command palette. */
@Component({
  selector: 'app-command-palette',
  template: `
    @if (store.paletteOpen()) {
      <dialog
        #dialog
        class="dialog cp-dialog"
        aria-label="Opdrachtenpalet"
        (cancel)="$event.preventDefault(); close()"
        (click)="$event.target === dialog && close()"
      >
        <input
          #input
          class="input cp-input"
          type="text"
          role="combobox"
          aria-label="Opdracht zoeken"
          aria-controls="cp-list"
          [attr.aria-activedescendant]="'cp-' + active()"
          placeholder="Typ een opdracht…"
          autocomplete="off"
          [value]="query()"
          (input)="query.set(input.value); active.set(0)"
          (keydown)="onKey($event)"
        />
        <ul id="cp-list" class="cp-list" role="listbox" aria-label="Opdrachten">
          @for (c of matches(); track c.id; let i = $index) {
            <li
              [id]="'cp-' + i"
              role="option"
              class="cp-item"
              [class.active]="i === active()"
              [attr.aria-selected]="i === active()"
              (mousemove)="active.set(i)"
              (click)="run(c.id)"
            >
              <span
                ><span class="muted">{{ c.category }}:</span> {{ c.title }}</span
              >
              @if (store.keyLabel(c.id); as key) {
                <kbd class="kb-key">{{ key }}</kbd>
              }
            </li>
          } @empty {
            <li class="cp-item muted">Geen opdracht gevonden</li>
          }
        </ul>
      </dialog>
    }
  `,
})
export class CommandPalette {
  protected readonly store = inject(KeybindingsStore);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');
  protected readonly query = signal('');
  protected readonly active = signal(0);

  protected readonly matches = computed(() => {
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    return this.store.commands.filter((c) => {
      if (c.id === 'workbench.commandPalette') return false;
      const text = `${c.category} ${c.title}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  });

  constructor() {
    afterRenderEffect(() => {
      const dialog = this.dialog()?.nativeElement;
      if (dialog && !dialog.open) {
        dialog.showModal();
        this.input()?.nativeElement.focus();
      }
    });
  }

  protected onKey(event: KeyboardEvent): void {
    const n = this.matches().length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (n) this.active.set((this.active() + (event.key === 'ArrowDown' ? 1 : n - 1)) % n);
      document.getElementById(`cp-${this.active()}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const c = this.matches()[this.active()];
      if (c) this.run(c.id);
    }
  }

  protected run(command: string): void {
    this.close();
    // After the dialog is gone, so the command sees the focus and context of the app.
    setTimeout(() => this.store.run(command));
  }

  protected close(): void {
    this.dialog()?.nativeElement.close();
    this.store.paletteOpen.set(false);
    this.query.set('');
    this.active.set(0);
  }
}
