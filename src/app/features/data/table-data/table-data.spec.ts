import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { DbApi } from '../../../../../shared/ipc-contract';
import type { ColumnInfo, RowsRequest } from '../../../../../shared/models';
import { DB_API } from '../../../core/db-api';
import { COLUMNS, fakeDbApi, fakeRows, PROFILE } from '../../../testing/fake-db-api';
import type { Load, SelectedObject } from '../../schema/schema.store';
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
    const input = el.querySelector<HTMLInputElement>('#where')!;
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
