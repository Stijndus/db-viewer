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
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
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
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
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
import type { EditorSnapshot } from '../sql.store';

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: '#8cc4ff', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: '#9fdba8' },
  { tag: [t.number, t.bool, t.null], color: '#f0c674' },
  { tag: t.comment, color: '#808894', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation], color: '#a3abb6' },
  { tag: t.typeName, color: '#c3a6ff' },
  { tag: [t.special(t.name), t.quote], color: '#e7a6c8' },
]);

const theme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: '#0e1014', color: '#e7e9ec', fontSize: '13px' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
    '.cm-content': { caretColor: '#5aa9ff', padding: '8px 0' },
    '.cm-gutters': {
      backgroundColor: '#121419',
      color: '#5c6470',
      border: 'none',
      borderRight: '1px solid #2a2f38',
    },
    '.cm-activeLine': { backgroundColor: '#151a22' },
    '.cm-activeLineGutter': { backgroundColor: '#151a22', color: '#a3abb6' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: '#264a75 !important',
    },
    '.cm-cursor': { borderLeftColor: '#5aa9ff' },
    '.cm-matchingBracket': { backgroundColor: '#2a3a52', outline: 'none' },
    '.cm-selectionMatch': { backgroundColor: '#22303f' },
    '.cm-placeholder': { color: '#5c6470' },
    '.cm-tooltip': { backgroundColor: '#1b1f26', border: '1px solid #2a2f38', borderRadius: '6px' },
    '.cm-tooltip-autocomplete > ul > li': { fontFamily: 'var(--mono)', padding: '2px 8px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: '#1f2e44',
      color: '#e7e9ec',
    },
    '.cm-completionDetail': { color: '#808894', fontStyle: 'normal', marginLeft: '8px' },
    '.cm-panels': { backgroundColor: '#15181e', color: '#e7e9ec' },
    '.cm-panels input, .cm-panels button': { fontSize: '12px' },
  },
  { dark: true },
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
            Prec.highest(
              keymap.of([
                { key: 'Mod-Enter', run: () => (this.run.emit('current'), true) },
                { key: 'Shift-Mod-Enter', run: () => (this.run.emit('all'), true) },
              ]),
            ),
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
          ],
        }),
      });
      this.destroyRef.onDestroy(() => this.view?.destroy());
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
