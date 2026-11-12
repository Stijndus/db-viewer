import {
  afterRenderEffect,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { KeybindingsStore, type EffectiveBinding } from './keybindings.store';
import { keyOf, label, whenInWords } from './keys';

interface Row {
  command: string;
  title: string;
  category: string;
  binding: EffectiveBinding | null;
}

/**
 * The keyboard shortcuts, like VS Code's editor (Ctrl+K Ctrl+S): search by name or key, change a
 * key by pressing it (two presses for a chord), remove or reset, with a warning for keys in use.
 */
@Component({
  selector: 'app-keybindings-editor',
  template: `
    @if (store.editorOpen()) {
      <dialog
        #dialog
        class="dialog dialog-wide kb-dialog"
        aria-labelledby="kb-title"
        (cancel)="onCancel($event)"
      >
        <div class="dialog-head">
          <h2 id="kb-title">Sneltoetsen</h2>
          <button type="button" class="icon-btn" aria-label="Sluiten" (click)="close()">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.6" />
            </svg>
          </button>
        </div>
        <div class="kb-search">
          <input
            #search
            class="input"
            type="search"
            placeholder="Zoek op opdracht of toets (bijv. ctrl+t of F9)"
            aria-label="Sneltoetsen zoeken"
            [value]="query()"
            (input)="query.set(search.value)"
          />
          <span class="muted small">{{ rows().length }} van {{ allRows().length }}</span>
        </div>
        <div class="kb-table" role="grid" aria-label="Sneltoetsen">
          <div class="kb-row kb-head" role="row">
            <span role="columnheader">Opdracht</span>
            <span role="columnheader">Toets</span>
            <span role="columnheader">Wanneer</span>
            <span role="columnheader">Bron</span>
            <span role="columnheader"><span class="sr-only">Acties</span></span>
          </div>
          @for (row of rows(); track row.command + (row.binding?.key ?? '')) {
            <div
              class="kb-row"
              role="row"
              [class.changed]="row.binding?.source === 'Gebruiker'"
              (dblclick)="record(row)"
            >
              <span role="gridcell" class="kb-cmd">
                {{ row.title }} <span class="muted small">{{ row.category }}</span>
              </span>
              <span role="gridcell">
                @if (row.binding) {
                  <kbd class="kb-key">{{ label(row.binding.key) }}</kbd>
                } @else {
                  <span class="muted">—</span>
                }
              </span>
              <span role="gridcell" class="small muted kb-when" [title]="row.binding?.when ?? ''">{{
                whenInWords(row.binding?.when)
              }}</span>
              <span role="gridcell" class="small muted">{{ row.binding?.source }}</span>
              <span role="gridcell" class="kb-actions">
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  [attr.aria-label]="'Toets wijzigen voor ' + row.title"
                  title="Wijzigen (of dubbelklik)"
                  (click)="record(row)"
                >
                  Wijzigen
                </button>
                @if (row.binding) {
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    title="Nog een toets voor deze opdracht"
                    [attr.aria-label]="'Toets toevoegen voor ' + row.title"
                    (click)="record(row, true)"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    title="Toets verwijderen"
                    [attr.aria-label]="'Toets ' + label(row.binding.key) + ' verwijderen'"
                    (click)="store.removeKey(row.command, row.binding.key)"
                  >
                    ✕
                  </button>
                }
                @if (store.isChanged(row.command)) {
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    title="Terug naar de standaardtoets"
                    [attr.aria-label]="'Standaard herstellen voor ' + row.title"
                    (click)="store.reset(row.command)"
                  >
                    ↺
                  </button>
                }
              </span>
            </div>
          }
        </div>
        <div class="dialog-foot">
          <span class="muted small"
            >Standaard zoals HeidiSQL; Ctrl+Enter, Ctrl+S, zoomen en Ctrl+K Ctrl+T zijn van DB
            Viewer.</span
          >
          <div class="foot-end">
            <button
              type="button"
              class="btn btn-ghost"
              [disabled]="store.user().length === 0"
              (click)="resetAll()"
            >
              Alles herstellen
            </button>
            <button type="button" class="btn btn-primary" (click)="close()">Sluiten</button>
          </div>
        </div>

        @if (recordingFor(); as r) {
          <div class="kb-record" role="alertdialog" aria-labelledby="kb-rec-title">
            <div class="kb-record-box">
              <strong id="kb-rec-title">{{ r.title }}</strong>
              <span class="muted small"
                >Druk de nieuwe toets. Voor een combinatie zoals Ctrl+K Ctrl+T druk je twee keer.
                Enter bevestigt, Esc annuleert.</span
              >
              <kbd class="kb-key kb-big">{{ recorded() ? label(recorded()!) : '…' }}</kbd>
              @if (conflicts().length) {
                <span class="warn-text small"
                  >Al in gebruik voor: {{ conflicts().join(', ') }}. Ze werken allebei waar hun
                  'wanneer' klopt.</span
                >
              }
              <div class="row">
                <button type="button" class="btn btn-ghost btn-sm" (click)="stopRecording()">
                  Annuleren
                </button>
                <button
                  type="button"
                  class="btn btn-primary btn-sm"
                  [disabled]="!recorded()"
                  (click)="confirmRecording()"
                >
                  Opslaan
                </button>
              </div>
            </div>
          </div>
        }
      </dialog>
    }
  `,
  host: { '(document:keydown)': 'onRecordKey($event)' },
})
export class KeybindingsEditor {
  protected readonly store = inject(KeybindingsStore);
  protected readonly label = label;
  protected readonly whenInWords = whenInWords;
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('search');

  protected readonly query = signal('');
  protected readonly recordingFor = signal<(Row & { add: boolean }) | null>(null);
  protected readonly recorded = signal<string | null>(null);
  private recordedAt = 0;

  /** One row per key, and one row for each command without a key. */
  protected readonly allRows = computed<Row[]>(() => {
    const bindings = this.store.bindings();
    return this.store.commands.flatMap((c): Row[] => {
      const own = bindings.filter((b) => b.command === c.id);
      const base = { command: c.id, title: c.title, category: c.category };
      return own.length
        ? own.map((binding) => ({ ...base, binding }))
        : [{ ...base, binding: null }];
    });
  });

  protected readonly rows = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.allRows();
    const asKey = q.replace(/\s*\+\s*/g, '+');
    return this.allRows().filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q) ||
        r.command.toLowerCase().includes(q) ||
        (r.binding &&
          (r.binding.key.includes(asKey) || label(r.binding.key).toLowerCase().includes(q))),
    );
  });

  protected readonly conflicts = computed(() => {
    const key = this.recorded();
    const r = this.recordingFor();
    if (!key || !r) return [];
    return this.store
      .bindings()
      .filter((b) => b.key === key && b.command !== r.command)
      .map((b) => this.store.title(b.command));
  });

  constructor() {
    afterRenderEffect(() => {
      const dialog = this.dialog()?.nativeElement;
      if (dialog && !dialog.open) {
        dialog.showModal();
        this.searchInput()?.nativeElement.focus();
      }
    });
  }

  protected record(row: Row, add = false): void {
    this.recorded.set(null);
    this.recordingFor.set({ ...row, add });
    this.store.recording.set(true);
  }

  protected stopRecording(): void {
    this.recordingFor.set(null);
    this.recorded.set(null);
    this.store.recording.set(false);
  }

  protected confirmRecording(): void {
    const r = this.recordingFor();
    const key = this.recorded();
    if (!r || !key) return;
    const when =
      r.binding?.when ?? this.store.bindings().find((b) => b.command === r.command)?.when;
    this.store.setKey(r.command, key, r.add ? undefined : r.binding?.key, when);
    this.stopRecording();
  }

  /** While recording: every key press becomes (part of) the new key. */
  protected onRecordKey(event: KeyboardEvent): void {
    if (!this.recordingFor()) return;
    event.preventDefault();
    event.stopPropagation();
    const key = keyOf(event);
    if (!key) return;
    if (key === 'escape') return this.stopRecording();
    if (key === 'enter' && this.recorded()) return this.confirmRecording();
    const now = Date.now();
    const previous = this.recorded();
    // A second press shortly after a modifier combination makes a chord (Ctrl+K Ctrl+T).
    if (
      previous &&
      !previous.includes(' ') &&
      now - this.recordedAt < 1500 &&
      previous.includes('+')
    )
      this.recorded.set(`${previous} ${key}`);
    else this.recorded.set(key);
    this.recordedAt = now;
  }

  protected onCancel(event: Event): void {
    event.preventDefault();
    if (this.recordingFor()) return; // Esc while recording only stops recording
    this.close();
  }

  protected resetAll(): void {
    if (confirm('Alle sneltoetsen terugzetten naar de standaard?')) this.store.resetAll();
  }

  protected close(): void {
    this.stopRecording();
    this.dialog()?.nativeElement.close();
    this.store.editorOpen.set(false);
    this.query.set('');
  }
}
