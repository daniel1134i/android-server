let isDimmed = false;
let isRunning = true;
let lastLogCount = 0;

// DOM Elements
const badgeDaemon = document.getElementById('badgeDaemon');
const badgeWifi = document.getElementById('badgeWifi');
const badgeBattery = document.getElementById('badgeBattery');
const pulseLed = document.getElementById('pulseLed');
const txtDaemonTitle = document.getElementById('txtDaemonTitle');
const txtDaemonSub = document.getElementById('txtDaemonSub');
const valWifiUrl = document.getElementById('valWifiUrl');

const btnDimScreen = document.getElementById('btnDimScreen');
const btnToggleDaemon = document.getElementById('btnToggleDaemon');
const btnClearLogs = document.getElementById('btnClearLogs');

const valBatStatus = document.getElementById('valBatStatus');
const valBatPct = document.getElementById('valBatPct');
const valBatTemp = document.getElementById('valBatTemp');
const barBat = document.getElementById('barBat');
const valBatSource = document.getElementById('valBatSource');
const valBatHealth = document.getElementById('valBatHealth');

const valRamPct = document.getElementById('valRamPct');
const valRamUsed = document.getElementById('valRamUsed');
const valRamTotal = document.getElementById('valRamTotal');
const barRam = document.getElementById('barRam');
const valCpuCores = document.getElementById('valCpuCores');
const valCpuArch = document.getElementById('valCpuArch');

const valDiskPct = document.getElementById('valDiskPct');
const valDiskUsed = document.getElementById('valDiskUsed');
const valDiskTotal = document.getElementById('valDiskTotal');
const barDisk = document.getElementById('barDisk');
const valDaemonUptime = document.getElementById('valDaemonUptime');
const valSysUptime = document.getElementById('valSysUptime');
const valDeviceModel = document.getElementById('valDeviceModel');

const logStreamBox = document.getElementById('logStreamBox');

// Helpers
function formatSeconds(sec) {
  if (!sec && sec !== 0) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}h ${m}m ${s}s`;
}

function appendLogEntry(msg, level = 'INFO', timestamp = null) {
  const row = document.createElement('div');
  row.className = 'log-row';

  const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
  
  if (msg.includes('GET') || msg.includes('POST')) {
    row.classList.add('http');
  } else if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
    row.classList.add('err');
  } else if (msg.toLowerCase().includes('warn') || msg.toLowerCase().includes('battery')) {
    row.classList.add('warn');
  } else if (msg.toLowerCase().includes('started') || msg.toLowerCase().includes('online')) {
    row.classList.add('green');
  } else {
    row.classList.add('sys');
  }

  row.textContent = `[${timeStr}] [${level}] ${msg}`;
  logStreamBox.appendChild(row);

  if (logStreamBox.children.length > 250) {
    logStreamBox.removeChild(logStreamBox.firstChild);
  }

  logStreamBox.scrollTop = logStreamBox.scrollHeight;
}

// Fetch Status
async function pollStatus() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error('Offline');
    const data = await res.json();

    // Daemon Online
    isRunning = true;
    badgeDaemon.className = 'badge badge-online';
    badgeDaemon.textContent = '● DAEMON: ONLINE';
    pulseLed.style.background = 'var(--agy-green)';
    pulseLed.style.boxShadow = '0 0 10px var(--agy-green)';
    txtDaemonTitle.textContent = 'DAEMON ACTIVE & LISTENING';
    txtDaemonTitle.style.color = '#94c55f';
    txtDaemonSub.textContent = 'Accepting HTTP/JSON RPC requests on port 8080 & mDNS discovery on 8081';
    btnToggleDaemon.className = 'btn-node btn-toggle';
    btnToggleDaemon.innerHTML = '<span class="btn-icon">⏻</span> STOP DAEMON';

    // Battery
    const bat = data.battery || {};
    const batPct = bat.percent || 0;
    valBatPct.textContent = `${batPct}%`;
    valBatTemp.textContent = `${bat.temp_c || 0}°C`;
    barBat.style.width = `${batPct}%`;
    valBatStatus.textContent = (bat.status || 'CHARGING').toUpperCase();
    valBatSource.textContent = bat.plugged || 'AC Wall Charger';
    valBatHealth.textContent = bat.health || 'Good';
    badgeBattery.textContent = `🔋 ${batPct}%`;

    // RAM
    const mem = data.memory || {};
    const memUsedGb = ((mem.used_mb || 0) / 1024).toFixed(1);
    const memTotalGb = ((mem.total_mb || 0) / 1024).toFixed(1);
    const memPct = mem.used_percent || 0;
    valRamPct.textContent = `${memPct}%`;
    valRamUsed.textContent = memUsedGb;
    valRamTotal.textContent = memTotalGb;
    barRam.style.width = `${memPct}%`;

    // Storage
    const st = data.storage || {};
    const diskUsedGb = ((st.used_mb || 0) / 1024).toFixed(1);
    const diskTotalGb = ((st.total_mb || 0) / 1024).toFixed(1);
    const diskPct = st.used_percent || 0;
    valDiskPct.textContent = `${diskPct}%`;
    valDiskUsed.textContent = diskUsedGb;
    valDiskTotal.textContent = diskTotalGb;
    barDisk.style.width = `${diskPct}%`;

    // Device & Uptime
    const dev = data.device || {};
    valCpuCores.textContent = `${dev.cores || 8} Cores`;
    valCpuArch.textContent = dev.arch || 'arm64-v8a';
    valDeviceModel.textContent = dev.model || 'Redmi Pad SE';
    valDaemonUptime.textContent = formatSeconds(data.uptime_s);
    valSysUptime.textContent = formatSeconds(data.system_uptime_s);

    // Network IP
    const net = data.network || {};
    if (net.ip && net.ip !== '127.0.0.1') {
      valWifiUrl.textContent = `http://${net.ip}:${net.port || 8080}`;
      badgeWifi.textContent = `WIFI: http://${net.ip}:${net.port || 8080}`;
    }

  } catch (err) {
    isRunning = false;
    badgeDaemon.className = 'badge badge-offline';
    badgeDaemon.textContent = '○ DAEMON: STOPPED';
    pulseLed.style.background = 'var(--agy-coral)';
    pulseLed.style.boxShadow = '0 0 10px var(--agy-coral)';
    txtDaemonTitle.textContent = 'DAEMON PAUSED / STOPPED';
    txtDaemonTitle.style.color = 'var(--agy-coral)';
    txtDaemonSub.textContent = 'Server service stopped. Press START DAEMON to resume.';
    btnToggleDaemon.className = 'btn-node btn-toggle is-stopped';
    btnToggleDaemon.innerHTML = '<span class="btn-icon">▶</span> START DAEMON';
  }
}

// Fetch Logs
async function pollLogs() {
  try {
    const res = await fetch('/api/logs', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const logs = data.logs || [];

    if (logs.length > lastLogCount) {
      const newEntries = logs.slice(lastLogCount);
      newEntries.forEach(e => appendLogEntry(e.message, e.level, e.timestamp));
      lastLogCount = logs.length;
    }
  } catch (_) {}
}

// Network info detection
async function detectLocalIp() {
  try {
    const res = await fetch('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: "ip -o -4 addr show | grep -v '127.0.0.1' | awk '{print $4}' | cut -d/ -f1 | head -n 1" })
    });
    if (res.ok) {
      const data = await res.json();
      const ip = (data.stdout || '').trim();
      if (ip) {
        valWifiUrl.textContent = `http://${ip}:8080`;
        badgeWifi.textContent = `WIFI: http://${ip}:8080`;
      }
    }
  } catch (_) {}
}

// Buttons
btnDimScreen.addEventListener('click', () => {
  if (window.androidAPI && typeof window.androidAPI.toggleDim === 'function') {
    isDimmed = !isDimmed;
    window.androidAPI.toggleDim();
    btnDimScreen.innerHTML = isDimmed ? 
      '<span class="btn-icon">💡</span> RESTORE BRIGHTNESS' : 
      '<span class="btn-icon">🌙</span> OLED ECO DIM (95% POWER SAVE)';
    appendLogEntry(`Screen brightness ${isDimmed ? 'dimmed to minimal' : 'restored'}`, 'POWER');
  }
});

btnToggleDaemon.addEventListener('click', () => {
  if (window.androidAPI && typeof window.androidAPI.toggleServer === 'function') {
    window.androidAPI.toggleServer();
    setTimeout(pollStatus, 500);
  }
});

btnClearLogs.addEventListener('click', async () => {
  logStreamBox.innerHTML = '';
  lastLogCount = 0;
  try {
    await fetch('/api/logs/clear');
  } catch (_) {}
  appendLogEntry('Log display cleared', 'SYSTEM');
});

// Initialization
pollStatus();
pollLogs();
detectLocalIp();

setInterval(pollStatus, 2500);
setInterval(pollLogs, 1500);
