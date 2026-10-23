const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  forwardAdb: (port) => ipcRenderer.invoke('adb:forward', port),
  checkAdbDevices: () => ipcRenderer.invoke('adb:devices'),
  discoverBonjour: () => ipcRenderer.invoke('bonjour:discover'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url)
});
