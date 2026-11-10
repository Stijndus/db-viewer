import type { ConnectionInput } from '../shared/models';
import type { SecretCipher } from './store/connection-store';

/** Reversible fake cipher for tests: proves the plain password never lands on disk. */
export function fakeCipher(available = true): SecretCipher {
  return {
    isAvailable: () => available,
    encrypt: (plain) => 'enc:' + Buffer.from(plain).toString('base64'),
    decrypt: (enc) => Buffer.from(enc.slice(4), 'base64').toString(),
  };
}

export function input(overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    name: 'lokaal-dev',
    type: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    database: 'app_dev',
    user: 'viewer',
    ssl: false,
    allowSelfSigned: false,
    color: 'green',
    password: 'test123',
    savePassword: true,
    ...overrides,
  };
}
