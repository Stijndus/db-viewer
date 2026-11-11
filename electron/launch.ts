import type { LaunchRequest } from '../shared/models';
import type { CliCommand } from './cli';
import { toDbError } from './ipc/errors';
import { connectionInputSchema } from './ipc/schemas';
import type { ConnectionStore } from './store/connection-store';

/** What a launch from the command line carries, also from a second instance to the first. */
export interface LaunchData {
  args: string[];
  cwd: string;
  /** Only the variables the command line uses (passwords, user name). */
  env: Record<string, string | undefined>;
}

export const LAUNCH_ENV = [
  'DBV_PASSWORD',
  'DBV_SSH_PASSWORD',
  'DBV_SSH_PASSPHRASE',
  'USERNAME',
  'USER',
] as const;

export function launchEnv(env: NodeJS.ProcessEnv): LaunchData['env'] {
  return Object.fromEntries(LAUNCH_ENV.filter((k) => env[k]).map((k) => [k, env[k]]));
}

/**
 * Turns a parsed command line into a connection the window can open: a saved profile by name, a
 * profile that already matches, a new saved one (--save), or a temporary one for this run.
 * Passwords from the command line are kept in memory for this run only.
 */
export async function resolveLaunch(
  command: CliCommand,
  store: ConnectionStore,
  canSavePasswords: boolean,
): Promise<LaunchRequest | null> {
  try {
    switch (command.kind) {
      case 'none':
      case 'help':
      case 'version':
        return null;
      case 'error':
        return command.hint
          ? { kind: 'error', message: command.message, hint: command.hint }
          : { kind: 'error', message: command.message };
      case 'saved': {
        const all = await store.list();
        const wanted = command.name.toLocaleLowerCase();
        const found =
          all.find((c) => c.name === command.name) ??
          all.find((c) => c.name.toLocaleLowerCase() === wanted);
        if (!found) {
          const names = all.filter((c) => !c.temporary).map((c) => `"${c.name}"`);
          return {
            kind: 'error',
            message: `Geen opgeslagen verbinding met de naam "${command.name}".`,
            hint: names.length
              ? `Opgeslagen: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}.`
              : 'Er zijn nog geen opgeslagen verbindingen.',
          };
        }
        store.setSessionSecrets(found.id, command.secrets);
        return { kind: 'open', connectionId: found.id };
      }
      case 'connect': {
        const input = connectionInputSchema.parse(command.input);
        const secrets = { password: input.password ?? '', sshSecret: input.sshSecret ?? '' };
        const match = await store.findMatch(input);
        if (match) {
          store.setSessionSecrets(match.id, secrets);
          if (command.save && match.temporary) {
            await store.save({ ...input, savePassword: canSavePasswords }, match.id);
          }
          return { kind: 'open', connectionId: match.id };
        }
        if (command.save) {
          const saved = await store.save({ ...input, savePassword: canSavePasswords });
          store.setSessionSecrets(saved.id, secrets);
          return { kind: 'open', connectionId: saved.id };
        }
        return { kind: 'open', connectionId: store.addTemporary(input).id };
      }
    }
  } catch (err) {
    const e = toDbError(err);
    return {
      kind: 'error',
      message: `Kan de verbinding van de opdrachtregel niet openen: ${e.message}`,
      ...(e.hint && { hint: e.hint }),
    };
  }
}
