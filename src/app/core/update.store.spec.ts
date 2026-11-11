import { TestBed } from '@angular/core/testing';
import type { DbApi } from '../../../shared/ipc-contract';
import type { ReleaseNote } from '../../../shared/models';
import { fakeDbApi } from '../testing/fake-db-api';
import { DB_API } from './db-api';
import { compareVersions, UpdateStore } from './update.store';

const NOTES: ReleaseNote[] = [
  { version: '0.8.0', markdown: '## Nieuw\n\n- SSH-tunnel' },
  { version: '0.7.0', markdown: '- Meer databases' },
  { version: '0.6.0', markdown: '- Tabbladen' },
];

async function start(version: string, overrides: Partial<DbApi> = {}) {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: DB_API,
        useValue: fakeDbApi({
          appInfo: async () => ({ ok: true, data: { encryptionAvailable: true, version } }),
          releaseNotes: async () => ({ ok: true, data: NOTES }),
          ...overrides,
        }),
      },
    ],
  });
  const store = TestBed.inject(UpdateStore);
  await store.init();
  return store;
}

describe('UpdateStore release notes', () => {
  beforeEach(() => localStorage.clear());

  it('shows nothing on a fresh install, and remembers the version', async () => {
    const store = await start('0.8.0');
    expect(store.whatsNew()).toBeNull();
    expect(localStorage.getItem('dbv.seenVersion')).toBe('0.8.0');
  });

  it('shows every version since the last one used, once', async () => {
    localStorage.setItem('dbv.seenVersion', '0.6.0');
    const store = await start('0.8.0');
    expect(store.whatsNew()?.title).toBe('Nieuw sinds versie 0.6.0');
    expect(store.whatsNew()?.entries.map((e) => e.version)).toEqual(['0.8.0', '0.7.0']);
    expect(store.whatsNew()?.entries[0]?.html).toContain('<li>SSH-tunnel</li>');

    TestBed.resetTestingModule();
    const again = await start('0.8.0');
    expect(again.whatsNew()).toBeNull();
  });

  it('treats an older install without the marker as an update to this version', async () => {
    localStorage.setItem('dbv.pageSize', '100');
    const store = await start('0.8.0');
    expect(store.whatsNew()?.title).toBe('Nieuw in versie 0.8.0');
    expect(store.whatsNew()?.entries).toHaveLength(1);
  });

  it('lists all notes, and the GitHub notes of a waiting update', async () => {
    const store = await start('0.8.0', {
      updateState: async () => ({
        ok: true,
        data: { status: 'ready', version: '0.9.0', notes: '<p>Zoomen</p>' },
      }),
    });
    store.showAllNotes();
    expect(store.whatsNew()?.entries).toHaveLength(3);
    store.showUpdateNotes();
    expect(store.whatsNew()).toMatchObject({
      title: 'Nieuw in versie 0.9.0',
      pending: true,
      entries: [{ version: '0.9.0', html: '<p>Zoomen</p>' }],
    });
  });

  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.0.0-test', '0.1.0')).toBeLessThan(0);
  });
});
