const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startMicrosoftAuth: () => ipcRenderer.invoke('start-microsoft-auth'),
  openExternal: (url) => shell.openExternal(url)
});
