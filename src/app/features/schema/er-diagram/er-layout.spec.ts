import type { DatabaseModel } from '../../../../../shared/models';
import { HEADER_H, layoutModel, MAX_COLUMNS, ROW_H } from './er-layout';

const measure = (text: string) => text.length * 7;
const col = (name: string, primary = false) => ({ name, type: 'int', primary });

const model: DatabaseModel = {
  tables: [
    { name: 'customers', columns: [col('id', true), col('name')] },
    { name: 'orders', columns: [col('id', true), col('customer_id'), col('parent_id')] },
    { name: 'order_items', columns: [col('id', true), col('order_id')] },
    { name: 'settings', columns: [col('key', true)] },
    {
      name: 'wide',
      columns: Array.from({ length: MAX_COLUMNS + 5 }, (_, i) => col(`c${i}`)),
    },
  ],
  foreignKeys: [
    {
      name: 'fk_orders_customer',
      database: 'shop',
      table: 'orders',
      columns: ['customer_id'],
      refDatabase: 'shop',
      refTable: 'customers',
      refColumns: ['id'],
    },
    {
      name: 'fk_items_order',
      database: 'shop',
      table: 'order_items',
      columns: ['order_id'],
      refDatabase: 'shop',
      refTable: 'orders',
      refColumns: ['id'],
    },
    {
      name: 'fk_orders_parent',
      database: 'shop',
      table: 'orders',
      columns: ['parent_id'],
      refDatabase: 'shop',
      refTable: 'orders',
      refColumns: ['id'],
    },
    // From another database: not drawn.
    {
      name: 'fk_other',
      database: 'crm',
      table: 'contacts',
      columns: ['customer_id'],
      refDatabase: 'shop',
      refTable: 'customers',
      refColumns: ['id'],
    },
  ],
};

describe('ER layout', () => {
  const l = layoutModel(model, 'shop', measure);
  const node = (name: string) => l.nodes.find((n) => n.name === name)!;

  it('places referenced tables right of the tables that point to them', () => {
    expect(node('customers').x).toBeGreaterThan(node('orders').x + node('orders').width);
    expect(node('orders').x).toBeGreaterThan(node('order_items').x + node('order_items').width);
  });

  it('puts tables without relations below, and nothing overlaps', () => {
    const related = ['customers', 'orders', 'order_items'].map(node);
    const bottom = Math.max(...related.map((n) => n.y + n.height));
    expect(node('settings').y).toBeGreaterThan(bottom);
    for (const a of l.nodes)
      for (const b of l.nodes) {
        if (a === b) continue;
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(apart, `${a.name} / ${b.name}`).toBe(true);
      }
    for (const n of l.nodes) {
      expect(n.x + n.width).toBeLessThanOrEqual(l.width);
      expect(n.y + n.height).toBeLessThanOrEqual(l.height);
    }
  });

  it('draws a line per key in this database, from the key column to the referenced one', () => {
    expect(l.edges.map((e) => e.key.name).sort()).toEqual([
      'fk_items_order',
      'fk_orders_customer',
      'fk_orders_parent',
    ]);
    const e = l.edges.find((x) => x.key.name === 'fk_orders_customer')!;
    const orders = node('orders');
    expect(e.start).toMatchObject({ x: orders.x + orders.width, dir: 1 });
    expect(e.start.y).toBe(orders.y + HEADER_H + 1 * ROW_H + ROW_H / 2 + 2);
    expect(e.end.x).toBe(node('customers').x);
    expect(node('orders').columns.find((c) => c.name === 'customer_id')?.foreign).toBe(true);
    // A key to its own table loops on the right side.
    const self = l.edges.find((x) => x.key.name === 'fk_orders_parent')!;
    expect(self.start.x).toBe(self.end.x);
  });

  it('shows at most MAX_COLUMNS columns and counts the rest', () => {
    expect(node('wide').columns).toHaveLength(MAX_COLUMNS);
    expect(node('wide').hidden).toBe(5);
  });
});
