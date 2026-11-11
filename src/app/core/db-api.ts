import { InjectionToken } from '@angular/core';
import type { DbApi } from '../../../shared/ipc-contract';
import type { Result } from '../../../shared/models';

/**
 * The preload bridge (`window.dbApi`). Injected through a token so tests can supply a fake,
 * and so the app explains itself when opened in a plain browser instead of Electron.
 */
export const DB_API = new InjectionToken<DbApi>('DB_API', {
  providedIn: 'root',
  factory: () => (window as Window & { dbApi?: DbApi }).dbApi ?? browserFallback(),
});

function browserFallback(): DbApi {
  const fail = async <T>(): Promise<Result<T>> => ({
    ok: false,
    error: {
      code: 'NO_ELECTRON',
      message: 'Databasefuncties werken alleen in de desktop-app.',
      hint: 'Start de app met `npm run dev` in plaats van alleen `ng serve`.',
    },
  });
  return {
    appInfo: fail,
    pickDatabaseFile: fail,
    listConnections: fail,
    saveConnection: fail,
    deleteConnection: fail,
    testConnection: fail,
    connect: fail,
    disconnect: fail,
    listDatabases: fail,
    listObjects: fail,
    listColumns: fail,
    readRows: fail,
    countRows: fail,
    listAllColumns: fail,
    applyChanges: fail,
    runScript: fail,
    cancelScript: fail,
    closeEditor: fail,
    updateState: async () => ({ ok: true, data: { status: 'unsupported' } }),
    checkForUpdates: async () => ({ ok: true, data: { status: 'unsupported' } }),
    installUpdate: fail,
    onUpdateState: () => () => undefined,
  };
}
