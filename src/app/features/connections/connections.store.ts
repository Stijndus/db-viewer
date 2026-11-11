import { computed, inject, Injectable, signal } from '@angular/core';
import type {
  ConnectionInput,
  ConnectionProfile,
  ConnectionStatus,
  DbError,
  Result,
  TestResult,
} from '../../../../shared/models';
import { DB_API } from '../../core/db-api';

export type EditorState = { mode: 'new' } | { mode: 'edit'; profile: ConnectionProfile } | null;

/** UI state for saved connections and their live status. All IPC goes through here. */
@Injectable({ providedIn: 'root' })
export class ConnectionsStore {
  private readonly api = inject(DB_API);

  readonly connections = signal<ConnectionProfile[]>([]);
  readonly status = signal<Record<string, ConnectionStatus>>({});
  readonly errors = signal<Record<string, DbError | undefined>>({});
  readonly serverVersions = signal<Record<string, string>>({});
  readonly activeId = signal<string | null>(null);
  readonly loadError = signal<DbError | null>(null);
  readonly encryptionAvailable = signal(true);
  readonly editor = signal<EditorState>(null);
  /** Set when connecting needs a password that isn't stored. */
  readonly passwordPrompt = signal<ConnectionProfile | null>(null);

  readonly active = computed(
    () => this.connections().find((c) => c.id === this.activeId()) ?? null,
  );
  readonly connectedCount = computed(
    () => Object.values(this.status()).filter((s) => s === 'connected').length,
  );

  statusOf(id: string): ConnectionStatus {
    return this.status()[id] ?? 'idle';
  }

  async init(): Promise<void> {
    const info = await this.api.appInfo();
    if (info.ok) this.encryptionAvailable.set(info.data.encryptionAvailable);
    await this.load();
  }

  async load(): Promise<void> {
    const result = await this.api.listConnections();
    if (result.ok) {
      this.connections.set(result.data);
      this.loadError.set(null);
    } else {
      this.loadError.set(result.error);
    }
  }

  test(input: ConnectionInput, id?: string): Promise<Result<TestResult>> {
    return this.api.testConnection(input, id);
  }

  async save(input: ConnectionInput, id?: string): Promise<Result<ConnectionProfile>> {
    const result = await this.api.saveConnection(input, id);
    if (result.ok) {
      // A changed host or password must not keep using the old pool.
      if (id && this.statusOf(id) === 'connected') await this.disconnect(id);
      this.setError(result.data.id, undefined);
      await this.load();
    }
    return result;
  }

  async remove(id: string): Promise<Result<void>> {
    const result = await this.api.deleteConnection(id);
    if (result.ok) {
      this.setStatus(id, 'idle');
      if (this.activeId() === id) this.activeId.set(null);
      await this.load();
    }
    return result;
  }

  async connect(id: string, password?: string): Promise<void> {
    if (this.statusOf(id) === 'connecting') return;
    if (this.statusOf(id) === 'connected') {
      this.activeId.set(id);
      return;
    }
    this.setStatus(id, 'connecting');
    this.setError(id, undefined);
    const result = await this.api.connect(id, password);

    if (result.ok) {
      this.setStatus(id, 'connected');
      this.serverVersions.update((v) => ({ ...v, [id]: result.data.serverVersion }));
      this.activeId.set(id);
      this.passwordPrompt.set(null);
    } else if (result.error.code === 'PASSWORD_REQUIRED') {
      this.setStatus(id, 'idle');
      this.passwordPrompt.set(this.connections().find((c) => c.id === id) ?? null);
    } else {
      this.setStatus(id, 'error');
      this.setError(id, result.error);
    }
  }

  async disconnect(id: string): Promise<void> {
    await this.api.disconnect(id);
    this.setStatus(id, 'idle');
    if (this.activeId() === id) this.activeId.set(null);
  }

  private setStatus(id: string, status: ConnectionStatus): void {
    this.status.update((s) => ({ ...s, [id]: status }));
  }

  private setError(id: string, error: DbError | undefined): void {
    this.errors.update((e) => ({ ...e, [id]: error }));
  }
}

export function connectionAddress(
  c: Pick<ConnectionProfile, 'user' | 'host' | 'port' | 'database'> &
    Partial<Pick<ConnectionProfile, 'type'>>,
): string {
  if (c.type === 'sqlite') return c.database; // the file
  return `${c.user}@${c.host}:${c.port}${c.database ? '/' + c.database : ''}`;
}

/** Short location for lists: `host:port / database`, or the file name for SQLite. */
export function connectionLocation(
  c: Pick<ConnectionProfile, 'type' | 'host' | 'port' | 'database'>,
): string {
  if (c.type === 'sqlite') return c.database.split(/[\\/]/).pop() || c.database;
  return `${c.host}:${c.port}${c.database ? ' / ' + c.database : ''}`;
}

export const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: 'Inactief',
  connecting: 'Verbinden…',
  connected: 'Verbonden',
  error: 'Fout',
};
