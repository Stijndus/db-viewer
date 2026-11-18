import { splitQuery } from '../quick-open';
import { parseTreeFilter } from './schema-tree';

describe('tree filter', () => {
  it('reads plain text, database.table and the db: and tb: tags', () => {
    expect(parseTreeFilter('Orders')).toEqual({ q: 'orders', dbPart: null, objPart: null });
    expect(parseTreeFilter('plan.ord')).toMatchObject({ dbPart: 'plan', objPart: 'ord' });
    expect(parseTreeFilter('db:plan tb:ord')).toMatchObject({ dbPart: 'plan', objPart: 'ord' });
    expect(parseTreeFilter('tb:ord db:plan')).toMatchObject({ dbPart: 'plan', objPart: 'ord' });
    // One tag: the other part is the text next to it, or everything.
    expect(parseTreeFilter('db:plan')).toMatchObject({ dbPart: 'plan', objPart: '' });
    expect(parseTreeFilter('db:plan ord')).toMatchObject({ dbPart: 'plan', objPart: 'ord' });
    expect(parseTreeFilter('tb:ord')).toMatchObject({ dbPart: '', objPart: 'ord' });
    expect(parseTreeFilter('TB:Ord')).toMatchObject({ dbPart: '', objPart: 'ord' });
  });

  it('reads the same in Ctrl+P', () => {
    expect(splitQuery('db:shop tb:cust')).toEqual({ dbPart: 'shop', namePart: 'cust' });
    expect(splitQuery('tb:cust')).toEqual({ dbPart: '', namePart: 'cust' });
    expect(splitQuery('shop.cust')).toEqual({ dbPart: 'shop', namePart: 'cust' });
    expect(splitQuery('cust')).toEqual({ dbPart: '', namePart: 'cust' });
  });
});
