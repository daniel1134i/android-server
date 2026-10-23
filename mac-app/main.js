const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const dgram = require('dgram');
const http = require('http');
const os = require('os');

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

ipcMain.handle('adb:exec', async (event, command) => {
  return new Promise((resolve) => {
    exec(`adb shell ${command}`, (err, stdout, stderr) => {
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

// ========================================================
// ⚡ АВТО-СВЯЗЫВАНИЕ В 1 КЛИК (MULTI-STRATEGY ZERO-TOUCH PAIRING)
// ========================================================

function getLocalSubnetInfo() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        const parts = net.address.split('.');
        const subnetPrefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
        return {
          address: net.address,
          subnetPrefix,
          broadcast: `${subnetPrefix}.255`
        };
      }
    }
  }
  return { address: '127.0.0.1', subnetPrefix: '192.168.0', broadcast: '255.255.255.255' };
}

function probeHttpPair(ip, port = 8080, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`http://${ip}:${port}/api/pair`, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) return resolve(null);
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
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function discoverViaUdp(timeoutMs = 1800) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let resolved = false;

    socket.on('message', (msg, rinfo) => {
      try {
        const json = JSON.parse(msg.toString());
        if (json.server === 'AndroidAutonomousServer') {
          resolved = true;
          try { socket.close(); } catch (_) {}
          resolve({ ip: rinfo.address, port: json.port || 8080, info: json });
        }
      } catch (_) {}
    });

    socket.on('error', () => {
      if (!resolved) {
        try { socket.close(); } catch (_) {}
        resolve(null);
      }
    });

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
        const { broadcast } = getLocalSubnetInfo();
        socket.send('DISCOVER_ANDROID_SERVER', 8081, '255.255.255.255');
        if (broadcast && broadcast !== '255.255.255.255') {
          socket.send('DISCOVER_ANDROID_SERVER', 8081, broadcast);
        }
      } catch (_) {}
    });

    setTimeout(() => {
      if (!resolved) {
        try { socket.close(); } catch (_) {}
        resolve(null);
      }
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
  // Стратегия 1: Сверхбыстрый опрос по UDP 8081
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

  // Стратегия 2: ARP и параллельное сканирование локальной подсети Wi-Fi
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

  // Стратегия 3: Проверка USB ADB туннеля (если подключен по проводу)
  try {
    const usbPair = await probeHttpPair('127.0.0.1', 8080, 1000);
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

  return {
    success: false,
    error: 'Планшет не найден в локальной сети Wi-Fi. Убедитесь, что сервер запущен на планшете и оба устройства подключены к одному роутеру.'
  };
});

ipcMain.handle('pairing:factory-reset', async () => {
  try {
    const ses = mainWindow ? mainWindow.webContents.session : null;
    if (ses) {
      await ses.clearStorageData();
      await ses.clearCache();
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('open:external', async (event, url) => {
  shell.openExternal(url);
});
