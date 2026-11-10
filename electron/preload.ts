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
};

contextBridge.exposeInMainWorld('dbApi', api);
