import { Component, computed, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import type { StatementResult } from '../../../../../shared/models';
import { ConnectionsStore } from '../../connections/connections.store';
import { DataGrid, type GridColumn } from '../../data/data-grid/data-grid';
import { columnWidth, isNumericType } from '../../data/table-data/table-data';
import { SchemaStore } from '../../schema/schema.store';
import { CodeEditor } from '../code-editor/code-editor';
import { ROW_LIMITS, SqlStore, type RowLimit, type SqlTab } from '../sql.store';

const MIN_PANE = 120;

/** One SQL tab: editor on top, results below, with a draggable divider. */
@Component({
  selector: 'app-sql-panel',
  imports: [CodeEditor, DataGrid],
  templateUrl: './sql-panel.html',
})
export class SqlPanel {
  readonly tab = input.required<SqlTab>();
  readonly connectionId = input.required<string>();

  protected readonly sql = inject(SqlStore);
  private readonly connections = inject(ConnectionsStore);
  private readonly schema = inject(SchemaStore);
  private readonly editor = viewChild(CodeEditor);
  private readonly panel = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly limits = ROW_LIMITS;
  protected readonly editorHeight = signal(260);
  protected readonly note = signal<string | null>(null);
  private noteTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly profile = computed(() =>
    this.connections.connections().find((c) => c.id === this.connectionId()),
  );
  protected readonly mariaDb = computed(() =>
    /mariadb/i.test(this.connections.serverVersions()[this.connectionId()] ?? ''),
  );

  protected readonly databases = computed(() => {
    const state = this.schema.databases(this.connectionId());
    const names = state?.status === 'loaded' ? state.data.filter((d) => !d.system).map((d) => d.name) : [];
    const current = this.tab().database;
    return current && !names.includes(current) ? [current, ...names] : names;
  });

  protected readonly completion = computed(() =>
    this.sql.completionColumns(this.connectionId(), this.tab().database),
  );

  protected readonly results = computed(() => this.tab().result?.results ?? []);
  protected readonly active = computed<StatementResult | null>(
    () => this.results()[this.tab().activeResult] ?? null,
  );

  protected readonly gridColumns = computed<GridColumn[]>(() => {
    const r = this.active();
    if (r?.kind !== 'rows') return [];
    return r.columns.map((c) => ({
      name: c.name,
      type: c.type,
      numeric: isNumericType(c.type),
      width: columnWidth(c.name, c.type),
      primary: false,
      sort: null,
    }));
  });

  /** Statements that ran without a result of their own (a failure stops the rest). */
  protected readonly notRun = computed(() => {
    const ran = this.tab().ran.length;
    const results = this.results();
    const last = results.at(-1);
    return last?.kind === 'error' ? ran - last.index - 1 : 0;
  });

  protected readonly summary = computed(() => {
    const results = this.results();
    if (results.length === 0) return null;
    const ok = results.filter((r) => r.kind !== 'error').length;
    const failed = results.some((r) => r.kind === 'error');
    const statements = this.tab().ran.length;
    const parts = [
      statements === 1 ? '1 statement' : `${statements} statements`,
      failed ? `${ok} gelukt, gestopt bij een fout` : 'gelukt',
    ];
    if (this.tab().totalMs !== null) parts.push(`${this.tab().totalMs} ms`);
    return parts.join(' · ');
  });

  protected resultLabel(r: StatementResult, i: number): string {
    const n = this.results().length > 1 ? `${r.index + 1}` : '';
    const prefix = n ? `${n} · ` : '';
    if (r.kind === 'rows') return `${prefix}${fmt(r.rows.length)}${r.truncated ? '+' : ''} ${r.rows.length === 1 ? 'rij' : 'rijen'}`;
    if (r.kind === 'ok') return `${prefix}${okShort(r)}`;
    return `${prefix}Fout`;
  }

  protected okText(r: StatementResult & { kind: 'ok' }): string {
    const parts = [okShort(r)];
    if (r.insertId) parts.push(`laatste ID ${r.insertId}`);
    if (r.warnings) parts.push(`${r.warnings} ${r.warnings === 1 ? 'waarschuwing' : 'waarschuwingen'}`);
    return parts.join(' · ');
  }

  protected limitLabel(limit: RowLimit): string {
    return limit === null ? 'Geen limiet' : `${fmt(limit)} rijen`;
  }

  protected run(mode: 'current' | 'all'): void {
    const editor = this.editor();
    if (!editor) return;
    void this.sql.run(this.connectionId(), this.tab().id, mode, editor.snapshot());
  }

  protected stop(): void {
    void this.sql.cancel(this.connectionId(), this.tab().id);
  }

  /** Selects the statement of a result in the editor, e.g. the one that failed. */
  protected showInEditor(index: number): void {
    const statement = this.tab().ran[index];
    if (statement) this.editor()?.select(statement.from, statement.to);
  }

  protected setDatabase(value: string): void {
    this.sql.setDatabase(this.connectionId(), this.tab().id, value || null);
  }

  protected setLimit(value: string): void {
    this.sql.setMaxRows(this.connectionId(), this.tab().id, value === 'none' ? null : (Number(value) as RowLimit));
  }

  protected onCopied(text: string): void {
    this.note.set(`Gekopieerd: ${text.length > 40 ? text.slice(0, 40) + '…' : text}`);
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => this.note.set(null), 2500);
  }

  /** Drag the divider between editor and results. */
  protected startResize(event: PointerEvent): void {
    event.preventDefault();
    const handle = event.target as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = this.editorHeight();
    const total = this.panel.nativeElement.clientHeight;
    const move = (e: PointerEvent) => {
      const next = startHeight + e.clientY - startY;
      this.editorHeight.set(Math.max(MIN_PANE, Math.min(total - MIN_PANE - 80, next)));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }

  protected resizeWithKeys(event: KeyboardEvent): void {
    const step = event.key === 'ArrowUp' ? -24 : event.key === 'ArrowDown' ? 24 : 0;
    if (!step) return;
    event.preventDefault();
    this.editorHeight.update((h) => Math.max(MIN_PANE, h + step));
  }
}

function okShort(r: StatementResult & { kind: 'ok' }): string {
  const keyword = r.sql.trimStart().split(/\s+/)[0]?.toUpperCase() ?? '';
  if (['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(keyword)) {
    return `${fmt(r.affectedRows)} ${r.affectedRows === 1 ? 'rij' : 'rijen'} ${keyword === 'INSERT' || keyword === 'REPLACE' ? 'toegevoegd' : keyword === 'DELETE' ? 'verwijderd' : 'gewijzigd'}`;
  }
  return 'OK';
}

function fmt(n: number): string {
  return new Intl.NumberFormat('nl-NL').format(n);
}
