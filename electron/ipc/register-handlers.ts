import { ipcMain, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron';
import { IPC, type AppInfo } from '../../shared/ipc-contract';
import type { ReleaseNote, Result } from '../../shared/models';
import type { ConnectionManager } from '../db/connection-manager';
import type { ConnectionStore, SecretCipher } from '../store/connection-store';
import type { Updater } from '../updater';
import { toDbError } from './errors';
import {
  changeSetSchema,
  connectionInputSchema,
  identifierSchema,
  idSchema,
  optionalIdSchema,
  connectSecretsSchema,
  fingerprintSchema,
  optionalPathSchema,
  rowsRequestSchema,
  runRequestSchema,
  tabIdSchema,
  whereSchema,
} from './schemas';

export interface HandlerDeps {
  store: ConnectionStore;
  manager: ConnectionManager;
  cipher: SecretCipher;
  updater: Updater;
  version: string;
  /** The OS open-file dialog (Electron's dialog.showOpenDialog on the main window). */
  /** Release notes bundled with the app (dist-electron/release-notes.json). */
  releaseNotes(): Promise<ReleaseNote[]>;
  /** Default folder for the key file dialog (~/.ssh). */
  sshDir?: string;
  pickFile(options: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
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
  const { store, manager, cipher, updater } = deps;

  const handle = <T>(channel: string, fn: (...args: unknown[]) => Promise<T> | T) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!deps.isTrustedSender(event)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: 'Onbekende afzender.' } };
      }
      return wrap(() => fn(...args));
    });
  };

  handle<AppInfo>(IPC.appInfo, () => ({
    encryptionAvailable: cipher.isAvailable(),
    version: deps.version,
  }));

  handle(IPC.pickDatabaseFile, async (rawCurrent) => {
    const current = optionalPathSchema.parse(rawCurrent);
    const result = await deps.pickFile({
      title: 'SQLite-database kiezen',
      defaultPath: current || undefined,
      properties: ['openFile'],
      filters: [
        { name: 'SQLite-databases', extensions: ['db', 'sqlite', 'sqlite3', 'db3', 's3db'] },
        { name: 'Alle bestanden', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle(IPC.pickKeyFile, async (rawCurrent) => {
    const current = optionalPathSchema.parse(rawCurrent);
    const result = await deps.pickFile({
      title: 'SSH-sleutel kiezen',
      defaultPath: current || deps.sshDir,
      properties: ['openFile', 'showHiddenFiles'],
      filters: [
        { name: 'Alle bestanden', extensions: ['*'] },
        { name: 'PuTTY-sleutels', extensions: ['ppk'] },
      ],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle(IPC.trustHostKey, (rawId, rawFingerprint) =>
    store.trustHostKey(idSchema.parse(rawId), fingerprintSchema.parse(rawFingerprint)),
  );

  handle(IPC.releaseNotes, () => deps.releaseNotes());

  handle(IPC.updateState, () => updater.getState());
  handle(IPC.checkForUpdates, () => updater.check());
  handle(IPC.installUpdate, () => updater.install());

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

  handle(IPC.connect, (rawId, rawSecrets) =>
    manager.connect(idSchema.parse(rawId), connectSecretsSchema.parse(rawSecrets)),
  );

  handle(IPC.disconnect, (rawId) => manager.disconnect(idSchema.parse(rawId)));

  // Schema browsing: always on an already open session, never opens a new connection.
  handle(IPC.listDatabases, (rawId) => manager.session(idSchema.parse(rawId)).listDatabases());

  handle(IPC.listObjects, (rawId, rawDb) =>
    manager.session(idSchema.parse(rawId)).listObjects(identifierSchema.parse(rawDb)),
  );

  handle(IPC.listColumns, (rawId, rawDb, rawTable) =>
    manager
      .session(idSchema.parse(rawId))
      .listColumns(identifierSchema.parse(rawDb), identifierSchema.parse(rawTable)),
  );

  handle(IPC.listAllColumns, (rawId, rawDb) =>
    manager.session(idSchema.parse(rawId)).listAllColumns(identifierSchema.parse(rawDb)),
  );

  // Table data: read-only and time-limited inside the driver.
  handle(IPC.readRows, (rawId, rawDb, rawTable, rawRequest) =>
    manager
      .session(idSchema.parse(rawId))
      .readRows(
        identifierSchema.parse(rawDb),
        identifierSchema.parse(rawTable),
        rowsRequestSchema.parse(rawRequest),
      ),
  );

  handle(IPC.countRows, (rawId, rawDb, rawTable, rawWhere) =>
    manager
      .session(idSchema.parse(rawId))
      .countRows(
        identifierSchema.parse(rawDb),
        identifierSchema.parse(rawTable),
        whereSchema.parse(rawWhere),
      ),
  );

  handle(IPC.applyChanges, (rawId, rawDb, rawTable, rawChanges) =>
    manager
      .session(idSchema.parse(rawId))
      .applyChanges(
        identifierSchema.parse(rawDb),
        identifierSchema.parse(rawTable),
        changeSetSchema.parse(rawChanges),
      ),
  );

  // SQL editor: a dedicated connection per tab; read-only profiles are enforced in the driver.
  handle(IPC.runScript, (rawId, rawTab, rawRequest) =>
    manager
      .session(idSchema.parse(rawId))
      .runScript(tabIdSchema.parse(rawTab), runRequestSchema.parse(rawRequest)),
  );

  handle(IPC.cancelScript, (rawId, rawTab) =>
    manager.session(idSchema.parse(rawId)).cancelScript(tabIdSchema.parse(rawTab)),
  );

  handle(IPC.closeEditor, async (rawId, rawTab) => {
    const id = idSchema.parse(rawId);
    // Closing a tab after disconnecting is fine: there is nothing left to close.
    if (manager.isConnected(id)) await manager.session(id).closeEditor(tabIdSchema.parse(rawTab));
  });
}
