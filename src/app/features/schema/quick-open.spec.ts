import { TestBed } from '@angular/core/testing';
import type { SchemaObject } from '../../../../shared/models';
import { DB_API } from '../../core/db-api';
import { fakeDbApi, PROFILE } from '../../testing/fake-db-api';
import { ConnectionsStore } from '../connections/connections.store';
import { matchScore, QuickOpen, quickMatches, type QuickItem } from './quick-open';
import { SchemaStore } from './schema.store';

const obj = (name: string, kind: SchemaObject['kind'] = 'table'): SchemaObject => ({
  name,
  kind,
  rowEstimate: null,
  comment: '',
});
const items: QuickItem[] = [
  { database: 'shop', object: obj('orders') },
  { database: 'shop', object: obj('order_items') },
  { database: 'shop', object: obj('paid_orders', 'view') },
  { database: 'crm', object: obj('orders') },
  { database: 'crm', object: obj('contacts') },
  { database: 'crm', object: obj('refresh_stats', 'procedure') },
];
const names = (found: QuickItem[]) => found.map((i) => `${i.database}.${i.object.name}`);

describe('quick open matching', () => {
  it('ranks exact, prefix, word start, anywhere, then letters in order', () => {
    expect(matchScore('orders', 'orders')).toBeGreaterThan(matchScore('order_items', 'orders')!);
    expect(matchScore('order_items', 'items')).toBeGreaterThan(matchScore('lineitems', 'items')!);
    expect(matchScore('order_items', 'oit')).not.toBeNull();
    expect(matchScore('contacts', 'xyz')).toBeNull();
  });

  it('finds over all databases, and narrows with database.table', () => {
    expect(names(quickMatches(items, 'order'))).toEqual([
      'crm.orders',
      'shop.orders',
      'shop.order_items',
      'shop.paid_orders',
    ]);
    expect(names(quickMatches(items, 'crm.ord'))).toEqual(['crm.orders']);
    expect(names(quickMatches(items, 'ordit'))).toEqual(['shop.order_items']);
    expect(names(quickMatches(items, 'stats'))).toEqual(['crm.refresh_stats']);
  });

  it('shows recently opened first when nothing is typed', () => {
    expect(
      names(quickMatches(items, '', ['shop.paid_orders', 'crm.contacts'])).slice(0, 3),
    ).toEqual(['shop.paid_orders', 'crm.contacts', 'crm.orders']);
  });
});

describe('QuickOpen', () => {
  beforeEach(() => {
    localStorage.clear();
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  it('loads every database, finds a table and opens it', async () => {
    const loaded: string[] = [];
    const api = fakeDbApi();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DB_API,
          useValue: {
            ...api,
            listObjects: (id: string, db: string) => {
              loaded.push(db);
              return api.listObjects(id, db);
            },
          },
        },
      ],
    });
    const connections = TestBed.inject(ConnectionsStore);
    await connections.init();
    await connections.connect(PROFILE.id);
    const schema = TestBed.inject(SchemaStore);
    const fixture = TestBed.createComponent(QuickOpen);
    const el = fixture.nativeElement as HTMLElement;
    schema.quickOpenFor.set(PROFILE.id);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(el.querySelector('.qo-foot')?.textContent).toContain('in 2 databases');
    });
    // System databases are left out.
    expect([...loaded].sort()).toEqual(['app_dev', 'shop']);

    const input = el.querySelector<HTMLInputElement>('.cp-input')!;
    input.value = 'shop.cust';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    const options = Array.from(el.querySelectorAll('.cp-item')).map((o) =>
      Array.from(o.querySelectorAll('.mono, .muted'))
        .map((s) => s.textContent?.trim())
        .join(' '),
    );
    expect(options).toEqual(['customers shop tabel']);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await fixture.whenStable();
    expect(schema.selected()).toEqual({
      connectionId: PROFILE.id,
      database: 'shop',
      name: 'customers',
      kind: 'table',
    });
    expect(schema.quickOpenFor()).toBeNull();
    expect(JSON.parse(localStorage.getItem('dbv.quickOpen.recent')!)).toEqual({
      [PROFILE.id]: ['shop.customers'],
    });
  });
});
