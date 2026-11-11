import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ConnectionInput, ConnectionProfile, SshSettings } from '../../shared/models';
import { AppError } from '../ipc/errors';

/** Encrypts secrets at rest. In the app this is Electron's safeStorage (OS keychain). */
export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(encrypted: string): string;
}

type StoredConnection = Omit<ConnectionProfile, 'hasPassword' | 'hasSshSecret' | 'ssh'> & {
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

  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher,
  ) {}

  async list(): Promise<ConnectionProfile[]> {
    const all = await this.load();
    return all.map(toProfile).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<ConnectionProfile> {
    return toProfile(await this.find(id));
  }

  /** The stored password in plain text, or undefined when none is stored. Main process only. */
  async getPassword(id: string): Promise<string | undefined> {
    return this.decrypt((await this.find(id)).encryptedPassword);
  }

  /** The stored SSH password or key passphrase, or undefined. Main process only. */
  async getSshSecret(id: string): Promise<string | undefined> {
    return this.decrypt((await this.find(id)).encryptedSshSecret);
  }

  /** Remembers the SSH server's host key after the user confirmed its fingerprint. */
  async trustHostKey(id: string, fingerprint: string): Promise<ConnectionProfile> {
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

  async save(input: ConnectionInput, id?: string): Promise<ConnectionProfile> {
    const all = await this.load();
    const existing = id ? all.find((c) => c.id === id) : undefined;
    if (id && !existing) throw notFound();

    let encryptedPassword = existing?.encryptedPassword;
    if (!input.savePassword) {
      encryptedPassword = undefined;
    } else if (input.password) {
      encryptedPassword = this.encrypt(input.password);
    }

    const ssh = input.type === 'sqlite' ? null : (input.ssh ?? null);
    // The SSH secret follows the same "save passwords" choice; an agent needs none.
    let encryptedSshSecret = existing?.encryptedSshSecret;
    if (!ssh || ssh.auth === 'agent' || ssh.auth === 'pageant' || !input.savePassword) {
      encryptedSshSecret = undefined;
    } else if (input.sshSecret) {
      encryptedSshSecret = this.encrypt(input.sshSecret);
    }
    // A different SSH server must be confirmed again.
    const old = existing?.ssh;
    const hostKey =
      ssh && old && old.host === ssh.host.trim() && old.port === ssh.port
        ? ssh.hostKey || old.hostKey
        : (ssh?.hostKey ?? '');

    const record: StoredConnection = {
      id: existing?.id ?? randomUUID(),
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
      encryptedPassword,
      encryptedSshSecret,
    };

    const next = existing ? all.map((c) => (c.id === record.id ? record : c)) : [...all, record];
    await this.persist(next);
    return toProfile(record);
  }

  async delete(id: string): Promise<void> {
    const all = await this.load();
    if (!all.some((c) => c.id === id)) throw notFound();
    await this.persist(all.filter((c) => c.id !== id));
  }

  private async find(id: string): Promise<StoredConnection> {
    const record = (await this.load()).find((c) => c.id === id);
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

function toProfile({
  encryptedPassword,
  encryptedSshSecret,
  ...rest
}: StoredConnection): ConnectionProfile {
  // Profiles saved before v0.4.0 have no readOnly field, before v0.8.0 no ssh.
  return {
    ...rest,
    readOnly: rest.readOnly ?? false,
    ssh: rest.ssh ?? null,
    hasPassword: Boolean(encryptedPassword),
    hasSshSecret: Boolean(encryptedSshSecret),
  };
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', 'Verbinding niet gevonden.');
}
