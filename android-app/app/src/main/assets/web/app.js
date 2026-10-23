let serverHost = '127.0.0.1';
let serverPort = 8080;
let isConnected = false;
let currentPath = '/sdcard';
let pollInterval = null;

if (typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http')) {
  serverHost = window.location.hostname || '127.0.0.1';
  serverPort = window.location.port ? parseInt(window.location.port, 10) : 8080;
}

// Android & Standalone browser fallback
if (!window.electronAPI) {
  window.electronAPI = {
    forwardAdb: async () => ({ success: true, output: 'Local loopback active (127.0.0.1:8080)' }),
    checkAdbDevices: async () => ({ success: true, output: 'Local Tablet Android Server Node' }),
    discoverBonjour: async () => ({ success: true, ip: serverHost, port: serverPort }),
    openExternal: (url) => { window.open(url, '_blank'); }
  };
}

if (navigator.userAgent.includes('Android') || window.androidAPI) {
  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('is-android');
    const hdr = document.querySelector('.app-header');
    if (hdr) hdr.style.paddingLeft = '16px';
  });
}

const getBaseUrl = () => {
  if (typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http')) {
    return window.location.origin;
  }
  return `http://${serverHost}:${serverPort}`;
};

// DOM Elements
const connBadge = document.getElementById('connBadge');
const latencyBadge = document.getElementById('latencyBadge');
const batteryBadge = document.getElementById('batteryBadge');
const valDaemonStatus = document.getElementById('valDaemonStatus');
const valUptime = document.getElementById('valUptime');
const valSysUptime = document.getElementById('valSysUptime');
const valActiveHost = document.getElementById('valActiveHost');
const valBatteryPercent = document.getElementById('valBatteryPercent');
const barBatteryFill = document.getElementById('barBatteryFill');
const valBatteryTemp = document.getElementById('valBatteryTemp');
const valBatteryPlugged = document.getElementById('valBatteryPlugged');
const valBatteryHealth = document.getElementById('valBatteryHealth');
const thermalAlert = document.getElementById('thermalAlert');
const valRamText = document.getElementById('valRamText');
const barRamFill = document.getElementById('barRamFill');
const valDiskText = document.getElementById('valDiskText');
const barDiskFill = document.getElementById('barDiskFill');
const valDeviceModel = document.getElementById('valDeviceModel');
const valDeviceOs = document.getElementById('valDeviceOs');
const valDeviceCores = document.getElementById('valDeviceCores');
const valDeviceArch = document.getElementById('valDeviceArch');
const rackModelText = document.getElementById('rackModelText');

const termOutput = document.getElementById('termOutput');
const termInput = document.getElementById('termInput');
const btnSendCmd = document.getElementById('btnSendCmd');

const currentDirPath = document.getElementById('currentDirPath');
const fileTableBody = document.getElementById('fileTableBody');
const btnNavUp = document.getElementById('btnNavUp');
const btnRefreshFiles = document.getElementById('btnRefreshFiles');

const inputHost = document.getElementById('inputHost');
const inputPort = document.getElementById('inputPort');
const btnSaveConnect = document.getElementById('btnSaveConnect');
const btnAdbTunnel = document.getElementById('btnAdbTunnel');
const adbOutput = document.getElementById('adbOutput');
const presetUsb = document.getElementById('presetUsb');
const presetWifi = document.getElementById('presetWifi');
const btnAutoScan = document.getElementById('btnAutoScan');

// Navigation Tabs
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    const tabId = `tab-${item.dataset.tab}`;
    document.getElementById(tabId).classList.add('active');

    if (item.dataset.tab === 'files') {
      loadFiles(currentPath);
    }
    if (item.dataset.tab === 'logs') {
      fetchRemoteLogs();
    }
  });
});

// Helper: Format seconds to H:M:S
function formatSeconds(sec) {
  if (!sec && sec !== 0) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}h ${m}m ${s}s`;
}

// Telemetry Poller
async function fetchTelemetry() {
  const t0 = performance.now();
  try {
    const res = await fetch(`${getBaseUrl()}/api/status`, { cache: 'no-store' });
    const latency = Math.round(performance.now() - t0);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    updateConnectionUi(true, latency);
    renderTelemetry(data);
  } catch (err) {
    updateConnectionUi(false);
  }
}

function updateConnectionUi(online, latency = 0) {
  isConnected = online;
  if (online) {
    connBadge.className = 'badge badge-online';
    connBadge.textContent = '● ONLINE';
    latencyBadge.textContent = `PING: ${latency}ms`;
    valDaemonStatus.textContent = 'Online [Active]';
    valDaemonStatus.className = 'metric-val highlight-green';
    valActiveHost.textContent = getBaseUrl();
  } else {
    connBadge.className = 'badge badge-offline';
    connBadge.textContent = '○ OFFLINE';
    latencyBadge.textContent = 'PING: --ms';
    valDaemonStatus.textContent = 'Offline';
    valDaemonStatus.className = 'metric-val';
  }
}

function renderTelemetry(data) {
  valUptime.textContent = formatSeconds(data.uptime_s);
  valSysUptime.textContent = formatSeconds(data.system_uptime_s);

  // Battery
  const bat = data.battery || {};
  valBatteryPercent.textContent = `${bat.percent || 0}%`;
  barBatteryFill.style.width = `${bat.percent || 0}%`;
  batteryBadge.textContent = `🔋 ${bat.percent || 0}%`;

  valBatteryTemp.textContent = `${bat.temp_c || 0}°C`;
  valBatteryPlugged.textContent = `${bat.plugged || '--'} (${bat.status || '--'})`;
  valBatteryHealth.textContent = bat.health || 'Good';

  if (bat.overheating) {
    thermalAlert.classList.remove('hidden');
  } else {
    thermalAlert.classList.add('hidden');
  }

  // Memory
  const mem = data.memory || {};
  const totalMemGb = ((mem.total_mb || 0) / 1024).toFixed(1);
  const usedMemGb = ((mem.used_mb || 0) / 1024).toFixed(1);
  const memPct = mem.used_percent || 0;
  valRamText.textContent = `${usedMemGb} / ${totalMemGb} GB (${memPct}%)`;
  barRamFill.style.width = `${memPct}%`;

  // Storage
  const stor = data.storage || {};
  const totalDiskGb = ((stor.total_mb || 0) / 1024).toFixed(1);
  const usedDiskGb = ((stor.used_mb || 0) / 1024).toFixed(1);
  const diskPct = stor.used_percent || 0;
  valDiskText.textContent = `${usedDiskGb} / ${totalDiskGb} GB (${diskPct}%)`;
  barDiskFill.style.width = `${diskPct}%`;

  // Hardware
  const dev = data.device || {};
  valDeviceModel.textContent = `${dev.manufacturer || ''} ${dev.model || ''}`;
  rackModelText.textContent = dev.model || 'Android Tablet';
  valDeviceOs.textContent = `Android ${dev.android_version || ''} (API ${dev.sdk_int || ''})`;
  valDeviceCores.textContent = `${dev.cores || 8} Cores`;
  valDeviceArch.textContent = dev.arch || 'arm64';
}

// Terminal execution
async function runCommand(cmd) {
  if (!cmd || !cmd.trim()) return;
  const command = cmd.trim();

  // Print command
  const cmdLine = document.createElement('div');
  cmdLine.className = 'term-line term-cmd';
  cmdLine.textContent = `$ ${command}`;
  termOutput.appendChild(cmdLine);

  try {
    const res = await fetch(`${getBaseUrl()}/api/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command })
    });
    const result = await res.json();

    if (result.stdout && result.stdout.trim()) {
      const outLine = document.createElement('div');
      outLine.className = 'term-line term-stdout';
      outLine.textContent = result.stdout;
      termOutput.appendChild(outLine);
    }

    if (result.stderr && result.stderr.trim()) {
      const errLine = document.createElement('div');
      errLine.className = 'term-line term-stderr';
      errLine.textContent = result.stderr;
      termOutput.appendChild(errLine);
    }

    if (result.exit_code !== 0 && !result.stderr) {
      const codeLine = document.createElement('div');
      codeLine.className = 'term-line term-stderr';
      codeLine.textContent = `[Process exited with code ${result.exit_code}]`;
      termOutput.appendChild(codeLine);
    }
  } catch (err) {
    const failLine = document.createElement('div');
    failLine.className = 'term-line term-stderr';
    failLine.textContent = `Execution error: ${err.message}`;
    termOutput.appendChild(failLine);
  }

  termOutput.scrollTop = termOutput.scrollHeight;
}

btnSendCmd.addEventListener('click', () => {
  runCommand(termInput.value);
  termInput.value = '';
});

termInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    runCommand(termInput.value);
    termInput.value = '';
  }
});

// Quick action chips
document.querySelectorAll('.btn-chip[data-cmd]').forEach(chip => {
  chip.addEventListener('click', () => {
    runCommand(chip.dataset.cmd);
  });
});

// File Manager
async function loadFiles(path) {
  currentDirPath.textContent = path;
  fileTableBody.innerHTML = '<tr><td colspan="5" class="text-center">Loading...</td></tr>';

  try {
    const res = await fetch(`${getBaseUrl()}/api/files?path=${encodeURIComponent(path)}`);
    const data = await res.json();

    if (data.error) {
      fileTableBody.innerHTML = `<tr><td colspan="5" class="text-center" style="color:var(--pixel-red);">${data.error}</td></tr>`;
      return;
    }

    currentPath = data.current_path;
    currentDirPath.textContent = currentPath;

    if (!data.items || data.items.length === 0) {
      fileTableBody.innerHTML = '<tr><td colspan="5" class="text-center">Directory is empty</td></tr>';
      return;
    }

    fileTableBody.innerHTML = '';
    data.items.forEach(item => {
      const tr = document.createElement('tr');
      tr.className = 'file-row';

      const typeIcon = item.is_dir ? '📁' : '📄';
      const typeLabel = item.is_dir ? 'DIR' : 'FILE';
      const sizeLabel = item.is_dir ? '--' : formatFileSize(item.size);
      const modDate = new Date(item.last_modified).toLocaleString();

      tr.innerHTML = `
        <td><span class="file-icon">${typeIcon}</span> ${typeLabel}</td>
        <td style="font-weight: 600;">${item.name}</td>
        <td>${sizeLabel}</td>
        <td style="color: var(--text-muted); font-size: 11px;">${modDate}</td>
        <td></td>
      `;

      const actionTd = tr.querySelector('td:last-child');
      if (item.is_dir) {
        const openBtn = document.createElement('button');
        openBtn.className = 'btn-chip';
        openBtn.textContent = 'OPEN';
        openBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          loadFiles(item.path);
        });
        actionTd.appendChild(openBtn);
      } else {
        const dlBtn = document.createElement('button');
        dlBtn.className = 'btn-chip';
        dlBtn.textContent = 'DOWNLOAD';
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.electronAPI.openExternal(`${getBaseUrl()}/api/download?path=${encodeURIComponent(item.path)}`);
        });
        actionTd.appendChild(dlBtn);
      }

      tr.addEventListener('click', () => {
        if (item.is_dir) loadFiles(item.path);
      });

      fileTableBody.appendChild(tr);
    });
  } catch (err) {
    fileTableBody.innerHTML = `<tr><td colspan="5" class="text-center" style="color:var(--pixel-red);">Connection error: ${err.message}</td></tr>`;
  }
}

btnNavUp.addEventListener('click', () => {
  const parts = currentPath.split('/').filter(Boolean);
  if (parts.length > 0) {
    parts.pop();
    const parentPath = '/' + parts.join('/');
    loadFiles(parentPath || '/');
  }
});

btnRefreshFiles.addEventListener('click', () => {
  loadFiles(currentPath);
});

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Connection Configuration
btnAutoScan.addEventListener('click', async () => {
  btnAutoScan.textContent = 'SCANNING...';
  try {
    const res = await window.electronAPI.discoverBonjour();
    if (res.success && res.ip) {
      inputHost.value = res.ip;
      inputPort.value = res.port || 8080;
      serverHost = res.ip;
      serverPort = res.port || 8080;
      btnAutoScan.textContent = `FOUND: ${res.ip}`;
      setTimeout(() => { btnAutoScan.textContent = '🔍 AUTO-DISCOVER (MDNS)'; }, 3000);
      fetchTelemetry();
    } else {
      btnAutoScan.textContent = 'NOT FOUND (USE USB)';
      setTimeout(() => { btnAutoScan.textContent = '🔍 AUTO-DISCOVER (MDNS)'; }, 2500);
    }
  } catch (err) {
    btnAutoScan.textContent = 'ERROR SCANNING';
    setTimeout(() => { btnAutoScan.textContent = '🔍 AUTO-DISCOVER (MDNS)'; }, 2500);
  }
});

btnSaveConnect.addEventListener('click', () => {
  serverHost = inputHost.value.trim();
  serverPort = parseInt(inputPort.value, 10) || 8080;
  fetchTelemetry();
});

presetUsb.addEventListener('click', async () => {
  inputHost.value = '127.0.0.1';
  inputPort.value = '8080';
  serverHost = '127.0.0.1';
  serverPort = 8080;
  await triggerAdbForward();
  fetchTelemetry();
});

presetWifi.addEventListener('click', () => {
  inputHost.value = '192.168.0.82';
  inputPort.value = '8080';
  serverHost = '192.168.0.82';
  serverPort = 8080;
  fetchTelemetry();
});

async function triggerAdbForward() {
  adbOutput.textContent = 'Executing adb forward tcp:8080 tcp:8080...';
  const result = await window.electronAPI.forwardAdb(8080);
  if (result.success) {
    adbOutput.textContent = `[ADB SUCCESS] Port 8080 forwarded over USB.\nReady to connect to http://127.0.0.1:8080`;
  } else {
    adbOutput.textContent = `[ADB ERROR] ${result.error}`;
  }
}

btnAdbTunnel.addEventListener('click', triggerAdbForward);

// Check ADB on startup
async function initAdb() {
  const dev = await window.electronAPI.checkAdbDevices();
  if (dev.success) {
    adbOutput.textContent = dev.output;
  }
}

const btnDimRemote = document.getElementById('btnDimRemote');
const btnWakeRemote = document.getElementById('btnWakeRemote');

if (btnDimRemote) {
  btnDimRemote.addEventListener('click', async () => {
    if (window.androidAPI && typeof window.androidAPI.toggleDim === 'function') {
      window.androidAPI.toggleDim();
      return;
    }
    try {
      await fetch(`${getBaseUrl()}/api/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'input keyevent 26' })
      });
    } catch (_) {}
  });
}

if (btnWakeRemote) {
  btnWakeRemote.addEventListener('click', async () => {
    try {
      await fetch(`${getBaseUrl()}/api/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'input keyevent 224' })
      });
    } catch (_) {}
  });
}

// Remote Logs Tab Logic
const macLogOutput = document.getElementById('macLogOutput');
const inputLogFilter = document.getElementById('inputLogFilter');
const logsCounter = document.getElementById('logsCounter');
const btnPauseLogs = document.getElementById('btnPauseLogs');
const btnClearRemoteLogs = document.getElementById('btnClearRemoteLogs');
const btnCopyLogs = document.getElementById('btnCopyLogs');

let allRemoteLogs = [];
let isLogsPaused = false;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function fetchRemoteLogs() {
  if (isLogsPaused) return;
  try {
    const res = await fetch(`${getBaseUrl()}/api/logs`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    allRemoteLogs = data.logs || [];
    renderRemoteLogs();
  } catch (_) {}
}

function renderRemoteLogs() {
  if (!macLogOutput) return;
  const filterText = (inputLogFilter ? inputLogFilter.value : '').toLowerCase().trim();
  const filtered = filterText ? allRemoteLogs.filter(e => {
    return (e.message && e.message.toLowerCase().includes(filterText)) ||
           (e.level && e.level.toLowerCase().includes(filterText));
  }) : allRemoteLogs;

  if (logsCounter) {
    logsCounter.textContent = `${filtered.length} entries (total: ${allRemoteLogs.length})`;
  }

  if (filtered.length === 0) {
    macLogOutput.innerHTML = `<div class="term-line term-system">No log entries recorded yet.</div>`;
    return;
  }

  const isScrolledToBottom = macLogOutput.scrollHeight - macLogOutput.clientHeight <= macLogOutput.scrollTop + 50;

  macLogOutput.innerHTML = filtered.map(e => {
    const timeStr = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '--:--:--';
    const lvl = (e.level || 'INFO').toUpperCase();
    let lvlClass = 'log-lvl-info';
    if (lvl === 'WARN') lvlClass = 'log-lvl-warn';
    else if (lvl === 'ERROR') lvlClass = 'log-lvl-err';
    else if (lvl === 'SYSTEM') lvlClass = 'log-lvl-green';

    return `<div class="log-entry">
      <span class="log-time">[${timeStr}]</span>
      <span class="log-lvl ${lvlClass}">${lvl}</span>
      <span class="log-msg">${escapeHtml(e.message || '')}</span>
    </div>`;
  }).join('');

  if (isScrolledToBottom) {
    macLogOutput.scrollTop = macLogOutput.scrollHeight;
  }
}

if (inputLogFilter) {
  inputLogFilter.addEventListener('input', renderRemoteLogs);
}

if (btnPauseLogs) {
  btnPauseLogs.addEventListener('click', () => {
    isLogsPaused = !isLogsPaused;
    btnPauseLogs.textContent = isLogsPaused ? 'RESUME STREAM' : 'PAUSE STREAM';
    btnPauseLogs.style.background = isLogsPaused ? 'var(--agy-amber)' : '';
  });
}

if (btnClearRemoteLogs) {
  btnClearRemoteLogs.addEventListener('click', async () => {
    try {
      await fetch(`${getBaseUrl()}/api/logs/clear`);
      allRemoteLogs = [];
      renderRemoteLogs();
    } catch (_) {}
  });
}

if (btnCopyLogs) {
  btnCopyLogs.addEventListener('click', () => {
    const text = allRemoteLogs.map(e => `[${new Date(e.timestamp).toLocaleTimeString()}] [${e.level}] ${e.message}`).join('\n');
    navigator.clipboard.writeText(text);
    btnCopyLogs.textContent = 'COPIED!';
    setTimeout(() => { btnCopyLogs.textContent = 'COPY ALL'; }, 2000);
  });
}

// Start polling
initAdb();
triggerAdbForward().then(() => fetchTelemetry());
pollInterval = setInterval(fetchTelemetry, 2500);
setInterval(fetchRemoteLogs, 2000);
