const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startMicrosoftAuth: () => ipcRenderer.invoke('start-microsoft-auth'),
  pollForToken: (deviceCode, interval) => ipcRenderer.invoke('poll-for-token', deviceCode, interval),
  launchMinecraft: (version, authData) => ipcRenderer.invoke('launch-minecraft', version, authData),
  uploadSkin: (skinDataUrl, authToken) => ipcRenderer.invoke('upload-skin', skinDataUrl, authToken),
  openExternal: (url) => shell.openExternal(url),
  onLaunchStatus: (callback) => ipcRenderer.on('launch-status', (event, status) => callback(status))
});
