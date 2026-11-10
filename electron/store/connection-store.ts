import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ConnectionInput, ConnectionProfile } from '../../shared/models';
import { AppError } from '../ipc/errors';

/** Encrypts secrets at rest. In the app this is Electron's safeStorage (OS keychain). */
export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(encrypted: string): string;
}

type StoredConnection = Omit<ConnectionProfile, 'hasPassword'> & { encryptedPassword?: string };

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
    const record = await this.find(id);
    if (!record.encryptedPassword) return undefined;
    try {
      return this.cipher.decrypt(record.encryptedPassword);
    } catch {
      throw new AppError(
        'DECRYPT_FAILED',
        'Opgeslagen wachtwoord kan niet worden ontsleuteld.',
        'Voer het wachtwoord opnieuw in bij Bewerken.',
      );
    }
  }

  async save(input: ConnectionInput, id?: string): Promise<ConnectionProfile> {
    const all = await this.load();
    const existing = id ? all.find((c) => c.id === id) : undefined;
    if (id && !existing) throw notFound();

    let encryptedPassword = existing?.encryptedPassword;
    if (!input.savePassword) {
      encryptedPassword = undefined;
    } else if (input.password) {
      if (!this.cipher.isAvailable()) {
        throw new AppError(
          'ENCRYPTION_UNAVAILABLE',
          'Wachtwoord kan niet veilig worden opgeslagen.',
          'De sleutelhanger van je besturingssysteem is niet beschikbaar. Sla op zonder wachtwoord.',
        );
      }
      encryptedPassword = this.cipher.encrypt(input.password);
    }

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
      encryptedPassword,
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

function toProfile({ encryptedPassword, ...rest }: StoredConnection): ConnectionProfile {
  return { ...rest, hasPassword: Boolean(encryptedPassword) };
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', 'Verbinding niet gevonden.');
}
