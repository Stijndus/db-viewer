import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type DbApi } from '../shared/ipc-contract';

// Only these functions reach the renderer. No ipcRenderer, no Node, no generic invoke.
const api: DbApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  listConnections: () => ipcRenderer.invoke(IPC.listConnections),
  saveConnection: (input, id) => ipcRenderer.invoke(IPC.saveConnection, input, id),
  deleteConnection: (id) => ipcRenderer.invoke(IPC.deleteConnection, id),
  testConnection: (input, id) => ipcRenderer.invoke(IPC.testConnection, input, id),
  connect: (id, password) => ipcRenderer.invoke(IPC.connect, id, password),
  disconnect: (id) => ipcRenderer.invoke(IPC.disconnect, id),
  listDatabases: (id) => ipcRenderer.invoke(IPC.listDatabases, id),
  listObjects: (id, database) => ipcRenderer.invoke(IPC.listObjects, id, database),
  listColumns: (id, database, table) => ipcRenderer.invoke(IPC.listColumns, id, database, table),
  readRows: (id, database, table, request) =>
    ipcRenderer.invoke(IPC.readRows, id, database, table, request),
  countRows: (id, database, table, where) =>
    ipcRenderer.invoke(IPC.countRows, id, database, table, where),
};

contextBridge.exposeInMainWorld('dbApi', api);
