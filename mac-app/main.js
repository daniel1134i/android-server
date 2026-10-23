const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { exec } = require('child_process');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#181816',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC handlers for ADB and network operations
ipcMain.handle('adb:forward', async (event, port = 8080) => {
  return new Promise((resolve) => {
    exec(`adb forward tcp:${port} tcp:${port}`, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: stderr || err.message });
      } else {
        resolve({ success: true, output: stdout.trim() || 'Port forwarded' });
      }
    });
  });
});

ipcMain.handle('adb:devices', async () => {
  return new Promise((resolve) => {
    exec('adb devices -l', (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: stderr || err.message });
      } else {
        resolve({ success: true, output: stdout.trim() });
      }
    });
  });
});

ipcMain.handle('open:external', async (event, url) => {
  shell.openExternal(url);
});
