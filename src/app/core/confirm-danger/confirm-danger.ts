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
  /**
   * A checkbox that changes what runs (foreign key checks off): its text and explanation, and the
   * statement shown when it is on.
   */
  option?: { label: string; hint: string; sql: string };
  /** Has to be typed over before the button works. */
  name: string;
  /** Button text, e.g. "Tabel verwijderen". */
  confirm: string;
  /** Runs after confirming (with the option on or off); an error keeps the dialog open. */
  run: (option: boolean) => Promise<Result<void>>;
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
          <pre class="danger-sql mono small">{{
            q.option && optionOn() ? q.option.sql : q.sql
          }}</pre>
          @if (q.option; as option) {
            <label class="check danger-option">
              <input
                type="checkbox"
                [checked]="optionOn()"
                [disabled]="busy()"
                (change)="optionOn.set($any($event.target).checked); error.set(null)"
              />
              <span
                >{{ option.label }}
                <span class="muted small danger-option-hint">{{ option.hint }}</span></span
              >
            </label>
          }
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
              @if (q.option && !optionOn() && isForeignKeyError(e)) {
                <span class="small"
                  >Kies <strong>{{ q.option.label }}</strong> hierboven om het toch te doen.</span
                >
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
  protected readonly optionOn = signal(false);
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
        this.optionOn.set(false);
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

  /** The server refused because of a foreign key (MySQL 1451/1701, PostgreSQL 0A000/2BP01). */
  protected isForeignKeyError(e: DbError): boolean {
    return /foreign key/i.test(e.message);
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
    const result = await q.run(this.optionOn());
    this.busy.set(false);
    if (!result.ok) {
      this.error.set(result.error);
      return;
    }
    this.dialog()?.nativeElement.close();
    q.done(true);
  }
}
