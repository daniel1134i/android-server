const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const dgram = require('dgram');
const http = require('http');
const os = require('os');

// ========================================================
// 🛡️ ГЛОБАЛЬНАЯ ЗАЩИТА ОТ КРАШЕЙ (MAIN PROCESS ERROR HANDLING)
// ========================================================
process.on('uncaughtException', (err) => {
  console.error('[Main Uncaught Exception]', err);
});

process.on('unhandledRejection', (reason) => {
  console.warn('[Main Unhandled Rejection]', reason);
});

// Настройка PATH для macOS (чтобы adb находился при запуске из Finder / Dock / .app)
const extraPaths = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  `${os.homedir()}/Library/Android/sdk/platform-tools`,
  `${os.homedir()}/android-sdk/platform-tools`
];
process.env.PATH = Array.from(new Set([...extraPaths, ...(process.env.PATH ? process.env.PATH.split(':') : [])])).join(':');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#191a1b',
    titleBarStyle: 'hiddenInset',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[Renderer Process Gone]', details);
    if (details.reason !== 'clean-exit' && !mainWindow.isDestroyed()) {
      mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    }
  });

  mainWindow.on('unresponsive', () => {
    console.warn('[MainWindow Unresponsive]');
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, 'icon.png')); } catch (_) {}
  }
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
        resolve({ success: false, error: (stderr || err.message || '').trim() });
      } else {
        resolve({ success: true, output: (stdout || 'Port forwarded').trim() });
      }
    });
  });
});

ipcMain.handle('adb:devices', async () => {
  return new Promise((resolve) => {
    exec('adb devices -l', (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: (stderr || err.message || '').trim() });
      } else {
        resolve({ success: true, output: (stdout || '').trim() });
      }
    });
  });
});

ipcMain.handle('adb:exec', async (event, command) => {
  return new Promise((resolve) => {
    const cleanCmd = (command || '').replace(/"/g, '\\"');
    exec(`adb shell "${cleanCmd}"`, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: (stderr || err.message || '').trim() });
      } else {
        resolve({ success: true, output: (stdout || '').trim() });
      }
    });
  });
});

function discoverViaBonjourHelper() {
  return new Promise((resolve) => {
    exec("dns-sd -L AndroidServerNode _androidserver._tcp local & PID=$!; sleep 1.5; kill $PID 2>/dev/null", (err, stdout) => {
      const out = stdout || '';
      const hostMatch = out.match(/can be reached at ([^:]+):(\d+)/);
      if (hostMatch) {
        const hostname = hostMatch[1].trim();
        const port = parseInt(hostMatch[2], 10) || 8080;
        const cleanHost = hostname.replace(/[^a-zA-Z0-9_.-]/g, '');
        exec(`dns-sd -G v4 "${cleanHost}" & PID=$!; sleep 1.2; kill $PID 2>/dev/null`, (err2, stdout2) => {
          const out2 = stdout2 || '';
          const ipMatch = out2.match(/(\d+\.\d+\.\d+\.\d+)/);
          if (ipMatch) {
            resolve({ success: true, ip: ipMatch[1], hostname: cleanHost, port });
          } else {
            resolve({ success: true, ip: cleanHost.replace(/\.$/, ''), hostname: cleanHost, port });
          }
        });
      } else {
        resolve({ success: false, error: 'Tablet not detected via Bonjour' });
      }
    });
  });
}

ipcMain.handle('bonjour:discover', async () => {
  return await discoverViaBonjourHelper();
});

// ========================================================
// ⚡ АВТО-СВЯЗЫВАНИЕ В 1 КЛИК (MULTI-STRATEGY ZERO-TOUCH PAIRING)
// ========================================================

function getLocalSubnetInfo() {
  const ifaces = os.networkInterfaces();
  const subnets = [];

  // Приоритет физическим интерфейсам en0, en1
  const sortedNames = Object.keys(ifaces).sort((a, b) => {
    if (a.startsWith('en') && !b.startsWith('en')) return -1;
    if (!a.startsWith('en') && b.startsWith('en')) return 1;
    return a.localeCompare(b);
  });

  for (const name of sortedNames) {
    if (name.startsWith('utun') || name.startsWith('awdl') || name.startsWith('llw')) continue;
    for (const net of ifaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        const parts = net.address.split('.');
        const subnetPrefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
        subnets.push({
          address: net.address,
          subnetPrefix,
          broadcast: `${subnetPrefix}.255`
        });
      }
    }
  }

  if (subnets.length > 0) return subnets[0];
  return { address: '127.0.0.1', subnetPrefix: '192.168.0', broadcast: '255.255.255.255' };
}

function probeHttpPair(ip, port = 8080, timeoutMs = 1500) {
  return new Promise((resolve) => {
    try {
      const req = http.get(`http://${ip}:${port}/api/pair`, { timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data && data.status === 'paired') {
              return resolve(data);
            }
          } catch (_) {}
          resolve(null);
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        try { req.destroy(); } catch (_) {}
        resolve(null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function discoverViaUdp(timeoutMs = 1800) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = dgram.createSocket('udp4');
    } catch (_) {
      return resolve(null);
    }

    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        try { socket.close(); } catch (_) {}
      }
    };

    socket.on('message', (msg, rinfo) => {
      try {
        const json = JSON.parse(msg.toString());
        if (json.server === 'AndroidAutonomousServer') {
          cleanup();
          resolve({ ip: rinfo.address, port: json.port || 8080, info: json });
        }
      } catch (_) {}
    });

    socket.on('error', () => {
      cleanup();
      resolve(null);
    });

    try {
      socket.bind(0, () => {
        try {
          socket.setBroadcast(true);
          const { broadcast } = getLocalSubnetInfo();
          socket.send('DISCOVER_ANDROID_SERVER', 8081, '255.255.255.255', () => {});
          if (broadcast && broadcast !== '255.255.255.255') {
            socket.send('DISCOVER_ANDROID_SERVER', 8081, broadcast, () => {});
          }
        } catch (_) {}
      });
    } catch (_) {
      cleanup();
      return resolve(null);
    }

    setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
  });
}

function discoverViaArpAndScan() {
  return new Promise((resolve) => {
    exec('arp -a', async (err, stdout) => {
      const candidates = [];
      if (stdout) {
        const lines = stdout.split('\n');
        for (const line of lines) {
          const match = line.match(/\((\d+\.\d+\.\d+\.\d+)\)/);
          if (match) {
            const ip = match[1];
            if (line.toLowerCase().includes('redmi') || line.toLowerCase().includes('android') || line.toLowerCase().includes('xiaomi')) {
              candidates.unshift(ip);
            } else if (ip !== '127.0.0.1') {
              candidates.push(ip);
            }
          }
        }
      }

      const { subnetPrefix } = getLocalSubnetInfo();
      const priorityRange = [82, 80, 81, 100, 101, 102, 105, 110, 150, 179, 199];
      for (const host of priorityRange) {
        const ip = `${subnetPrefix}.${host}`;
        if (!candidates.includes(ip)) candidates.push(ip);
      }

      const checks = candidates.slice(0, 30).map(ip => probeHttpPair(ip, 8080, 1200).then(data => data ? { ip, data } : null));
      const results = await Promise.all(checks);
      const found = results.find(r => r !== null);
      resolve(found || null);
    });
  });
}

ipcMain.handle('pairing:auto-pair', async () => {
  // Стратегия 1: Мгновенная проверка USB ADB туннеля (если подключен по кабелю)
  try {
    const usbPair = await probeHttpPair('127.0.0.1', 8080, 800);
    if (usbPair) {
      return {
        success: true,
        method: 'usb',
        ip: usbPair.wifi_ip || '127.0.0.1',
        port: 8080,
        node_id: usbPair.node_id,
        secret_key: usbPair.secret_key,
        relay_url: usbPair.relay_url,
        device: usbPair.device || {},
        paired_at: usbPair.paired_at
      };
    }
  } catch (_) {}

  // Стратегия 2: Apple Bonjour / mDNS (нативный протокол macOS)
  try {
    const bonjourRes = await discoverViaBonjourHelper();
    if (bonjourRes && bonjourRes.success && bonjourRes.ip) {
      const pairData = await probeHttpPair(bonjourRes.ip, bonjourRes.port || 8080, 1800);
      if (pairData) {
        return {
          success: true,
          method: 'bonjour',
          ip: bonjourRes.ip,
          port: bonjourRes.port || 8080,
          node_id: pairData.node_id,
          secret_key: pairData.secret_key,
          relay_url: pairData.relay_url,
          device: pairData.device || {},
          paired_at: pairData.paired_at
        };
      }
    }
  } catch (_) {}

  // Стратегия 3: Быстрый опрос по UDP 8081
  try {
    const udpResult = await discoverViaUdp(1600);
    if (udpResult && udpResult.ip) {
      const pairData = await probeHttpPair(udpResult.ip, udpResult.port || 8080, 2000);
      if (pairData) {
        return {
          success: true,
          method: 'udp',
          ip: udpResult.ip,
          port: udpResult.port || 8080,
          node_id: pairData.node_id,
          secret_key: pairData.secret_key,
          relay_url: pairData.relay_url,
          device: pairData.device || {},
          paired_at: pairData.paired_at
        };
      }
    }
  } catch (_) {}

  // Стратегия 4: ARP и параллельное сканирование локальной подсети Wi-Fi
  try {
    const scanResult = await discoverViaArpAndScan();
    if (scanResult && scanResult.ip && scanResult.data) {
      return {
        success: true,
        method: 'subnet_scan',
        ip: scanResult.ip,
        port: scanResult.data.port || 8080,
        node_id: scanResult.data.node_id,
        secret_key: scanResult.data.secret_key,
        relay_url: scanResult.data.relay_url,
        device: scanResult.data.device || {},
        paired_at: scanResult.data.paired_at
      };
    }
  } catch (_) {}

  return {
    success: false,
    error: 'Планшет не найден. Убедитесь, что сервер запущен на планшете и подключен по Wi-Fi или USB-кабелю.'
  };
});

ipcMain.handle('pairing:factory-reset', async () => {
  try {
    const targetSession = (mainWindow && !mainWindow.isDestroyed())
      ? mainWindow.webContents.session
      : session.defaultSession;

    if (targetSession) {
      await targetSession.clearStorageData({
        storages: ['cookies', 'localstorage', 'caches', 'indexdb', 'websql', 'serviceworkers', 'cachestorage']
      });
      await targetSession.clearCache();
    }
    return { success: true };
  } catch (err) {
    console.error('Factory reset session error in main:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('open:external', async (event, url) => {
  try {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      await shell.openExternal(url);
    }
  } catch (e) {
    console.error('Error opening external URL:', e);
  }
});
