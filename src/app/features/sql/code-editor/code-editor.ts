import {
  afterNextRender,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import {
  cursorMatchingBracket,
  defaultKeymap,
  deleteLine,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
} from '@codemirror/commands';
import {
  MariaSQL,
  MSSQL,
  MySQL,
  PostgreSQL,
  sql,
  SQLite,
  type SQLDialect,
  type SQLNamespace,
} from '@codemirror/lang-sql';
import type { DbType } from '../../../../../shared/models';
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import {
  findNext,
  findPrevious,
  highlightSelectionMatches,
  openSearchPanel,
  searchKeymap,
} from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, Prec } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { ThemeStore } from '../../../core/theme.store';
import type { EditorSnapshot } from '../sql.store';

export type EditorCommand =
  | 'find'
  | 'replace'
  | 'findNext'
  | 'findPrevious'
  | 'deleteLine'
  | 'matchBracket'
  | 'toggleComment'
  | 'upperCase'
  | 'lowerCase'
  | 'clear';

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: t.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation], color: 'var(--syn-operator)' },
  { tag: t.typeName, color: 'var(--syn-type)' },
  { tag: [t.special(t.name), t.quote], color: 'var(--syn-special)' },
]);

const theme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--text)', fontSize: '13px' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
    '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
    '.cm-gutters': {
      backgroundColor: 'var(--editor-gutter)',
      color: 'var(--editor-gutter-text)',
      border: 'none',
      borderRight: '1px solid var(--border)',
    },
    '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--editor-active-line)',
      color: 'var(--text-2)',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--editor-selection) !important',
    },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-matchingBracket': { backgroundColor: 'var(--editor-match)', outline: 'none' },
    '.cm-selectionMatch': { backgroundColor: 'var(--editor-selection-match)' },
    '.cm-placeholder': { color: 'var(--editor-gutter-text)' },
    '.cm-tooltip': {
      backgroundColor: 'var(--panel-2)',
      border: '1px solid var(--border)',
      color: 'var(--text)',
      borderRadius: '6px',
    },
    '.cm-tooltip-autocomplete > ul > li': { fontFamily: 'var(--mono)', padding: '2px 8px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--accent-soft)',
      color: 'var(--text)',
    },
    '.cm-completionDetail': { color: 'var(--text-3)', fontStyle: 'normal', marginLeft: '8px' },
    '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)' },
    '.cm-panels input, .cm-panels button': { fontSize: '12px' },
  },
  // Colours come from the active theme (CSS variables).
);

/** CodeMirror 6 with dialect highlighting, schema-aware autocompletion and run shortcuts. */
@Component({
  selector: 'app-code-editor',
  template: `<div #host class="code-editor"></div>`,
})
export class CodeEditor {
  /** Initial text; later changes come from the user and are reported through `textChange`. */
  readonly text = input('');
  readonly dialect = input<DbType>('mysql');
  readonly mariaDb = input(false);
  /** Tables (and their columns) for autocompletion. */
  readonly completion = input<Record<string, string[]>>({});

  readonly textChange = output<string>();
  /** Ctrl+Enter runs the current statement, Ctrl+Shift+Enter everything. */
  readonly run = output<'current' | 'all'>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly destroyRef = inject(DestroyRef);
  private readonly language = new Compartment();
  /** Light or dark CodeMirror defaults (tooltips, search panel), following the theme. */
  private readonly darkness = new Compartment();
  private readonly themeStore = inject(ThemeStore);
  private view: EditorView | null = null;

  constructor() {
    afterNextRender(() => {
      this.view = new EditorView({
        parent: this.host().nativeElement,
        state: EditorState.create({
          doc: untracked(this.text),
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightActiveLine(),
            history(),
            drawSelection(),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            autocompletion({ icons: false }),
            highlightSelectionMatches(),
            syntaxHighlighting(highlight),
            placeholder('SELECT * FROM …   Ctrl+Enter voert het statement onder de cursor uit'),
            this.language.of(this.sqlLanguage()),
            keymap.of([
              ...closeBracketsKeymap,
              ...defaultKeymap,
              ...searchKeymap,
              ...historyKeymap,
              ...completionKeymap,
              indentWithTab,
            ]),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) this.textChange.emit(u.state.doc.toString());
            }),
            theme,
            this.darkness.of(EditorView.darkTheme.of(untracked(this.themeStore.shown).dark)),
          ],
        }),
      });
      this.destroyRef.onDestroy(() => this.view?.destroy());
    });

    effect(() => {
      const dark = this.themeStore.shown().dark;
      untracked(() =>
        this.view?.dispatch({ effects: this.darkness.reconfigure(EditorView.darkTheme.of(dark)) }),
      );
    });

    // Schema or dialect changed: swap the language config without touching the text.
    effect(() => {
      const config = this.sqlLanguage();
      untracked(() => this.view?.dispatch({ effects: this.language.reconfigure(config) }));
    });
  }

  /** The text and selection, for working out which statement to run. */
  snapshot(): EditorSnapshot {
    const view = this.view;
    if (!view) return { text: this.text(), selectionFrom: 0, selectionTo: 0 };
    const range = view.state.selection.main;
    return { text: view.state.doc.toString(), selectionFrom: range.from, selectionTo: range.to };
  }

  /** Selects a range (e.g. the statement that failed) and scrolls it into view. */
  select(from: number, to: number): void {
    const view = this.view;
    if (!view) return;
    const max = view.state.doc.length;
    view.dispatch({
      selection: EditorSelection.range(Math.min(from, max), Math.min(to, max)),
      scrollIntoView: true,
    });
    view.focus();
  }

  /** An editing command from the keyboard shortcuts (find, delete line, upper case, …). */
  command(name: EditorCommand): boolean {
    const view = this.view;
    if (!view) return false;
    switch (name) {
      case 'find':
        return openSearchPanel(view);
      case 'replace': {
        openSearchPanel(view);
        // The panel has a replace field; put the cursor there.
        setTimeout(() =>
          view.dom.querySelector<HTMLInputElement>('.cm-search input[name="replace"]')?.focus(),
        );
        return true;
      }
      case 'findNext':
        return findNext(view);
      case 'findPrevious':
        return findPrevious(view);
      case 'deleteLine':
        return deleteLine(view);
      case 'matchBracket':
        return cursorMatchingBracket(view);
      case 'toggleComment':
        return toggleComment(view);
      case 'upperCase':
      case 'lowerCase':
        return this.changeCase(view, name === 'upperCase');
      case 'clear':
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } });
        view.focus();
        return true;
    }
  }

  /** The selection, or the word at the cursor, in upper or lower case. */
  private changeCase(view: EditorView, upper: boolean): boolean {
    const state = view.state;
    const changes = state.selection.ranges.map((range) => {
      const r = range.empty ? (state.wordAt(range.head) ?? range) : range;
      const text = state.sliceDoc(r.from, r.to);
      return { from: r.from, to: r.to, insert: upper ? text.toUpperCase() : text.toLowerCase() };
    });
    view.dispatch({ changes });
    return true;
  }

  /** Replaces the selection (or inserts at the cursor) and puts the focus in the editor. */
  insert(text: string): void {
    const view = this.view;
    if (!view) return;
    view.dispatch(view.state.replaceSelection(text));
    view.focus();
  }

  focus(): void {
    this.view?.focus();
  }

  private languageDialect(): SQLDialect {
    switch (this.dialect()) {
      case 'postgres':
        return PostgreSQL;
      case 'mssql':
        return MSSQL;
      case 'sqlite':
        return SQLite;
      default:
        return this.mariaDb() ? MariaSQL : MySQL;
    }
  }

  private sqlLanguage() {
    const namespace: SQLNamespace = {};
    for (const [table, columns] of Object.entries(this.completion())) {
      namespace[table] = columns;
    }
    return sql({
      dialect: this.languageDialect(),
      schema: namespace,
      upperCaseKeywords: true,
    });
  }
}
