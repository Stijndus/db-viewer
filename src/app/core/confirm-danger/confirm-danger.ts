import {
  afterRenderEffect,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injectable,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { DbError, Result } from '../../../../shared/models';

export interface DangerQuestion {
  title: string;
  /** What will happen, in a sentence or two. */
  message: string;
  /** The statement that runs, shown so there are no surprises. */
  sql: string;
  /** Has to be typed over before the button works. */
  name: string;
  /** Button text, e.g. "Tabel verwijderen". */
  confirm: string;
  /** Runs after confirming; an error keeps the dialog open and is shown in it. */
  run: () => Promise<Result<void>>;
  done: (ok: boolean) => void;
}

/** Asks before something that cannot be undone: drop or empty a table, drop a database. */
@Injectable({ providedIn: 'root' })
export class ConfirmDangerStore {
  readonly question = signal<DangerQuestion | null>(null);

  /** Resolves true when confirmed and the action succeeded, false when cancelled. */
  ask(question: Omit<DangerQuestion, 'done'>): Promise<boolean> {
    return new Promise((resolve) => {
      this.question.set({
        ...question,
        done: (ok) => {
          this.question.set(null);
          resolve(ok);
        },
      });
    });
  }
}

@Component({
  selector: 'app-confirm-danger',
  template: `
    @if (store.question(); as q) {
      <dialog
        #dialog
        class="dialog"
        aria-labelledby="cd-title"
        aria-describedby="cd-text"
        (cancel)="$event.preventDefault(); !busy() && cancel()"
      >
        <div class="dialog-head">
          <h2 id="cd-title">{{ q.title }}</h2>
        </div>
        <form class="dialog-body" (submit)="$event.preventDefault(); confirm()">
          <p id="cd-text">{{ q.message }} Dit kan niet ongedaan worden gemaakt.</p>
          <pre class="danger-sql mono small">{{ q.sql }}</pre>
          <label class="field">
            <span
              >Typ <strong class="mono">{{ q.name }}</strong> om te bevestigen</span
            >
            <input
              #typed
              class="input mono"
              autocomplete="off"
              spellcheck="false"
              [value]="typedText()"
              [disabled]="busy()"
              (input)="typedText.set(typed.value)"
            />
          </label>
          @if (error(); as e) {
            <div class="banner banner-error" role="alert">
              <strong>{{ e.message }}</strong>
              @if (e.hint) {
                <span class="small">{{ e.hint }}</span>
              }
            </div>
          }
        </form>
        <div class="dialog-foot">
          <div class="foot-end">
            <button type="button" class="btn btn-ghost" [disabled]="busy()" (click)="cancel()">
              Annuleren
            </button>
            <button
              type="button"
              class="btn btn-danger"
              [disabled]="!matches() || busy()"
              (click)="confirm()"
            >
              {{ busy() ? 'Bezig…' : q.confirm }}
            </button>
          </div>
        </div>
      </dialog>
    }
  `,
})
export class ConfirmDanger {
  protected readonly store = inject(ConfirmDangerStore);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('typed');
  protected readonly typedText = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<DbError | null>(null);
  protected readonly matches = computed(
    () => this.typedText().trim() === this.store.question()?.name,
  );

  constructor() {
    // A new question: empty field, modal, focus in the field.
    effect(() => {
      this.store.question();
      untracked(() => {
        this.typedText.set('');
        this.error.set(null);
        this.busy.set(false);
      });
    });
    afterRenderEffect(() => {
      const dialog = this.dialog()?.nativeElement;
      if (dialog && !dialog.open) {
        dialog.showModal();
        this.input()?.nativeElement.focus();
      }
    });
  }

  protected cancel(): void {
    this.dialog()?.nativeElement.close();
    this.store.question()?.done(false);
  }

  protected async confirm(): Promise<void> {
    const q = this.store.question();
    if (!q || !this.matches() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    const result = await q.run();
    this.busy.set(false);
    if (!result.ok) {
      this.error.set(result.error);
      return;
    }
    this.dialog()?.nativeElement.close();
    q.done(true);
  }
}
