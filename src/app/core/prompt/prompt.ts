import {
  afterRenderEffect,
  Component,
  ElementRef,
  inject,
  Injectable,
  signal,
  viewChild,
} from '@angular/core';

export interface PromptQuestion {
  title: string;
  label: string;
  value: string;
  /** Choices to pick from (they fill the field); typing anything else is fine too. */
  suggestions?: string[];
  hint?: string;
  confirm: string;
  answer: (value: string | null) => void;
}

/** A one-line question, e.g. the SQL function for a cell (Ctrl+F2). */
@Injectable({ providedIn: 'root' })
export class PromptStore {
  readonly question = signal<PromptQuestion | null>(null);

  ask(question: Omit<PromptQuestion, 'answer'>): Promise<string | null> {
    return new Promise((resolve) => {
      this.question.set({
        ...question,
        answer: (value) => {
          this.question.set(null);
          resolve(value);
        },
      });
    });
  }
}

@Component({
  selector: 'app-prompt',
  template: `
    @if (store.question(); as q) {
      <dialog
        #dialog
        class="dialog"
        aria-labelledby="pr-title"
        (cancel)="$event.preventDefault(); answer(null)"
      >
        <div class="dialog-head">
          <h2 id="pr-title">{{ q.title }}</h2>
        </div>
        <form class="dialog-body" (submit)="$event.preventDefault(); answer(field.value)">
          <label class="field">
            <span class="field-label">{{ q.label }}</span>
            <input
              #field
              class="input mono"
              autocomplete="off"
              spellcheck="false"
              [value]="q.value"
              (input)="value.set(field.value)"
            />
          </label>
          @if (q.suggestions?.length) {
            <div class="pr-chips" role="group" aria-label="Voorbeelden">
              @for (s of q.suggestions; track s) {
                <button
                  type="button"
                  class="btn btn-ghost btn-sm mono"
                  (click)="field.value = s; value.set(s); field.focus()"
                >
                  {{ s }}
                </button>
              }
            </div>
          }
          @if (q.hint) {
            <span class="muted small">{{ q.hint }}</span>
          }
        </form>
        <div class="dialog-foot">
          <div class="foot-end">
            <button type="button" class="btn btn-ghost" (click)="answer(null)">Annuleren</button>
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="!value().trim()"
              (click)="answer(value())"
            >
              {{ q.confirm }}
            </button>
          </div>
        </div>
      </dialog>
    }
  `,
})
export class Prompt {
  protected readonly store = inject(PromptStore);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');
  protected readonly value = signal('');

  constructor() {
    afterRenderEffect(() => {
      const dialog = this.dialog()?.nativeElement;
      if (dialog && !dialog.open) {
        this.value.set(this.store.question()?.value ?? '');
        dialog.showModal();
        this.field()?.nativeElement.focus();
        this.field()?.nativeElement.select();
      }
    });
  }

  protected answer(value: string | null): void {
    const q = this.store.question();
    if (value !== null && !value.trim()) return;
    this.dialog()?.nativeElement.close();
    q?.answer(value === null ? null : value.trim());
  }
}
