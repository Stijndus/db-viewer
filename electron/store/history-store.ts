import { randomUUID } from 'node:crypto';
import { promises as fs, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  HISTORY_MAX,
  HISTORY_SQL_MAX,
  type HistoryEntry,
  type NewHistoryEntry,
} from '../../shared/models';

/**
 * The query history: a JSON file in the app's data folder, newest entry first, at most
 * HISTORY_MAX entries. Writes are bundled (a run of many statements is one write) and made
 * atomic through a temporary file; on quit the last change is written at once.
 */
export class HistoryStore {
  private entries: HistoryEntry[] | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly delayMs = 400,
  ) {}

  private load(): HistoryEntry[] {
    if (this.entries) return this.entries;
    let stored: unknown = [];
    try {
      stored = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      // First start or unreadable: an empty history.
    }
    this.entries = Array.isArray(stored)
      ? (stored as HistoryEntry[])
          .filter(
            (e) =>
              e &&
              typeof e.id === 'string' &&
              typeof e.sql === 'string' &&
              typeof e.connectionId === 'string' &&
              typeof e.at === 'number',
          )
          .slice(0, HISTORY_MAX)
      : [];
    return this.entries;
  }

  list(): HistoryEntry[] {
    return this.load();
  }

  add(entries: NewHistoryEntry[]): HistoryEntry[] {
    const added = entries.map((e) => {
      const long = e.sql.length > HISTORY_SQL_MAX;
      return {
        ...e,
        id: randomUUID(),
        sql: long ? e.sql.slice(0, HISTORY_SQL_MAX) : e.sql,
        ...(long && { truncated: true }),
      };
    });
    // Newest first: the last statement of a run on top.
    this.entries = [...[...added].reverse(), ...this.load()].slice(0, HISTORY_MAX);
    this.schedule();
    return added;
  }

  delete(ids: string[]): void {
    const gone = new Set(ids);
    this.entries = this.load().filter((e) => !gone.has(e.id));
    this.schedule();
  }

  /** One connection's entries, or all. */
  clear(connectionId?: string): void {
    this.entries = connectionId ? this.load().filter((e) => e.connectionId !== connectionId) : [];
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writing = this.writing.then(() => this.write()).catch(() => undefined);
    }, this.delayMs);
  }

  private async write(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.entries ?? []), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  /** Writes a pending change now (on quit). */
  flushSync(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.entries ?? []), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.error('Query-geschiedenis opslaan mislukt', err);
    }
  }

  /** For tests: waits for the bundled write. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.writing = this.writing.then(() => this.write());
    }
    await this.writing;
  }
}
