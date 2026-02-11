const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("launcherAPI", {
  startMinecraft: () => ipcRenderer.invoke("start-minecraft"),
  downloadMod: (url, name) => ipcRenderer.invoke("download-mod", url, name)
});
