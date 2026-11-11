import { contextBridge, ipcRenderer } from 'electron';
import { IPC, LAUNCH_EVENT, UPDATE_STATE_EVENT, type DbApi } from '../shared/ipc-contract';
import type { LaunchRequest, UpdateState } from '../shared/models';

// Only these functions reach the renderer. No ipcRenderer, no Node, no generic invoke.
const api: DbApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  pickDatabaseFile: (current) => ipcRenderer.invoke(IPC.pickDatabaseFile, current),
  pickKeyFile: (current) => ipcRenderer.invoke(IPC.pickKeyFile, current),
  trustHostKey: (id, fingerprint) => ipcRenderer.invoke(IPC.trustHostKey, id, fingerprint),
  listConnections: () => ipcRenderer.invoke(IPC.listConnections),
  saveConnection: (input, id) => ipcRenderer.invoke(IPC.saveConnection, input, id),
  deleteConnection: (id) => ipcRenderer.invoke(IPC.deleteConnection, id),
  testConnection: (input, id) => ipcRenderer.invoke(IPC.testConnection, input, id),
  connect: (id, secrets) => ipcRenderer.invoke(IPC.connect, id, secrets),
  disconnect: (id) => ipcRenderer.invoke(IPC.disconnect, id),
  listDatabases: (id) => ipcRenderer.invoke(IPC.listDatabases, id),
  listObjects: (id, database) => ipcRenderer.invoke(IPC.listObjects, id, database),
  listColumns: (id, database, table) => ipcRenderer.invoke(IPC.listColumns, id, database, table),
  listAllColumns: (id, database) => ipcRenderer.invoke(IPC.listAllColumns, id, database),
  readRows: (id, database, table, request) =>
    ipcRenderer.invoke(IPC.readRows, id, database, table, request),
  countRows: (id, database, table, where) =>
    ipcRenderer.invoke(IPC.countRows, id, database, table, where),
  applyChanges: (id, database, table, changes) =>
    ipcRenderer.invoke(IPC.applyChanges, id, database, table, changes),
  runScript: (id, tabId, request) => ipcRenderer.invoke(IPC.runScript, id, tabId, request),
  cancelScript: (id, tabId) => ipcRenderer.invoke(IPC.cancelScript, id, tabId),
  closeEditor: (id, tabId) => ipcRenderer.invoke(IPC.closeEditor, id, tabId),
  updateState: () => ipcRenderer.invoke(IPC.updateState),
  checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates),
  installUpdate: () => ipcRenderer.invoke(IPC.installUpdate),
  releaseNotes: () => ipcRenderer.invoke(IPC.releaseNotes),
  takeLaunch: () => ipcRenderer.invoke(IPC.takeLaunch),
  onLaunch: (listener) => {
    const handler = (_event: unknown, launch: LaunchRequest) => listener(launch);
    ipcRenderer.on(LAUNCH_EVENT, handler);
    return () => ipcRenderer.removeListener(LAUNCH_EVENT, handler);
  },
  onUpdateState: (listener) => {
    const handler = (_event: unknown, state: UpdateState) => listener(state);
    ipcRenderer.on(UPDATE_STATE_EVENT, handler);
    return () => ipcRenderer.removeListener(UPDATE_STATE_EVENT, handler);
  },
};

contextBridge.exposeInMainWorld('dbApi', api);
