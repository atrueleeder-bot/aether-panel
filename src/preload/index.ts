import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('aether', {
  chooseDirectory: () => ipcRenderer.invoke('dialog:chooseDirectory'),
  getServers: () => ipcRenderer.invoke('servers:list'),
  getVersions: () => ipcRenderer.invoke('catalog:versions'),
  buildServer: (payload: unknown) => ipcRenderer.invoke('builder:build', payload),
  startServer: (id: string) => ipcRenderer.invoke('server:start', id),
  stopServer: (id: string) => ipcRenderer.invoke('server:stop', id),
  sendCommand: (id: string, command: string) => ipcRenderer.invoke('server:command', { id, command }),
  deleteServer: (id: string) => ipcRenderer.invoke('server:delete', id),
  checkRuntime: () => ipcRenderer.invoke('runtime:check'),
  sampleResources: () => ipcRenderer.invoke('resources:sample'),
  installGit: () => ipcRenderer.invoke('runtime:installGit'),
  searchMods: (payload: unknown) => ipcRenderer.invoke('modrinth:search', payload),
  installMod: (payload: unknown) => ipcRenderer.invoke('modrinth:install', payload),
  getUpdateState: () => ipcRenderer.invoke('updates:state'),
  saveUpdateSettings: (payload: unknown) => ipcRenderer.invoke('updates:settings', payload),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  getReleasePolicy: () => ipcRenderer.invoke('updates:policy'),
  onBuildEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('builder:event', listener);
    return () => ipcRenderer.removeListener('builder:event', listener);
  },
  onGitInstallEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('runtime:event', listener);
    return () => ipcRenderer.removeListener('runtime:event', listener);
  },
  onUpdateEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('update:event', listener);
    return () => ipcRenderer.removeListener('update:event', listener);
  },
  onServerState: (callback: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('server:state', listener);
    return () => ipcRenderer.removeListener('server:state', listener);
  },
  onServerOutput: (callback: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('server:output', listener);
    return () => ipcRenderer.removeListener('server:output', listener);
  },
});
