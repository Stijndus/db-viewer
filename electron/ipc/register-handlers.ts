import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import { IPC, TRANSFER_EVENT, type AppInfo } from '../../shared/ipc-contract';
import { exportData } from '../transfer/export';
import { inspectImportFile, importSql } from '../transfer/sql-import';
import path from 'node:path';
import type {
  ExportRequest,
  LaunchRequest,
  ReleaseNote,
  Result,
  TransferProgress,
} from '../../shared/models';
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
  exportRequestSchema,
  fileNameSchema,
  filePathSchema,
  jobIdSchema,
  sqlImportRequestSchema,
  fingerprintSchema,
  optionalPasswordSchema,
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
  pickSaveFile(options: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>;
  showInFolder(file: string): void;
  documentsDir?: string;
  setAppearance(background: string): void;
  zoom(action: 'in' | 'out' | 'reset' | 'get'): number;
  /** Sends an event to the window (import and export progress). */
  send(channel: string, payload: unknown): void;
  /** The command line's launch, once; null afterwards. */
  takeLaunch(): Promise<LaunchRequest | null>;
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
  handle(IPC.takeLaunch, () => deps.takeLaunch());

  handle(IPC.setAppearance, (raw) => {
    const { background } = z.object({ background: z.string().regex(/^#[0-9a-f]{6}$/i) }).parse(raw);
    deps.setAppearance(background);
  });
  handle(IPC.zoom, (raw) => deps.zoom(z.enum(['in', 'out', 'reset', 'get']).parse(raw)));

  // Import and export: long jobs that report progress as events and can be cancelled.
  const jobs = new Map<string, AbortController>();

  handle(IPC.pickImportFile, async (rawCurrent) => {
    const current = optionalPathSchema.parse(rawCurrent);
    const result = await deps.pickFile({
      title: 'SQL-bestand of archief kiezen',
      defaultPath: current || undefined,
      properties: ['openFile'],
      filters: [
        { name: 'SQL-scripts en archieven', extensions: ['sql', 'gz', 'zip', '7z', 'txt'] },
        { name: 'Alle bestanden', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle(IPC.inspectImportFile, (rawFile, rawPassword) =>
    inspectImportFile(filePathSchema.parse(rawFile), optionalPasswordSchema.parse(rawPassword)),
  );

  handle(IPC.startSqlImport, async (rawId, rawRequest) => {
    const id = idSchema.parse(rawId);
    const request = sqlImportRequestSchema.parse(rawRequest);
    const session = manager.session(id);
    const profile = await store.get(id);
    const jobId = randomUUID();
    const controller = new AbortController();
    jobs.set(jobId, controller);
    const report = (p: TransferProgress) => deps.send(TRANSFER_EVENT, p);
    void importSql(
      session,
      profile.type,
      profile.readOnly,
      request,
      jobId,
      report,
      controller.signal,
    )
      .then(report, (err: unknown) =>
        report({
          jobId,
          kind: 'import',
          phase: controller.signal.aborted ? 'cancelled' : 'failed',
          bytes: 0,
          totalBytes: null,
          statements: 0,
          failed: 0,
          errors: [],
          error: toDbError(err),
        }),
      )
      .finally(() => jobs.delete(jobId));
    return { jobId };
  });

  /** Files exports wrote this run: only these may be shown in the file manager. */
  const written = new Set<string>();

  handle(IPC.pickExportFile, async (rawName) => {
    const name = fileNameSchema.parse(rawName);
    const result = await deps.pickSaveFile({
      title: 'Exporteren naar',
      defaultPath: path.join(deps.documentsDir ?? '', name),
      filters: [{ name: 'Alle bestanden', extensions: ['*'] }],
    });
    return result.canceled || !result.filePath ? null : result.filePath;
  });

  handle(IPC.startExport, async (rawId, rawRequest) => {
    const id = idSchema.parse(rawId);
    const request = exportRequestSchema.parse(rawRequest) as ExportRequest;
    const session = manager.session(id);
    const profile = await store.get(id);
    const jobId = randomUUID();
    const controller = new AbortController();
    jobs.set(jobId, controller);
    const report = (p: TransferProgress) => deps.send(TRANSFER_EVENT, p);
    void exportData(session, profile.type, request, jobId, report, controller.signal)
      .then((p) => {
        if (p.phase === 'done') written.add(request.file);
        report(p);
      })
      .catch((err: unknown) =>
        report({
          jobId,
          kind: 'export',
          phase: 'failed',
          bytes: 0,
          totalBytes: null,
          statements: 0,
          failed: 0,
          errors: [],
          error: toDbError(err),
        }),
      )
      .finally(() => jobs.delete(jobId));
    return { jobId };
  });

  handle(IPC.showInFolder, (rawFile) => {
    const file = filePathSchema.parse(rawFile);
    if (written.has(file)) deps.showInFolder(file);
  });

  handle(IPC.cancelTransfer, (rawJob) => {
    jobs.get(jobIdSchema.parse(rawJob))?.abort();
  });

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
