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
