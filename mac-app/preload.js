const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  forwardAdb: (port) => ipcRenderer.invoke('adb:forward', port),
  checkAdbDevices: () => ipcRenderer.invoke('adb:devices'),
  execAdb: (cmd) => ipcRenderer.invoke('adb:exec', cmd),
  discoverBonjour: () => ipcRenderer.invoke('bonjour:discover'),
  autoPairWifi: () => ipcRenderer.invoke('pairing:auto-pair'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url)
});
