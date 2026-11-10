import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC, type AppInfo } from '../../shared/ipc-contract';
import type { Result } from '../../shared/models';
import type { ConnectionManager } from '../db/connection-manager';
import type { ConnectionStore, SecretCipher } from '../store/connection-store';
import { toDbError } from './errors';
import {
  connectionInputSchema,
  idSchema,
  optionalIdSchema,
  optionalPasswordSchema,
} from './schemas';

export interface HandlerDeps {
  store: ConnectionStore;
  manager: ConnectionManager;
  cipher: SecretCipher;
  /** Only messages from our own window are answered. */
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
}

/** Runs a handler and always resolves to a Result, so the renderer never sees a raw exception. */
export async function wrap<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: toDbError(err) };
  }
}

export function registerHandlers(deps: HandlerDeps): void {
  const { store, manager, cipher } = deps;

  const handle = <T>(channel: string, fn: (...args: unknown[]) => Promise<T> | T) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!deps.isTrustedSender(event)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: 'Onbekende afzender.' } };
      }
      return wrap(() => fn(...args));
    });
  };

  handle<AppInfo>(IPC.appInfo, () => ({ encryptionAvailable: cipher.isAvailable() }));

  handle(IPC.listConnections, () => store.list());

  handle(IPC.saveConnection, (rawInput, rawId) =>
    store.save(connectionInputSchema.parse(rawInput), optionalIdSchema.parse(rawId)),
  );

  handle(IPC.deleteConnection, async (rawId) => {
    const id = idSchema.parse(rawId);
    await manager.disconnect(id);
    await store.delete(id);
  });

  handle(IPC.testConnection, (rawInput, rawId) =>
    manager.test(connectionInputSchema.parse(rawInput), optionalIdSchema.parse(rawId)),
  );

  handle(IPC.connect, (rawId, rawPassword) =>
    manager.connect(idSchema.parse(rawId), optionalPasswordSchema.parse(rawPassword)),
  );

  handle(IPC.disconnect, (rawId) => manager.disconnect(idSchema.parse(rawId)));
}
