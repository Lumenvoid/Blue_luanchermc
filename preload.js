const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startMicrosoftAuth: () => ipcRenderer.invoke('start-microsoft-auth'),
  pollForToken: (deviceCode, interval) => ipcRenderer.invoke('poll-for-token', deviceCode, interval),
  openExternal: (url) => shell.openExternal(url)
});
