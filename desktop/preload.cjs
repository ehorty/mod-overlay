'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modOverlay', {
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  apply: (setup) => ipcRenderer.invoke('desktop:apply', setup),
  openPanel: () => ipcRenderer.invoke('desktop:open-panel'),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
  copy: (text) => ipcRenderer.invoke('desktop:copy', text),
  openDataFolder: () => ipcRenderer.invoke('desktop:open-data'),
  restartServer: () => ipcRenderer.invoke('desktop:restart'),
  onRefresh: (handler) => {
    const listener = () => {
      try {
        handler();
      } catch {
        /* ignore */
      }
    };
    ipcRenderer.on('desktop:refresh', listener);
    return () => ipcRenderer.removeListener('desktop:refresh', listener);
  },
});
