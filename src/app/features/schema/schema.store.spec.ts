import { TestBed } from '@angular/core/testing';
import type { DbApi } from '../../../../shared/ipc-contract';
import { DB_API } from '../../core/db-api';
import { fakeDbApi, PROFILE } from '../../testing/fake-db-api';
import { ConnectionsStore } from '../connections/connections.store';
import { dbKey, groupKey, objectKey, SchemaStore } from './schema.store';

const ID = PROFILE.id;

async function setup(overrides: Partial<DbApi> = {}) {
  const api = fakeDbApi(overrides);
  const calls = { databases: 0, objects: 0, columns: 0 };
  const counted: DbApi = {
    ...api,
    listDatabases: (...a) => (calls.databases++, api.listDatabases(...a)),
    listObjects: (...a) => (calls.objects++, api.listObjects(...a)),
    listColumns: (...a) => (calls.columns++, api.listColumns(...a)),
  };
  TestBed.configureTestingModule({ providers: [{ provide: DB_API, useValue: counted }] });
  const connections = TestBed.inject(ConnectionsStore);
  const schema = TestBed.inject(SchemaStore);
  await connections.init();
  await connections.connect(ID);
  return { connections, schema, calls };
}

describe('SchemaStore', () => {
  it('opens the profile database and its tables group', async () => {
    const { schema } = await setup();
    await schema.open(ID, 'app_dev');

    expect(schema.databases(ID)).toMatchObject({ status: 'loaded' });
    expect(schema.isExpanded(dbKey(ID, 'app_dev'))).toBe(true);
    expect(schema.isExpanded(groupKey(ID, 'app_dev', 'tables'))).toBe(true);
    expect(schema.objects(ID, 'app_dev')).toMatchObject({ status: 'loaded' });
  });

  it('loads each level once and serves it from cache afterwards', async () => {
    const { schema, calls } = await setup();
    await schema.open(ID, '');
    await schema.toggleDatabase(ID, 'shop');
    await schema.toggleDatabase(ID, 'shop'); // close
    await schema.toggleDatabase(ID, 'shop'); // reopen: cached
    await schema.toggleObject(ID, 'shop', 'orders');
    await schema.select({ connectionId: ID, database: 'shop', name: 'orders', kind: 'table' });

    expect(calls).toEqual({ databases: 1, objects: 1, columns: 1 });
    expect(schema.isExpanded(objectKey(ID, 'shop', 'orders'))).toBe(true);
  });

  it('refresh reloads what is open and keeps it open', async () => {
    const { schema, calls } = await setup();
    await schema.open(ID, 'app_dev');
    await schema.toggleObject(ID, 'app_dev', 'customers');
    await schema.refresh(ID);

    expect(calls).toEqual({ databases: 2, objects: 2, columns: 2 });
    expect(schema.isExpanded(objectKey(ID, 'app_dev', 'customers'))).toBe(true);
    expect(schema.columns(ID, 'app_dev', 'customers')).toMatchObject({ status: 'loaded' });
  });

  it('keeps an error per node so the rest of the tree keeps working', async () => {
    const { schema } = await setup({
      listObjects: async (_id, db) =>
        db === 'shop'
          ? { ok: false, error: { code: 'ER_DBACCESS_DENIED_ERROR', message: 'Geen rechten.' } }
          : { ok: true, data: [] },
    });
    await schema.open(ID, 'app_dev');
    await schema.toggleDatabase(ID, 'shop');

    expect(schema.objects(ID, 'shop')).toMatchObject({ status: 'error' });
    expect(schema.objects(ID, 'app_dev')).toMatchObject({ status: 'loaded' });
  });

  it('forgets everything about a connection after disconnect', async () => {
    const { connections, schema } = await setup();
    await schema.open(ID, 'app_dev');
    await schema.select({
      connectionId: ID,
      database: 'app_dev',
      name: 'customers',
      kind: 'table',
    });
    await connections.disconnect(ID);
    TestBed.tick(); // run effects

    expect(schema.databases(ID)).toBeUndefined();
    expect(schema.selected()).toBeNull();
    expect(schema.isExpanded(dbKey(ID, 'app_dev'))).toBe(false);
  });
});
