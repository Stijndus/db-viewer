import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HISTORY_MAX, HISTORY_SQL_MAX, type NewHistoryEntry } from '../../shared/models';
import { HistoryStore } from './history-store';

const entry = (sql: string, connectionId = 'c1'): NewHistoryEntry => ({
  connectionId,
  connectionName: 'lokaal',
  database: 'app',
  sql,
  at: 1,
  durationMs: 2,
  result: { kind: 'ok', affected: 0 },
});

const file = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'dbv-hist-')), 'history.json');

describe('HistoryStore', () => {
  it('keeps the newest first, survives a restart and cuts long SQL', async () => {
    const f = file();
    const store = new HistoryStore(f, 0);
    store.add([entry('SELECT 1'), entry('SELECT 2')]);
    store.add([entry('x'.repeat(HISTORY_SQL_MAX + 10))]);
    await store.flush();
    const again = new HistoryStore(f).list();
    expect(again.map((e) => e.sql.slice(0, 8))).toEqual(['xxxxxxxx', 'SELECT 2', 'SELECT 1']);
    expect(again[0]).toMatchObject({ truncated: true });
    expect(again[0]!.sql).toHaveLength(HISTORY_SQL_MAX);
    expect(new Set(again.map((e) => e.id)).size).toBe(3);
  });

  it('drops the oldest past the maximum', () => {
    const store = new HistoryStore(file(), 0);
    store.add(Array.from({ length: HISTORY_MAX + 5 }, (_, i) => entry(`SELECT ${i}`)));
    const list = store.list();
    expect(list).toHaveLength(HISTORY_MAX);
    expect(list[0]!.sql).toBe(`SELECT ${HISTORY_MAX + 4}`);
  });

  it('deletes single entries and clears per connection or all', async () => {
    const f = file();
    const store = new HistoryStore(f, 0);
    const [a] = store.add([entry('a'), entry('b'), entry('c', 'c2')]);
    store.delete([a!.id]);
    expect(store.list().map((e) => e.sql)).toEqual(['c', 'b']);
    store.clear('c1');
    expect(store.list().map((e) => e.sql)).toEqual(['c']);
    store.clear();
    await store.flush();
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual([]);
  });

  it('starts empty from a broken file', () => {
    const f = file();
    writeFileSync(f, '{kapot');
    expect(new HistoryStore(f).list()).toEqual([]);
  });
});
