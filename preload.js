const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startMicrosoftAuth: () => ipcRenderer.invoke('start-microsoft-auth')
});
