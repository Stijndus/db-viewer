import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { highlight, theme } from '../../sql/code-editor/code-editor';

/** What the popup edits: a value of one cell. */
export interface CellEditorRequest {
  column: string;
  type: string;
  /** null is SQL NULL. */
  value: string | null;
  /** The column holds JSON (json, jsonb): invalid JSON cannot be saved. */
  jsonColumn: boolean;
  readOnly: boolean;
  /** Only the start of the value is known (query results): shown, not editable. */
  partOf?: number;
}

/** Where a JSON text is invalid, for the status line; null when it parses. */
export function jsonProblem(text: string): { message: string; line: number; col: number } | null {
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // V8: "… in JSON at position 12 (line 2 column 5)" or "… at position 12".
    const lineCol = /line (\d+) column (\d+)/.exec(message);
    if (lineCol)
      return { message: cleanJsonMessage(message), line: +lineCol[1]!, col: +lineCol[2]! };
    const at = /position (\d+)/.exec(message);
    const pos = at ? Number(at[1]) : text.length;
    const before = text.slice(0, pos).split('\n');
    return {
      message: cleanJsonMessage(message),
      line: before.length,
      col: (before.at(-1)?.length ?? 0) + 1,
    };
  }
}

/** The parser's message in Dutch, without the position (the status line gives line and column). */
function cleanJsonMessage(message: string): string {
  const m = message
    .replace(/\s*\(line \d+ column \d+\)/, '')
    .replace(/,? (in JSON )?at position \d+/, '');
  const token = /Unexpected token '(.+?)'/.exec(m);
  if (/Unexpected end of JSON input/.test(m)) return 'de JSON houdt te vroeg op';
  if (/Unexpected non-whitespace character after JSON/.test(m))
    return 'er staat nog iets na het einde van de JSON';
  if (/Expected property name or '\}'/.test(m))
    return 'verwacht een naam tussen "aanhalingstekens" of }';
  if (/Expected ',' or '\}' after property value/.test(m)) return 'verwacht , of } na de waarde';
  if (/Expected ',' or '\]' after array element/.test(m)) return 'verwacht , of ] na het element';
  if (/Expected ':' after property name/.test(m)) return 'verwacht : na de naam';
  if (/Expected double-quoted property name/.test(m))
    return 'namen moeten tussen "dubbele aanhalingstekens" (en geen komma voor })';
  if (/Bad control character in string literal/.test(m))
    return 'een tab of nieuwe regel binnen een tekst moet als \\t of \\n';
  if (/Unterminated string/.test(m)) return 'een tekst wordt niet afgesloten met "';
  if (token) return `onverwacht teken ${token[1]}`;
  return m;
}

/** A value that looks like JSON: an object or array (scalars are left as text). */
export function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return (
    ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) &&
    jsonProblem(t) === null
  );
}

export function formatJson(text: string): string {
  return JSON.stringify(JSON.parse(text), null, 2);
}

export function compactJson(text: string): string {
  return JSON.stringify(JSON.parse(text));
}

/**
 * A large editor for one cell, like HeidiSQL's text editor, with JSON support: highlighting,
 * format and compact, and a status line that says where invalid JSON goes wrong.
 */
@Component({
  selector: 'app-cell-editor',
  template: `
    @let r = request();
    <dialog
      #dialog
      class="dialog cell-editor"
      aria-labelledby="ce-title"
      (cancel)="$event.preventDefault(); cancel()"
      (keydown)="onKeydown($event)"
    >
      <div class="dialog-head">
        <h2 id="ce-title">
          <span class="mono">{{ r.column }}</span>
          <span class="muted small mono">{{ r.type }}</span>
        </h2>
        <div class="ce-tools">
          @if (isJson()) {
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              [disabled]="r.readOnly || !!problem()"
              title="JSON netjes inspringen"
              (click)="reformat(true)"
            >
              Opmaken
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              [disabled]="r.readOnly || !!problem()"
              title="JSON op één regel"
              (click)="reformat(false)"
            >
              Compact
            </button>
          }
          <label class="check small">
            <input
              type="checkbox"
              [checked]="wrap()"
              (change)="setWrap($any($event.target).checked)"
            />
            Regels afbreken
          </label>
        </div>
      </div>
      <div class="ce-body">
        @if (isNull()) {
          <div class="ce-null">
            <span class="muted">NULL</span>
            @if (!r.readOnly) {
              <button type="button" class="btn btn-ghost btn-sm" (click)="fromNull()">
                Waarde invullen
              </button>
            }
          </div>
        }
        <div #host class="ce-editor" [hidden]="isNull()"></div>
      </div>
      <div class="ce-status small" aria-live="polite">
        @if (r.partOf !== undefined) {
          <span class="warn-text"
            >Ingekort: de eerste {{ fmt(length()) }} van {{ fmt(r.partOf) }} tekens</span
          >
        }
        @if (isJson() && !isNull()) {
          @if (problem(); as p) {
            <button type="button" class="link-btn small err-text" (click)="goTo(p.line, p.col)">
              Ongeldige JSON, regel {{ p.line }}, kolom {{ p.col }}: {{ p.message }}
            </button>
          } @else {
            <span class="ok-text">Geldige JSON</span>
          }
        }
        <span class="push"></span>
        @if (!isNull()) {
          <span class="muted"
            >{{ fmt(length()) }} tekens · {{ fmt(lines()) }}
            {{ lines() === 1 ? 'regel' : 'regels' }}</span
          >
        }
      </div>
      <div class="dialog-foot">
        @if (!r.readOnly) {
          <button
            type="button"
            class="btn btn-ghost"
            [disabled]="isNull()"
            title="De cel op NULL zetten"
            (click)="setNull()"
          >
            NULL
          </button>
        }
        <div class="foot-end">
          <button type="button" class="btn btn-ghost" (click)="copy()">Kopiëren</button>
          @if (r.readOnly) {
            <button type="button" class="btn btn-primary" (click)="cancel()">Sluiten</button>
          } @else {
            <button type="button" class="btn btn-ghost" (click)="cancel()">Annuleren</button>
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="!canSave()"
              [title]="
                blockedByJson()
                  ? 'Deze kolom accepteert alleen geldige JSON'
                  : 'Opslaan in de cel (Ctrl+Enter)'
              "
              (click)="save()"
            >
              Toepassen
            </button>
          }
        </div>
      </div>
    </dialog>
  `,
})
export class CellEditor {
  readonly request = input.required<CellEditorRequest>();
  /** The new value (null for NULL); not emitted when nothing changed. */
  readonly saved = output<string | null>();
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private view: EditorView | null = null;
  private readonly wrapping = new Compartment();
  private readonly editable = new Compartment();
  private readonly language = new Compartment();

  protected readonly text = signal('');
  protected readonly isNull = signal(false);
  protected readonly wrap = signal(true);
  /** What the editor started with: unchanged means nothing is saved (also after formatting). */
  private startText = '';

  protected readonly isJson = computed(
    () => this.request().jsonColumn || looksLikeJson(this.startTextSignal()),
  );
  private readonly startTextSignal = signal('');
  protected readonly problem = computed(() =>
    this.isJson() && !this.isNull() && this.text().trim() !== '' ? jsonProblem(this.text()) : null,
  );
  protected readonly blockedByJson = computed(
    () => this.request().jsonColumn && !this.isNull() && this.problem() !== null,
  );
  protected readonly length = computed(() => this.text().length);
  protected readonly lines = computed(() => this.text().split('\n').length);
  protected readonly canSave = computed(() => !this.request().readOnly && !this.blockedByJson());

  constructor() {
    afterNextRender(() => this.open());
    inject(DestroyRef).onDestroy(() => this.view?.destroy());
  }

  private open(): void {
    const r = this.request();
    let start = r.value ?? '';
    // A JSON column shows its value indented; saving it unchanged writes nothing.
    if (r.jsonColumn && start && jsonProblem(start) === null) start = formatJson(start);
    this.startText = start;
    this.startTextSignal.set(r.value ?? '');
    this.text.set(start);
    this.isNull.set(r.value === null);
    this.view = new EditorView({
      parent: this.host().nativeElement,
      state: EditorState.create({
        doc: start,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          search({ top: true }),
          syntaxHighlighting(highlight),
          theme,
          this.language.of(this.isJson() ? json() : []),
          this.wrapping.of(EditorView.lineWrapping),
          this.editable.of([
            EditorState.readOnly.of(r.readOnly || r.partOf !== undefined),
            EditorView.editable.of(!(r.readOnly || r.partOf !== undefined)),
          ]),
          Prec.high(
            keymap.of([
              { key: 'Mod-Enter', run: () => (this.save(), true) },
              { key: 'Mod-s', run: () => (this.save(), true) },
              { key: 'Shift-Alt-f', run: () => (this.reformat(true), true) },
            ]),
          ),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) this.text.set(u.state.doc.toString());
          }),
        ],
      }),
    });
    this.dialog().nativeElement.showModal();
    if (r.value !== null) this.view.focus();
  }

  /** Ctrl+Enter / Ctrl+S apply from anywhere in the dialog, also after clicking a button. */
  protected onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && (event.key === 'Enter' || event.key === 's')) {
      event.preventDefault();
      event.stopPropagation();
      this.save();
    }
  }

  protected fmt(n: number): string {
    return n.toLocaleString('nl-NL');
  }

  protected setWrap(on: boolean): void {
    this.wrap.set(on);
    this.view?.dispatch({ effects: this.wrapping.reconfigure(on ? EditorView.lineWrapping : []) });
  }

  protected reformat(pretty: boolean): void {
    if (!this.view || this.problem() || this.request().readOnly) return;
    const text = this.view.state.doc.toString();
    if (!text.trim()) return;
    const next = pretty ? formatJson(text) : compactJson(text);
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: next } });
    this.view.focus();
  }

  protected goTo(line: number, col: number): void {
    const view = this.view;
    if (!view) return;
    const l = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
    const pos = Math.min(l.from + col - 1, l.to);
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  }

  protected fromNull(): void {
    this.isNull.set(false);
    setTimeout(() => this.view?.focus());
  }

  protected setNull(): void {
    if (this.request().readOnly) return;
    this.isNull.set(true);
    this.close(null);
  }

  protected copy(): void {
    void navigator.clipboard.writeText(this.isNull() ? 'NULL' : this.text());
  }

  protected save(): void {
    if (!this.canSave()) return;
    if (this.isNull()) {
      this.close(this.request().value === null ? undefined : null);
      return;
    }
    const text = this.text();
    this.close(text === this.startText && this.request().value !== null ? undefined : text);
  }

  protected cancel(): void {
    const changed = !this.request().readOnly && this.text() !== this.startText;
    if (changed && !confirm('Je wijzigingen in deze cel weggooien?')) return;
    this.close(undefined);
  }

  /** undefined: nothing to save. */
  private close(value: string | null | undefined): void {
    this.dialog().nativeElement.close();
    if (value !== undefined) this.saved.emit(value);
    this.closed.emit();
  }
}
