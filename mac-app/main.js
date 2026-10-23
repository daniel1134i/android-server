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

ipcMain.handle('bonjour:discover', async () => {
  return new Promise((resolve) => {
    exec("dns-sd -L AndroidServerNode _androidserver._tcp local & PID=$!; sleep 1.5; kill $PID 2>/dev/null", (err, stdout) => {
      const hostMatch = stdout.match(/can be reached at ([^:]+):(\d+)/);
      if (hostMatch) {
        const hostname = hostMatch[1].trim();
        const port = parseInt(hostMatch[2], 10) || 8080;
        exec(`dns-sd -G v4 ${hostname} & PID=$!; sleep 1.2; kill $PID 2>/dev/null`, (err2, stdout2) => {
          const ipMatch = stdout2.match(/(\d+\.\d+\.\d+\.\d+)/);
          if (ipMatch) {
            resolve({ success: true, ip: ipMatch[1], hostname, port });
          } else {
            resolve({ success: true, ip: hostname.replace(/\.$/, ''), hostname, port });
          }
        });
      } else {
        resolve({ success: false, error: 'Tablet not detected via Bonjour' });
      }
    });
  });
});

ipcMain.handle('open:external', async (event, url) => {
  shell.openExternal(url);
});
