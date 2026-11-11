import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ConnectionInput,
  ConnectionProfile,
  ConnectSecrets,
  SshSettings,
} from '../../shared/models';
import { AppError } from '../ipc/errors';

/** Encrypts secrets at rest. In the app this is Electron's safeStorage (OS keychain). */
export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(encrypted: string): string;
}

type StoredConnection = Omit<
  ConnectionProfile,
  'hasPassword' | 'hasSshSecret' | 'ssh' | 'temporary'
> & {
  ssh?: SshSettings | null;
  encryptedPassword?: string;
  encryptedSshSecret?: string;
};

interface StoreFile {
  version: 1;
  connections: StoredConnection[];
}

/** Saved connection profiles in one JSON file; passwords encrypted per profile. */
export class ConnectionStore {
  private cache: StoredConnection[] | null = null;
  private writing: Promise<void> = Promise.resolve();
  /** Connections opened from the command line without --save: in memory until the app quits. */
  private readonly temporary = new Map<string, StoredConnection>();
  /** Passwords given for this run only (command line, environment). Never written. */
  private readonly sessionSecrets = new Map<string, ConnectSecrets>();

  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher,
  ) {}

  async list(): Promise<ConnectionProfile[]> {
    const all = await this.load();
    return [
      ...all.map((c) => toProfile(c)),
      ...[...this.temporary.values()].map((c) => toProfile(c, true)),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<ConnectionProfile> {
    return toProfile(await this.find(id), this.temporary.has(id));
  }

  /**
   * The password in plain text: one given for this run (command line), else the stored one.
   * Undefined when there is neither. Main process only.
   */
  async getPassword(id: string): Promise<string | undefined> {
    const record = await this.find(id);
    return this.sessionSecrets.get(id)?.password ?? this.decrypt(record.encryptedPassword);
  }

  /** The SSH password or key passphrase, like getPassword. Main process only. */
  async getSshSecret(id: string): Promise<string | undefined> {
    const record = await this.find(id);
    return this.sessionSecrets.get(id)?.sshSecret ?? this.decrypt(record.encryptedSshSecret);
  }

  /** Secrets for this run only (from the command line or environment); never saved. */
  setSessionSecrets(id: string, secrets: ConnectSecrets): void {
    const merged = { ...this.sessionSecrets.get(id), ...dropEmpty(secrets) };
    if (Object.keys(merged).length) this.sessionSecrets.set(id, merged);
  }

  /**
   * A saved or temporary profile for the same server, database and user (and SSH server), so
   * opening the same thing twice from the command line doesn't add it twice.
   */
  async findMatch(input: ConnectionInput): Promise<ConnectionProfile | null> {
    const key = matchKey(input);
    const saved = (await this.load()).find((c) => matchKey(c) === key);
    if (saved) return toProfile(saved);
    const temp = [...this.temporary.values()].find((c) => matchKey(c) === key);
    return temp ? toProfile(temp, true) : null;
  }

  /** A connection for this run only: listed like the others, gone when the app quits. */
  addTemporary(input: ConnectionInput): ConnectionProfile {
    const record = buildRecord(input, undefined, randomUUID(), {});
    this.temporary.set(record.id, record);
    this.setSessionSecrets(record.id, {
      password: input.password ?? '',
      sshSecret: input.sshSecret ?? '',
    });
    return toProfile(record, true);
  }

  /** Remembers the SSH server's host key after the user confirmed its fingerprint. */
  async trustHostKey(id: string, fingerprint: string): Promise<ConnectionProfile> {
    const temp = this.temporary.get(id);
    if (temp) {
      if (!temp.ssh) throw new AppError('NO_SSH', 'Deze verbinding gebruikt geen SSH-tunnel.');
      const next = { ...temp, ssh: { ...temp.ssh, hostKey: fingerprint } };
      this.temporary.set(id, next);
      return toProfile(next, true);
    }
    const all = await this.load();
    const record = all.find((c) => c.id === id);
    if (!record) throw notFound();
    if (!record.ssh) throw new AppError('NO_SSH', 'Deze verbinding gebruikt geen SSH-tunnel.');
    const next = { ...record, ssh: { ...record.ssh, hostKey: fingerprint } };
    await this.persist(all.map((c) => (c.id === id ? next : c)));
    return toProfile(next);
  }

  private decrypt(encrypted: string | undefined): string | undefined {
    if (!encrypted) return undefined;
    try {
      return this.cipher.decrypt(encrypted);
    } catch {
      throw new AppError(
        'DECRYPT_FAILED',
        'Opgeslagen wachtwoord kan niet worden ontsleuteld.',
        'Voer het wachtwoord opnieuw in bij Bewerken.',
      );
    }
  }

  private encrypt(plain: string): string {
    if (!this.cipher.isAvailable()) {
      throw new AppError(
        'ENCRYPTION_UNAVAILABLE',
        'Wachtwoord kan niet veilig worden opgeslagen.',
        'De sleutelhanger van je besturingssysteem is niet beschikbaar. Sla op zonder wachtwoord.',
      );
    }
    return this.cipher.encrypt(plain);
  }

  /**
   * Creates or updates a saved profile. Saving a temporary one (opened from the command line)
   * keeps its id, so an open connection stays open, and turns it into a normal profile.
   */
  async save(input: ConnectionInput, id?: string): Promise<ConnectionProfile> {
    const all = await this.load();
    const temp = id ? this.temporary.get(id) : undefined;
    const existing = id ? (all.find((c) => c.id === id) ?? temp) : undefined;
    if (id && !existing) throw notFound();

    // A temporary profile's passwords live in memory: they may be saved now.
    const session = temp ? this.sessionSecrets.get(temp.id) : undefined;
    const password = input.password || session?.password;
    const sshSecret = input.sshSecret || session?.sshSecret;

    let encryptedPassword = existing?.encryptedPassword;
    if (!input.savePassword) {
      encryptedPassword = undefined;
    } else if (password) {
      encryptedPassword = this.encrypt(password);
    }

    const ssh = input.type === 'sqlite' ? null : (input.ssh ?? null);
    // The SSH secret follows the same "save passwords" choice; an agent needs none.
    let encryptedSshSecret = existing?.encryptedSshSecret;
    if (!ssh || ssh.auth === 'agent' || ssh.auth === 'pageant' || !input.savePassword) {
      encryptedSshSecret = undefined;
    } else if (sshSecret) {
      encryptedSshSecret = this.encrypt(sshSecret);
    }

    const record = buildRecord(input, existing, existing?.id ?? randomUUID(), {
      encryptedPassword,
      encryptedSshSecret,
    });
    const isSaved = all.some((c) => c.id === record.id);
    const next = isSaved ? all.map((c) => (c.id === record.id ? record : c)) : [...all, record];
    await this.persist(next);
    if (temp) this.temporary.delete(temp.id);
    return toProfile(record);
  }

  async delete(id: string): Promise<void> {
    this.sessionSecrets.delete(id);
    if (this.temporary.delete(id)) return;
    const all = await this.load();
    if (!all.some((c) => c.id === id)) throw notFound();
    await this.persist(all.filter((c) => c.id !== id));
  }

  private async find(id: string): Promise<StoredConnection> {
    const record = (await this.load()).find((c) => c.id === id) ?? this.temporary.get(id);
    if (!record) throw notFound();
    return record;
  }

  private async load(): Promise<StoredConnection[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoreFile;
      this.cache = Array.isArray(parsed.connections) ? parsed.connections : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Keep the unreadable file for inspection instead of silently overwriting it.
        await fs
          .rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
          .catch(() => undefined);
      }
      this.cache = [];
    }
    return this.cache;
  }

  /** Atomic write: temp file then rename, serialised so concurrent saves can't interleave. */
  private persist(connections: StoredConnection[]): Promise<void> {
    this.cache = connections;
    const data: StoreFile = { version: 1, connections };
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, this.filePath);
    });
    return this.writing;
  }
}

function toProfile(
  { encryptedPassword, encryptedSshSecret, ...rest }: StoredConnection,
  temporary = false,
): ConnectionProfile {
  // Profiles saved before v0.4.0 have no readOnly field, before v0.8.0 no ssh.
  return {
    ...rest,
    readOnly: rest.readOnly ?? false,
    ssh: rest.ssh ?? null,
    hasPassword: Boolean(encryptedPassword),
    hasSshSecret: Boolean(encryptedSshSecret),
    temporary,
  };
}

function buildRecord(
  input: ConnectionInput,
  existing: StoredConnection | undefined,
  id: string,
  secrets: Pick<StoredConnection, 'encryptedPassword' | 'encryptedSshSecret'>,
): StoredConnection {
  const ssh = input.type === 'sqlite' ? null : (input.ssh ?? null);
  // A different SSH server must be confirmed again.
  const old = existing?.ssh;
  const hostKey =
    ssh && old && old.host === ssh.host.trim() && old.port === ssh.port
      ? ssh.hostKey || old.hostKey
      : (ssh?.hostKey ?? '');
  return {
    id,
    name: input.name.trim(),
    type: input.type,
    host: input.host.trim(),
    port: input.port,
    database: input.database.trim(),
    user: input.user.trim(),
    ssl: input.ssl,
    allowSelfSigned: input.ssl && input.allowSelfSigned,
    color: input.color,
    readOnly: input.readOnly,
    ssh: ssh
      ? {
          host: ssh.host.trim(),
          port: ssh.port,
          user: ssh.user.trim(),
          auth: ssh.auth,
          keyFile: ssh.auth === 'key' ? ssh.keyFile.trim() : '',
          hostKey,
        }
      : null,
    ...secrets,
  };
}

/** What makes two profiles "the same connection". Name, colour and options don't count. */
function matchKey(
  c: Pick<ConnectionInput, 'type' | 'host' | 'port' | 'database' | 'user' | 'ssh'>,
): string {
  const host = c.host.trim().toLowerCase();
  return JSON.stringify([
    c.type,
    c.type === 'sqlite' ? '' : host === '127.0.0.1' ? 'localhost' : host,
    c.port,
    c.database.trim(),
    c.user.trim(),
    c.ssh ? [c.ssh.host.trim().toLowerCase(), c.ssh.port, c.ssh.user.trim()] : null,
  ]);
}

function dropEmpty(secrets: ConnectSecrets): ConnectSecrets {
  return {
    ...(secrets.password && { password: secrets.password }),
    ...(secrets.sshSecret && { sshSecret: secrets.sshSecret }),
  };
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', 'Verbinding niet gevonden.');
}
