import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { DbApi } from '../../../../../shared/ipc-contract';
import type { ColumnInfo, RowsRequest } from '../../../../../shared/models';
import { DB_API } from '../../../core/db-api';
import { COLUMNS, fakeDbApi, fakeRows, PROFILE } from '../../../testing/fake-db-api';
import {
  ContextMenuStore,
  type MenuAction,
  type MenuSubmenu,
} from '../../../core/context-menu/context-menu.store';
import { SchemaStore, type Load, type SelectedObject } from '../../schema/schema.store';
import { columnWidth, isNumericType, TableData } from './table-data';

@Component({
  imports: [TableData],
  template: `<app-table-data [object]="object()" [columns]="columns()" [estimate]="1200" />`,
})
class Host {
  readonly object = signal<SelectedObject>({
    connectionId: PROFILE.id,
    database: 'app_dev',
    name: 'customers',
    kind: 'table',
  });
  readonly columns = signal<Load<ColumnInfo[]> | undefined>({ status: 'loaded', data: COLUMNS });
}

async function setup(overrides: Partial<DbApi> = {}) {
  const requests: RowsRequest[] = [];
  const api = fakeDbApi(overrides);
  const recorded: DbApi = {
    ...api,
    readRows: (...args) => {
      requests.push(args[3]);
      return api.readRows(...args);
    },
  };
  TestBed.configureTestingModule({ providers: [{ provide: DB_API, useValue: recorded }] });
  try {
    localStorage.removeItem('dbv.pageSize');
  } catch {
    /* no storage */
  }
  const fixture = TestBed.createComponent(Host);
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      fixture.detectChanges();
    }
  };
  await settle();
  const button = (label: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
    )!;
  const foot = () => el.querySelector('.dt-foot')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  return { fixture, el, requests, settle, button, foot };
}

describe('TableData', () => {
  it('loads the first page in primary key order', async () => {
    const { el, requests, foot } = await setup();
    expect(requests[0]).toEqual({
      offset: 0,
      limit: 200,
      orderBy: [{ column: 'id', direction: 'asc' }],
      where: undefined,
    });
    expect(foot()).toContain('Rijen 1–200 van ≈ 1.200');
    expect(foot()).toContain('Op primaire sleutel (id ↑)');
    expect(el.querySelector('.dg-th')?.textContent).toContain('id');
  });

  it('renders only the rows in view, not the whole page', async () => {
    const { el } = await setup();
    const rendered = el.querySelectorAll('.dg-row').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(200);
  });

  it('pages forward and back, and stops at the end', async () => {
    const { requests, settle, button, foot } = await setup();
    button('Volgende pagina').click();
    await settle();
    expect(requests.at(-1)?.offset).toBe(200);
    expect(foot()).toContain('Rijen 201–400');
    expect(foot()).toContain('Pagina 2');

    button('Volgende pagina').click();
    await settle();
    expect(foot()).toContain('Rijen 401–450');
    expect(button('Volgende pagina').disabled).toBe(true);

    button('Vorige pagina').click();
    await settle();
    expect(requests.at(-1)?.offset).toBe(200);
  });

  it('cycles sort asc, desc, back to primary key, starting at page 1', async () => {
    const { el, requests, settle, button } = await setup();
    button('Volgende pagina').click();
    await settle();

    const header = () => el.querySelectorAll<HTMLButtonElement>('.dg-th')[1]!;
    header().click();
    await settle();
    expect(requests.at(-1)).toMatchObject({
      offset: 0,
      orderBy: [{ column: 'email', direction: 'asc' }],
    });
    expect(header().getAttribute('aria-sort')).toBe('ascending');

    header().click();
    await settle();
    expect(requests.at(-1)?.orderBy).toEqual([{ column: 'email', direction: 'desc' }]);

    header().click();
    await settle();
    expect(requests.at(-1)?.orderBy).toEqual([{ column: 'id', direction: 'asc' }]);
    expect(header().getAttribute('aria-sort')).toBeNull();
  });

  it('applies and clears a filter', async () => {
    const { el, requests, settle, button, foot } = await setup();
    const input = el.querySelector<HTMLInputElement>('.dt-where')!;
    input.value = "status = 'open'";
    input.dispatchEvent(new Event('input'));
    el.querySelector<HTMLFormElement>('.dt-toolbar')!.dispatchEvent(new Event('submit'));
    await settle();
    expect(requests.at(-1)?.where).toBe("status = 'open'");
    // With a filter the table estimate no longer applies.
    expect(foot()).not.toContain('≈');

    button('Exact tellen').click();
    await settle();
    expect(foot()).toContain('van 225');

    button('Wissen').click();
    await settle();
    expect(requests.at(-1)?.where).toBeUndefined();
    expect(input.value).toBe('');
  });

  it('shows a filter error from the server with its hint', async () => {
    const { el } = await setup({
      readRows: async () => ({
        ok: false,
        error: {
          code: 'ER_BAD_FIELD_ERROR',
          message: 'Onbekende kolom in het filter.',
          hint: "Unknown column 'x'",
        },
      }),
    });
    expect(el.querySelector('.banner-error')?.textContent).toContain(
      'Onbekende kolom in het filter.',
    );
    expect(el.querySelector('.banner-error')?.textContent).toContain("Unknown column 'x'");
  });

  it('shows an empty state', async () => {
    const { el } = await setup({
      readRows: async () => ({
        ok: true,
        data: { columns: ['id'], rows: [], hasMore: false, durationMs: 1 },
      }),
    });
    expect(el.querySelector('.dt-empty')?.textContent).toContain('Deze tabel is leeg.');
  });

  it('starts over when another table is selected', async () => {
    const { fixture, requests, settle, button } = await setup();
    button('Volgende pagina').click();
    await settle();
    fixture.componentInstance.object.set({
      connectionId: PROFILE.id,
      database: 'app_dev',
      name: 'orders',
      kind: 'table',
    });
    await settle();
    expect(requests.at(-1)?.offset).toBe(0);
  });

  it('waits for column metadata before the first load', async () => {
    const { fixture, requests, settle } = await setup();
    const before = requests.length;
    fixture.componentInstance.object.set({
      connectionId: PROFILE.id,
      database: 'app_dev',
      name: 'x',
      kind: 'table',
    });
    fixture.componentInstance.columns.set({ status: 'loading' });
    await settle();
    expect(requests.length).toBe(before);
    fixture.componentInstance.columns.set({ status: 'loaded', data: COLUMNS });
    await settle();
    expect(requests.length).toBe(before + 1);
  });
});

describe('column helpers', () => {
  it('recognises numeric types for right alignment', () => {
    expect(isNumericType('int(11)')).toBe(true);
    expect(isNumericType('bigint unsigned')).toBe(true);
    expect(isNumericType('decimal(10,2)')).toBe(true);
    expect(isNumericType('varchar(20)')).toBe(false);
    expect(isNumericType('datetime')).toBe(false);
  });

  it('sizes columns by type, never narrower than the name', () => {
    expect(columnWidth('id', 'int(11)')).toBe(96);
    expect(columnWidth('created_at', 'datetime')).toBe(170);
    expect(columnWidth('body', 'longtext')).toBe(320);
    expect(columnWidth('a_very_long_column_name', 'int')).toBeGreaterThan(96);
  });

  it('fake rows behave like the server (sanity check of the test double)', () => {
    expect(fakeRows({ offset: 440, limit: 200, orderBy: [] }).rows).toHaveLength(10);
  });
});

describe('TableData editing', () => {
  async function editable(overrides: Partial<DbApi> = {}) {
    const applied: Parameters<DbApi['applyChanges']>[3][] = [];
    const ctx = await setup({
      ...overrides,
      applyChanges: async (_c, _d, _t, changes) => {
        applied.push(changes);
        return overrides.applyChanges
          ? overrides.applyChanges(_c, _d, _t, changes)
          : {
              ok: true,
              data: {
                deleted: changes.deletes.length,
                updated: changes.updates.length,
                inserted: changes.inserts.length,
              },
            };
      },
    });
    const cell = (row: number, col: number) =>
      ctx.el.querySelectorAll('.dg-row')[row]!.querySelectorAll<HTMLElement>('.dg-cell')[col]!;
    const edit = async (row: number, col: number, value: string) => {
      cell(row, col).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await ctx.settle();
      const input = ctx.el.querySelector<HTMLInputElement>('.dg-input')!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await ctx.settle();
    };
    return { ...ctx, applied, cell, edit };
  }

  it('marks an edited cell and saves it as one UPDATE by primary key', async () => {
    const { el, applied, cell, edit, button, settle, requests } = await editable();
    await edit(0, 1, 'nieuw@example.com');
    expect(cell(0, 1).textContent?.trim()).toBe('nieuw@example.com');
    expect(cell(0, 1).classList).toContain('edited');
    expect(el.querySelector('.change-count')?.textContent).toContain('1 wijziging');

    const before = requests.length;
    button('Opslaan').click();
    await settle();
    expect(applied[0]).toEqual({
      primaryKey: ['id'],
      deletes: [],
      updates: [{ key: { id: '1' }, values: { email: 'nieuw@example.com' } }],
      inserts: [],
    });
    // Reloaded afterwards, without pending changes.
    expect(requests.length).toBe(before + 1);
    expect(el.querySelector('.change-count')).toBeNull();
    expect(el.querySelector('.dt-note')?.textContent).toContain('1 gewijzigd');
  });

  it('typing the original value back removes the change', async () => {
    const { el, edit } = await editable();
    await edit(0, 1, 'x');
    await edit(0, 1, 'user1@example.com');
    expect(el.querySelector('.change-count')).toBeNull();
  });

  it('adds a row with defaults, deletes and restores a row', async () => {
    const { el, button, settle, cell, edit, applied } = await editable({
      readRows: async (_c, _d, _t, req) => ({
        ok: true,
        data: { ...fakeRows(req), rows: fakeRows(req).rows.slice(0, 3), hasMore: false },
      }),
    });
    button('Rij toevoegen').click();
    await settle();
    const rows = el.querySelectorAll('.dg-row');
    expect(rows).toHaveLength(4);
    expect(rows[3]!.classList).toContain('is-new');
    expect(cell(3, 0).textContent?.trim()).toBe('DEFAULT');
    await edit(3, 1, 'nieuw@x.nl');

    cell(1, 0).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await settle();
    button('Rij verwijderen').click();
    await settle();
    expect(el.querySelectorAll('.dg-row')[1]!.classList).toContain('is-deleted');
    button('Rij herstellen').click();
    await settle();
    expect(el.querySelectorAll('.dg-row')[1]!.classList).not.toContain('is-deleted');
    button('Rij verwijderen').click();
    await settle();

    button('Opslaan').click();
    await settle();
    expect(applied[0]).toEqual({
      primaryKey: ['id'],
      deletes: [{ key: { id: '2' } }],
      updates: [],
      inserts: [{ values: { email: 'nieuw@x.nl' } }],
    });
  });

  it('sets NULL from the toolbar and shows the SQL before saving', async () => {
    const { el, button, settle, cell, fixture } = await editable();
    // The toolbar NULL is only offered for nullable columns.
    fixture.componentInstance.columns.set({
      status: 'loaded',
      data: COLUMNS.map((c) => (c.name === 'status' ? { ...c, nullable: true } : c)),
    });
    await settle();
    cell(0, 2).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await settle();
    button('NULL').click();
    await settle();
    expect(cell(0, 2).textContent?.trim()).toBe('NULL');
    expect(el.querySelector('.sql-preview')?.textContent).toBe(
      "UPDATE `app_dev`.`customers` SET `status` = NULL WHERE `id` = '1' LIMIT 1;",
    );
  });

  it('keeps the edits and shows the error when saving fails', async () => {
    const { el, edit, button, settle } = await editable({
      applyChanges: async () => ({
        ok: false,
        error: {
          code: 'ROW_CHANGED',
          message: 'Een rij is intussen gewijzigd of verwijderd.',
          hint: 'Er is niets opgeslagen.',
        },
      }),
    });
    await edit(0, 1, 'x');
    button('Opslaan').click();
    await settle();
    expect(el.querySelector('.banner-error')?.textContent).toContain('intussen gewijzigd');
    expect(el.querySelector('.change-count')?.textContent).toContain('1 wijziging');
  });

  it('asks before throwing edits away, and stays when the answer is no', async () => {
    const { edit, button, settle, requests } = await editable();
    await edit(0, 1, 'x');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const before = requests.length;
    button('Volgende pagina').click();
    await settle();
    expect(confirmSpy).toHaveBeenCalled();
    expect(requests.length).toBe(before);
    confirmSpy.mockReturnValue(true);
    button('Volgende pagina').click();
    await settle();
    expect(requests.at(-1)?.offset).toBe(200);
    confirmSpy.mockRestore();
  });

  it('explains why a view or a table without key is read-only', async () => {
    const { fixture, el, settle } = await setup();
    fixture.componentInstance.object.set({
      connectionId: PROFILE.id,
      database: 'app_dev',
      name: 'v',
      kind: 'view',
    });
    await settle();
    expect(el.querySelector('.dt-locked')?.textContent).toContain('Views zijn alleen-lezen');
    fixture.componentInstance.object.set({
      connectionId: PROFILE.id,
      database: 'app_dev',
      name: 'nopk',
      kind: 'table',
    });
    fixture.componentInstance.columns.set({
      status: 'loaded',
      data: COLUMNS.map((c) => ({ ...c, key: null })),
    });
    await settle();
    expect(el.querySelector('.dt-locked')?.textContent).toContain('Geen primaire sleutel');
    expect(el.querySelector('.dg-row')).not.toBeNull();
  });
});

describe('TableData grid extras', () => {
  const EXTRA_COLUMNS: ColumnInfo[] = [
    COLUMNS[0]!,
    { ...COLUMNS[1]!, name: 'note', type: 'text', key: '' as ColumnInfo['key'] },
    { ...COLUMNS[1]!, name: 'data', type: 'json', key: '' as ColumnInfo['key'] },
    { ...COLUMNS[1]!, name: 'seen_at', type: 'datetime', key: '' as ColumnInfo['key'] },
  ];
  const LONG = 'x'.repeat(2000);

  async function extras(overrides: Partial<DbApi> = {}) {
    localStorage.clear();
    // jsdom has no <dialog> methods, and CodeMirror measures text it cannot lay out.
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
    Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect ??= () => new DOMRect();
    const reads: unknown[] = [];
    const ctx = await setup({
      readRows: () =>
        Promise.resolve({
          ok: true,
          data: {
            columns: ['id', 'note', 'data', 'seen_at'],
            rows: [
              ['1', 'kort', '{"a":1,"b":[1,2]}', null],
              ['2', { kind: 'truncated', text: LONG, length: 5000 }, null, '2026-01-02 03:04:05'],
            ],
            hasMore: false,
            durationMs: 1,
          },
        }),
      readCellText: (_id, cell) => {
        reads.push(cell);
        return Promise.resolve({ ok: true, data: 'y'.repeat(5000) });
      },
      applyChanges: () =>
        Promise.resolve({ ok: true, data: { deleted: 0, updated: 1, inserted: 0 } }),
      ...overrides,
    });
    ctx.fixture.componentInstance.columns.set({ status: 'loaded', data: EXTRA_COLUMNS });
    ctx.fixture.componentInstance.object.set({
      connectionId: PROFILE.id,
      database: 'app_dev',
      name: 'notes',
      kind: 'table',
    });
    await ctx.settle();
    await ctx.settle();
    const cell = (row: number, col: number) =>
      ctx.el.querySelectorAll('.dg-row')[row]!.querySelectorAll<HTMLElement>('.dg-cell')[col]!;
    const dbl = async (row: number, col: number) => {
      cell(row, col).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await ctx.settle();
      await new Promise((r) => setTimeout(r));
      await ctx.settle();
    };
    return { ...ctx, cell, dbl, reads };
  }

  it('colours values by their type, NULL keeps its own look', async () => {
    const { cell } = await extras();
    expect(cell(0, 0).classList).toContain('t-number');
    expect(cell(0, 1).classList).toContain('t-text');
    expect(cell(0, 2).classList).toContain('t-json');
    expect(cell(1, 3).classList).toContain('t-datetime');
    expect(cell(0, 3).classList).toContain('is-null');
    expect(cell(0, 3).classList).not.toContain('t-datetime');
  });

  it('fills in the current time when a NULL date is double-clicked', async () => {
    const { el, dbl, cell, settle } = await extras();
    await dbl(0, 3);
    const input = el.querySelector<HTMLInputElement>('.dg-input')!;
    expect(input.value).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(input.value.slice(0, 4)).toBe(String(new Date().getFullYear()));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(cell(0, 3).classList).toContain('edited');
    // A date that has a value is edited as it is.
    await dbl(1, 3);
    expect(el.querySelector<HTMLInputElement>('.dg-input')!.value).toBe('2026-01-02 03:04:05');
  });

  it('opens JSON in the cell editor, indented, and saves nothing when unchanged', async () => {
    const { el, dbl, cell } = await extras();
    await dbl(0, 2);
    const dialog = el.querySelector('app-cell-editor dialog')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain('Geldige JSON');
    expect(el.querySelector('.cm-content')?.textContent).toContain('"a": 1');
    const apply = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Toepassen',
    )!;
    apply.click();
    await new Promise((r) => setTimeout(r));
    expect(el.querySelector('app-cell-editor')).toBeNull();
    expect(cell(0, 2).classList).not.toContain('edited');
  });

  it('loads a cut-off value in full by key before editing it', async () => {
    const { el, dbl, reads } = await extras();
    await dbl(1, 1);
    await vi.waitFor(() => expect(el.querySelector('app-cell-editor dialog')).not.toBeNull());
    expect(reads).toEqual([
      { database: 'app_dev', table: 'notes', keyColumns: ['id'], keyValues: ['2'], column: 'note' },
    ]);
    expect(el.querySelector('.ce-status')?.textContent).toContain('5.000 tekens');
    expect(el.querySelector('.ce-status')?.textContent).not.toContain('Ingekort');
  });

  it('resizes a column by dragging its border and remembers it per table', async () => {
    const { el, settle } = await extras();
    const head = () => el.querySelector<HTMLElement>('.dg-head')!.style.gridTemplateColumns;
    const before = head().split(' ');
    const handle = el.querySelectorAll<HTMLElement>('.dg-resize')[1]!;
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, clientX: 100, bubbles: true }),
    );
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 160, bubbles: true }));
    handle.dispatchEvent(new PointerEvent('pointerup', { clientX: 160, bubbles: true }));
    await settle();
    const after = head().split(' ');
    expect(parseInt(after[2]!)).toBe(parseInt(before[2]!) + 60);
    const stored = JSON.parse(localStorage.getItem('dbv.columnWidths')!) as Record<string, unknown>;
    expect(stored[`${PROFILE.id}/app_dev/notes`]).toEqual({ note: parseInt(before[2]!) + 60 });

    // Double-click fits the column to its content.
    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    expect(parseInt(head().split(' ')[2]!)).not.toBe(parseInt(after[2]!));
  });

  it('marks the rows of the selection and selects by dragging, like Explorer', async () => {
    const { el, cell, settle } = await extras();
    const rows = () =>
      Array.from(el.querySelectorAll('.dg-row')).map((r) => r.classList.contains('row-active'));
    cell(0, 1).dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, bubbles: true }));
    await settle();
    expect(rows()).toEqual([true, false]);
    // jsdom lays nothing out: the body starts at 0,0; row 2 is at y 30–60, column 2 after
    // the row numbers (64) and the first two columns.
    const widths = el
      .querySelector<HTMLElement>('.dg-head')!
      .style.gridTemplateColumns.split(' ')
      .map((w) => parseInt(w));
    const x = widths[0]! + widths[1]! + widths[2]! + 5;
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: 45, buttons: 1 }));
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    await settle();
    expect(rows()).toEqual([true, true]);
    const inRange = Array.from(el.querySelectorAll('.dg-cell.in-range, .dg-cell.selected')).length;
    expect(inRange).toBe(4); // 2 rows × 2 columns
    // After the button is up, moving no longer changes anything.
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1, clientY: 1, buttons: 0 }));
    await settle();
    expect(rows()).toEqual([true, true]);
  });
});

describe('TableData foreign keys', () => {
  it('follows a key from a value to the linked row, by arrow and Ctrl+click', async () => {
    localStorage.clear();
    const reads: RowsRequest[] = [];
    const ctx = await setup({
      readRows: (_id, _db, table, request) => {
        reads.push(request);
        return Promise.resolve({
          ok: true,
          data:
            table === 'orders'
              ? {
                  columns: ['id', 'customer_id', 'total'],
                  rows: [
                    ['1', '7', '10.00'],
                    ['2', null, '5.00'],
                  ],
                  hasMore: false,
                  durationMs: 1,
                }
              : fakeRows(request),
        });
      },
    });
    const schema = TestBed.inject(SchemaStore);
    const open = vi.spyOn(schema, 'openFiltered').mockResolvedValue();
    ctx.fixture.componentInstance.object.set({
      connectionId: PROFILE.id,
      database: 'app_dev',
      name: 'orders',
      kind: 'table',
    });
    await ctx.settle();
    await ctx.settle();
    await vi.waitFor(() => expect(ctx.el.querySelector('.dg-fk')).not.toBeNull());
    // Only on values, not on NULL; the header says where it points.
    expect(ctx.el.querySelectorAll('.dg-fk')).toHaveLength(1);
    expect(ctx.el.querySelector('.dg-fk-mark')?.getAttribute('title')).toBe(
      'Verwijst naar customers.id',
    );
    ctx.el.querySelector<HTMLButtonElement>('.dg-fk')!.click();
    expect(open).toHaveBeenCalledWith(
      { connectionId: PROFILE.id, database: 'app_dev', name: 'customers', kind: 'table' },
      "`id` = '7'",
    );

    const cell = ctx.el.querySelectorAll('.dg-row')[0]!.querySelectorAll('.dg-cell')[1]!;
    cell.dispatchEvent(new MouseEvent('mousedown', { button: 0, ctrlKey: true, bubbles: true }));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('opens the rows that point to this row, from the menu', async () => {
    localStorage.clear();
    const ctx = await setup();
    const schema = TestBed.inject(SchemaStore);
    const open = vi.spyOn(schema, 'openFiltered').mockResolvedValue();
    const menus = TestBed.inject(ContextMenuStore);
    await vi.waitFor(() => expect(schema.model(PROFILE.id, 'app_dev')?.status).toBe('loaded'));
    const cell = ctx.el.querySelectorAll('.dg-row')[2]!.querySelectorAll('.dg-cell')[0]!;
    cell.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await ctx.settle();
    const entries = menus.menu()!.items;
    const back = entries.find(
      (e) => e !== 'separator' && e.label === 'Rijen die hiernaar verwijzen',
    ) as MenuSubmenu;
    expect(back.items.map((i) => (i === 'separator' ? '—' : i.label))).toEqual([
      'orders (customer_id)',
    ]);
    (back.items[0] as MenuAction).run();
    expect(open).toHaveBeenCalledWith(
      { connectionId: PROFILE.id, database: 'app_dev', name: 'orders', kind: 'table' },
      "`customer_id` = '3'",
    );
  });

  it('starts filtered on the key when opened by following it', async () => {
    localStorage.clear();
    const reads: RowsRequest[] = [];
    const ctx = await setup({
      readRows: (_id, _db, _t, request) => {
        reads.push(request);
        return Promise.resolve({ ok: true, data: fakeRows(request) });
      },
    });
    const schema = TestBed.inject(SchemaStore);
    schema.whereRequest.set({
      object: { connectionId: PROFILE.id, database: 'app_dev', name: 'orders', kind: 'table' },
      where: "`id` = '7'",
    });
    ctx.fixture.componentInstance.object.set({
      connectionId: PROFILE.id,
      database: 'app_dev',
      name: 'orders',
      kind: 'table',
    });
    await ctx.settle();
    await vi.waitFor(() => expect(reads.at(-1)?.where).toBe("`id` = '7'"));
    expect(ctx.el.querySelector<HTMLInputElement>('.dt-where')!.value).toBe("`id` = '7'");
    expect(schema.whereRequest()).toBeNull();
  });
});

describe('TableData row detail', () => {
  async function withDetail(overrides: Partial<DbApi> = {}) {
    localStorage.removeItem('dbv.rowDetail');
    const applied: Parameters<DbApi['applyChanges']>[3][] = [];
    const ctx = await setup({
      ...overrides,
      applyChanges: async (_c, _d, _t, changes) => {
        applied.push(changes);
        return { ok: true, data: { deleted: 0, updated: changes.updates.length, inserted: 0 } };
      },
    });
    const cell = (row: number, col: number) =>
      ctx.el.querySelectorAll('.dg-row')[row]!.querySelectorAll<HTMLElement>('.dg-cell')[col]!;
    const field = (name: string) =>
      Array.from(ctx.el.querySelectorAll<HTMLElement>('.rd-field')).find((f) =>
        f.querySelector('.rd-name')?.textContent?.trim().endsWith(name),
      )!;
    return { ...ctx, applied, cell, field };
  }

  it('shows the selected row as a form and follows the selection', async () => {
    const { el, button, settle, cell, field } = await withDetail();
    button('Rijdetail').click();
    await settle();
    // Opens on the first row when nothing was selected.
    expect(el.querySelector('.rd-title')?.textContent?.trim()).toBe('Rij 1');
    expect(field('email').querySelector('input')!.value).toBe('user1@example.com');
    cell(6, 1).dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    await settle();
    expect(el.querySelector('.rd-title')?.textContent?.trim()).toBe('Rij 7');
    // NULL shows as a placeholder, with a field you can type in.
    const status = field('status').querySelector('input')!;
    expect(status.value).toBe('');
    expect(status.placeholder).toBe('NULL');
    expect(field('email').classList).toContain('rd-active');
    expect(localStorage.getItem('dbv.rowDetail')).toBe('1');
  });

  it('edits like the grid: into the pending changes, saved with Opslaan', async () => {
    const { el, button, settle, cell, field, applied } = await withDetail();
    button('Rijdetail').click();
    await settle();
    const email = field('email').querySelector('input')!;
    email.dispatchEvent(new Event('focus'));
    email.value = 'nieuw@example.com';
    email.dispatchEvent(new Event('input'));
    await settle();
    expect(cell(0, 1).textContent?.trim()).toBe('nieuw@example.com');
    expect(cell(0, 1).classList).toContain('edited');
    expect(field('email').classList).toContain('rd-edited');
    // The primary key (auto increment) can be edited in the grid too: same rule here.
    expect(field('id').querySelector('input')).not.toBeNull();
    // NULL button, and Esc undoes typing that was not applied.
    Array.from(field('email').querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'NULL')!
      .click();
    await settle();
    expect(cell(0, 1).textContent?.trim()).toBe('NULL');
    button('Volgende rij').click();
    await settle();
    expect(el.querySelector('.rd-title')?.textContent?.trim()).toBe('Rij 2');
    const email2 = field('email').querySelector('input')!;
    email2.dispatchEvent(new Event('focus'));
    email2.value = 'weg';
    email2.dispatchEvent(new Event('input'));
    await settle();
    // Typing goes straight into the pending changes; Esc puts the old value back.
    expect(cell(1, 1).textContent?.trim()).toBe('weg');
    field('email')
      .querySelector('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(cell(1, 1).textContent?.trim()).toBe('user2@example.com');
    expect(el.querySelector('.change-count')?.textContent).toContain('1 wijziging');
    button('Opslaan').click();
    await settle();
    expect(applied[0]?.updates).toEqual([{ key: { id: '1' }, values: { email: null } }]);
    // After saving the page reloads; the panel stays on the same row.
    expect(el.querySelector('.rd-title')?.textContent?.trim()).toBe('Rij 2');
  });

  it('filters the fields by name and closes', async () => {
    const { el, button, settle } = await withDetail();
    button('Rijdetail').click();
    await settle();
    const search = el.querySelector<HTMLInputElement>('.rd-filter')!;
    search.value = 'stat';
    search.dispatchEvent(new Event('input'));
    await settle();
    expect(Array.from(el.querySelectorAll('.rd-name')).map((n) => n.textContent?.trim())).toEqual([
      'status',
    ]);
    button('Rijdetail sluiten').click();
    await settle();
    expect(el.querySelector('.rd')).toBeNull();
    expect(localStorage.getItem('dbv.rowDetail')).toBe('0');
  });
});
