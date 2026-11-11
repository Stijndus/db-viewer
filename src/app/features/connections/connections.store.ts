import { computed, inject, Injectable, signal } from '@angular/core';
import type {
  LaunchRequest,
  ConnectSecrets,
  ConnectionInput,
  ConnectionProfile,
  ConnectionStatus,
  DbError,
  Result,
  TestResult,
} from '../../../../shared/models';
import { DB_API } from '../../core/db-api';

/** What the secrets prompt asks for before connecting. */
export interface SecretsPrompt {
  profile: ConnectionProfile;
  askPassword: boolean;
  askSsh: boolean;
  /** The previous attempt failed with this (e.g. a wrong passphrase). */
  error?: DbError;
}

/** Asking the user to trust an SSH server's host key. */
export interface HostKeyPrompt {
  host: string;
  fingerprint: string;
  /** The server presented a different key than the trusted one. */
  changed: boolean;
  answer(trust: boolean): void;
}

const HOST_KEY_CODES = new Set(['SSH_HOST_KEY_UNKNOWN', 'SSH_HOST_KEY_CHANGED']);

export function isHostKeyError(error: DbError): boolean {
  return HOST_KEY_CODES.has(error.code) && Boolean(error.fingerprint);
}

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
  /** Set when connecting needs a password or SSH secret that isn't stored. */
  readonly passwordPrompt = signal<SecretsPrompt | null>(null);
  /** Set while the user decides whether to trust an SSH server. */
  readonly hostKeyPrompt = signal<HostKeyPrompt | null>(null);

  readonly active = computed(
    () => this.connections().find((c) => c.id === this.activeId()) ?? null,
  );
  readonly connectedCount = computed(
    () => Object.values(this.status()).filter((s) => s === 'connected').length,
  );

  statusOf(id: string): ConnectionStatus {
    return this.status()[id] ?? 'idle';
  }

  /** A command line that could not be opened (unknown name, bad option). */
  readonly launchError = signal<DbError | null>(null);
  private stopLaunches: (() => void) | null = null;

  async init(): Promise<void> {
    const info = await this.api.appInfo();
    if (info.ok) this.encryptionAvailable.set(info.data.encryptionAvailable);
    await this.load();
    // `db-viewer …` at start, and again later while the app runs.
    this.stopLaunches?.();
    this.stopLaunches = this.api.onLaunch((launch) => void this.openLaunch(launch));
    const first = await this.api.takeLaunch();
    if (first.ok && first.data) await this.openLaunch(first.data);
  }

  /** Opens what the command line asked for: a saved or temporary connection, or shows why not. */
  async openLaunch(launch: LaunchRequest): Promise<void> {
    if (launch.kind === 'error') {
      this.launchError.set({
        code: 'CLI',
        message: launch.message,
        ...(launch.hint && { hint: launch.hint }),
      });
      return;
    }
    this.launchError.set(null);
    await this.load();
    await this.connect(launch.connectionId);
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

  async connect(id: string, secrets: ConnectSecrets = {}): Promise<void> {
    if (this.statusOf(id) === 'connecting') return;
    if (this.statusOf(id) === 'connected') {
      this.activeId.set(id);
      return;
    }
    this.setStatus(id, 'connecting');
    this.setError(id, undefined);
    const result = await this.api.connect(id, secrets);
    const profile = this.connections().find((c) => c.id === id);

    if (result.ok) {
      this.setStatus(id, 'connected');
      this.serverVersions.update((v) => ({ ...v, [id]: result.data.serverVersion }));
      this.activeId.set(id);
      this.passwordPrompt.set(null);
      return;
    }
    const error = result.error;
    this.setStatus(id, 'idle');
    if (profile && isHostKeyError(error) && profile.ssh) {
      const trust = await this.confirmHostKey(profile.ssh.host, error);
      if (!trust) return;
      const saved = await this.api.trustHostKey(id, error.fingerprint!);
      if (!saved.ok) {
        this.setStatus(id, 'error');
        this.setError(id, saved.error);
        return;
      }
      await this.load();
      return this.connect(id, secrets);
    }
    const wrongSecret = ['SSH_AUTH_FAILED', 'SSH_KEY_PASSPHRASE_WRONG'].includes(error.code);
    const typedSsh = Boolean(secrets.sshSecret);
    if (
      profile &&
      (error.code === 'PASSWORD_REQUIRED' ||
        error.code === 'SSH_SECRET_REQUIRED' ||
        (wrongSecret && (typedSsh || !profile.hasSshSecret) && profile.ssh?.auth !== 'agent'))
    ) {
      const sshAsked =
        error.code === 'SSH_SECRET_REQUIRED' ||
        wrongSecret ||
        (profile.ssh?.auth === 'password' && !profile.hasSshSecret);
      this.passwordPrompt.set({
        profile,
        askPassword: profile.type !== 'sqlite' && !profile.hasPassword,
        askSsh: Boolean(profile.ssh) && sshAsked,
        ...(wrongSecret && { error }),
      });
      return;
    }
    this.setStatus(id, 'error');
    this.setError(id, error);
  }

  /** Shows the host key dialog; resolves with the user's choice. */
  confirmHostKey(host: string, error: DbError): Promise<boolean> {
    return new Promise((resolve) => {
      this.hostKeyPrompt.set({
        host,
        fingerprint: error.fingerprint ?? '',
        changed: error.code === 'SSH_HOST_KEY_CHANGED',
        answer: (trust) => {
          this.hostKeyPrompt.set(null);
          resolve(trust);
        },
      });
    });
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
    Partial<Pick<ConnectionProfile, 'type' | 'ssh'>>,
): string {
  if (c.type === 'sqlite') return c.database; // the file
  const db = `${c.user}@${c.host}:${c.port}${c.database ? '/' + c.database : ''}`;
  return c.ssh ? `${db} via ${c.ssh.user}@${c.ssh.host}` : db;
}

/** Short location for lists: `host:port / database`, or the file name for SQLite. */
export function connectionLocation(
  c: Pick<ConnectionProfile, 'type' | 'host' | 'port' | 'database'> &
    Partial<Pick<ConnectionProfile, 'ssh'>>,
): string {
  if (c.type === 'sqlite') return c.database.split(/[\\/]/).pop() || c.database;
  const where = c.ssh ? `${c.ssh.host} → ${c.host}` : c.host;
  return `${where}:${c.port}${c.database ? ' / ' + c.database : ''}`;
}

export const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: 'Inactief',
  connecting: 'Verbinden…',
  connected: 'Verbonden',
  error: 'Fout',
};
