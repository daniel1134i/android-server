const USB_HOST = '127.0.0.1';
let wifiHost = (typeof localStorage !== 'undefined' ? localStorage.getItem('android_wifi_host') : null) || '192.168.0.82';
let serverPort = 8080;
let activeChannel = 'usb'; // 'usb' | 'wifi' | 'cloud'
let isConnected = false;
let currentPath = '/sdcard';
let pollInterval = null;

// Настройки Cloud Relay (для доступа за 1000 км через интернет)
let cloudNodeId = (typeof localStorage !== 'undefined' ? localStorage.getItem('cloud_node_id') : null) || '';
let cloudSecretKey = (typeof localStorage !== 'undefined' ? localStorage.getItem('cloud_secret_key') : null) || '';
let cloudRelayUrl = (typeof localStorage !== 'undefined' ? localStorage.getItem('cloud_relay_url') : null) || 'ws://192.168.0.199:8088';
let cloudWs = null;
let cloudIsReady = false;
const pendingCloudRpc = new Map();

function initCloudRelay() {
  if (!cloudNodeId || !cloudSecretKey || !cloudRelayUrl) return;
  if (cloudWs && (cloudWs.readyState === WebSocket.OPEN || cloudWs.readyState === WebSocket.CONNECTING)) return;

  try {
    cloudWs = new WebSocket(cloudRelayUrl);

    cloudWs.onopen = () => {
      cloudWs.send(JSON.stringify({
        type: 'register',
        role: 'controller',
        nodeId: cloudNodeId,
        token: cloudSecretKey
      }));
    };

    cloudWs.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'registered') {
          cloudIsReady = true;
          updateCloudUi(true);
        }
        if (msg.type === 'error') {
          cloudIsReady = false;
          updateCloudUi(false, msg.message);
        }
        if (msg.rpc === 'res') {
          const p = pendingCloudRpc.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            pendingCloudRpc.delete(msg.id);
            p.resolve(msg.data);
          }
        }
      } catch (_) {}
    };

    cloudWs.onclose = () => {
      cloudIsReady = false;
      updateCloudUi(false);
      setTimeout(initCloudRelay, 4000);
    };

    cloudWs.onerror = () => {
      cloudIsReady = false;
      updateCloudUi(false);
    };
  } catch (_) {}
}

function sendCloudRpc(path, method = 'GET', body = null, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!cloudWs || cloudWs.readyState !== WebSocket.OPEN || !cloudIsReady) {
      return reject(new Error('Cloud Relay WebSocket не подключен'));
    }
    const id = 'req_' + Math.random().toString(36).substring(2, 10);
    const timer = setTimeout(() => {
      pendingCloudRpc.delete(id);
      reject(new Error(`Таймаут Cloud RPC: ${path}`));
    }, timeoutMs);

    pendingCloudRpc.set(id, { resolve, reject, timer });
    cloudWs.send(JSON.stringify({ rpc: 'req', id, path, method, body }));
  });
}

function updateCloudUi(connected, errorMsg = '') {
  const badge = document.getElementById('badgeCloudStatus');
  const txt = document.getElementById('txtCloudConnectStatus');
  if (badge) {
    if (connected) {
      badge.className = 'badge badge-online';
      badge.textContent = '☁ ОБЛАКО: АКТИВНО';
    } else {
      badge.className = 'badge badge-dim';
      badge.textContent = errorMsg ? `☁ ${errorMsg}` : '☁ НЕ ПОДКЛЮЧЕНО';
    }
  }
  if (txt) {
    txt.textContent = connected ? '✓ Подключено к релею' : (errorMsg || '');
  }
}

function syncCloudInputs() {
  const inId = document.getElementById('inputCloudNodeId');
  const inSec = document.getElementById('inputCloudSecretKey');
  const inRelay = document.getElementById('inputCloudRelayUrl');
  if (inId && !inId.value) inId.value = cloudNodeId || '';
  if (inSec && !inSec.value) inSec.value = cloudSecretKey || '';
  if (inRelay && !inRelay.value) inRelay.value = cloudRelayUrl || '';
}

if (typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http')) {
  wifiHost = window.location.hostname || wifiHost;
  serverPort = window.location.port ? parseInt(window.location.port, 10) : 8080;
  activeChannel = 'wifi';
}

// Заглушка для автономного браузера или Android
if (!window.electronAPI) {
  window.electronAPI = {
    forwardAdb: async () => ({ success: true, output: 'Локальный loopback активен (127.0.0.1:8080)' }),
    checkAdbDevices: async () => ({ success: true, output: 'Локальная нода сервера Android' }),
    execAdb: async () => ({ success: true, output: '' }),
    discoverBonjour: async () => ({ success: true, ip: wifiHost, port: serverPort }),
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
  const host = (activeChannel === 'wifi' && wifiHost) ? wifiHost : USB_HOST;
  return `http://${host}:${serverPort}`;
};

// Универсальная обертка API (автоматически использует USB / Wi-Fi / Cloud Relay)
async function apiCall(path, method = 'GET', body = null) {
  if (activeChannel === 'cloud') {
    return await sendCloudRpc(path, method, body);
  }
  const url = `${getBaseUrl()}${path}`;
  const hasBody = body && method !== 'GET' && method !== 'HEAD';
  const options = {
    method,
    headers: hasBody ? { 'Content-Type': 'application/json' } : {},
    body: hasBody ? JSON.stringify(body) : undefined,
    cache: 'no-store'
  };
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// DOM Элементы
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

// Переключение вкладок
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
    if (item.dataset.tab === 'apps') {
      loadAppsList();
    }
    if (item.dataset.tab === 'logs') {
      fetchRemoteLogs();
    }
  });
});

// Форматирование времени
function formatSeconds(sec) {
  if (!sec && sec !== 0) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}ч ${m}м ${s}с`;
}

// Опрос телеметрии с трехканальным отказоустойчивым переключением (USB <-> Wi-Fi <-> Cloud Relay)
async function fetchTelemetry() {
  const t0 = performance.now();
  let data = null;
  let channel = activeChannel;

  const tryHost = async (host, timeoutMs = 1200) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://${host}:${serverPort}/api/status`, {
        signal: controller.signal,
        cache: 'no-store'
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  };

  try {
    if (activeChannel === 'usb') {
      try {
        data = await tryHost(USB_HOST, 900);
        channel = 'usb';
      } catch (usbErr) {
        // Кабель отключен! Мгновенно пробуем Wi-Fi
        if (wifiHost) {
          try {
            data = await tryHost(wifiHost, 1500);
            activeChannel = 'wifi';
            channel = 'wifi';
          } catch (_) {}
        }
        // Если и Wi-Fi недоступен (пользователь уехал) — пробуем Cloud Relay
        if (!data && cloudIsReady) {
          try {
            data = await sendCloudRpc('/api/status', 'GET', null, 3000);
            activeChannel = 'cloud';
            channel = 'cloud';
          } catch (_) {}
        }
        if (!data) throw usbErr;
      }
    } else if (activeChannel === 'wifi') {
      // Активен Wi-Fi
      try {
        data = await tryHost(wifiHost, 1500);
        channel = 'wifi';
      } catch (wifiErr) {
        // Пробуем USB
        try {
          data = await tryHost(USB_HOST, 800);
          activeChannel = 'usb';
          channel = 'usb';
        } catch (_) {}
        // Пробуем Cloud Relay
        if (!data && cloudIsReady) {
          try {
            data = await sendCloudRpc('/api/status', 'GET', null, 3000);
            activeChannel = 'cloud';
            channel = 'cloud';
          } catch (_) {}
        }
        if (!data) throw wifiErr;
      }
    } else {
      // Активен Cloud Relay канал
      try {
        data = await sendCloudRpc('/api/status', 'GET', null, 4000);
        channel = 'cloud';
      } catch (cloudErr) {
        // Пробуем локальные каналы (вдруг вернулись домой)
        try {
          data = await tryHost(USB_HOST, 800);
          activeChannel = 'usb';
          channel = 'usb';
        } catch (_) {
          if (wifiHost) {
            try {
              data = await tryHost(wifiHost, 1000);
              activeChannel = 'wifi';
              channel = 'wifi';
            } catch (_) {}
          }
        }
        if (!data) throw cloudErr;
      }
    }

    const latency = Math.round(performance.now() - t0);

    // Автоматически обучаемся и сохраняем актуальный Wi-Fi IP планшета
    if (data.network && data.network.ip && data.network.ip !== '127.0.0.1') {
      if (wifiHost !== data.network.ip) {
        wifiHost = data.network.ip;
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('android_wifi_host', wifiHost);
        }
      }
    }

    // Автоматическая привязка учетных данных Cloud Relay при первом локальном контакте
    if (data.cloud && data.cloud.node_id) {
      let changed = false;
      if (!cloudNodeId) {
        cloudNodeId = data.cloud.node_id;
        if (typeof localStorage !== 'undefined') localStorage.setItem('cloud_node_id', cloudNodeId);
        changed = true;
      }
      if (!cloudSecretKey && data.cloud.secret_key) {
        cloudSecretKey = data.cloud.secret_key;
        if (typeof localStorage !== 'undefined') localStorage.setItem('cloud_secret_key', cloudSecretKey);
        changed = true;
      }
      syncCloudInputs();
      if (changed || !cloudIsReady) {
        initCloudRelay();
      }
    }

    updateConnectionUi(true, latency, channel);
    renderTelemetry(data);
  } catch (err) {
    updateConnectionUi(false);
  }
}

function updateConnectionUi(online, latency = 0, channel = activeChannel) {
  isConnected = online;
  if (online) {
    connBadge.className = 'badge badge-online';
    if (channel === 'usb') {
      connBadge.innerHTML = '● ОНЛАЙН <span style="color: var(--agy-amber); font-size: 10px; margin-left: 4px;">[⚡ USB]</span>';
    } else if (channel === 'wifi') {
      connBadge.innerHTML = `● ОНЛАЙН <span style="color: var(--agy-blue-light); font-size: 10px; margin-left: 4px;">[📶 WI-FI]</span>`;
    } else if (channel === 'cloud') {
      connBadge.innerHTML = `● ОНЛАЙН <span style="color: #a78bfa; font-size: 10px; margin-left: 4px;">[☁ ОБЛАКО]</span>`;
    }
    latencyBadge.textContent = `ПИНГ: ${latency}мс`;
    const hostDesc = channel === 'usb' ? 'USB КАБЕЛЬ' : (channel === 'wifi' ? 'WI-FI ' + (wifiHost || '') : 'Cloud Relay: ' + (cloudNodeId || ''));
    valDaemonStatus.textContent = `Онлайн [${hostDesc}]`;
    valDaemonStatus.className = 'metric-val highlight-green';
    valActiveHost.textContent = channel === 'cloud' ? `cloud://${cloudNodeId}` : getBaseUrl();
  } else {
    connBadge.className = 'badge badge-offline';
    connBadge.textContent = '○ ОФФЛАЙН';
    latencyBadge.textContent = 'ПИНГ: --мс';
    valDaemonStatus.textContent = 'Оффлайн [Поиск USB / Wi-Fi / Cloud...]';
    valDaemonStatus.className = 'metric-val';
  }
}

function renderTelemetry(data) {
  valUptime.textContent = formatSeconds(data.uptime_s);
  valSysUptime.textContent = formatSeconds(data.system_uptime_s);

  // Батарея
  const bat = data.battery || {};
  valBatteryPercent.textContent = `${bat.percent || 0}%`;
  barBatteryFill.style.width = `${bat.percent || 0}%`;
  batteryBadge.textContent = `🔋 ${bat.percent || 0}%`;
  valBatteryTemp.textContent = `${bat.temp_c || 0}°C`;

  let statusRu = 'Зарядка';
  if (bat.status === 'Discharging') statusRu = 'Разрядка';
  else if (bat.status === 'Full') statusRu = 'Заряжено';
  else if (bat.status === 'Not charging') statusRu = 'Не заряжается';

  let sourceRu = 'Сетевой адаптер (AC)';
  if (bat.plugged === 'USB') sourceRu = 'Порт USB';
  else if (bat.plugged === 'Wireless') sourceRu = 'Беспроводная';
  else if (bat.plugged === 'Battery') sourceRu = 'От аккумулятора';

  valBatteryPlugged.textContent = `${sourceRu} (${statusRu})`;
  valBatteryHealth.textContent = bat.health === 'Good' ? 'Отличное' : (bat.health || 'В норме');

  if (bat.overheating) {
    thermalAlert.classList.remove('hidden');
  } else {
    thermalAlert.classList.add('hidden');
  }

  // ОЗУ
  const mem = data.memory || {};
  const totalMemGb = ((mem.total_mb || 0) / 1024).toFixed(1);
  const usedMemGb = ((mem.used_mb || 0) / 1024).toFixed(1);
  const memPct = mem.used_percent || 0;
  valRamText.textContent = `${usedMemGb} / ${totalMemGb} ГБ (${memPct}%)`;
  barRamFill.style.width = `${memPct}%`;

  // Накопитель
  const stor = data.storage || {};
  const totalDiskGb = ((stor.total_mb || 0) / 1024).toFixed(1);
  const usedDiskGb = ((stor.used_mb || 0) / 1024).toFixed(1);
  const diskPct = stor.used_percent || 0;
  valDiskText.textContent = `${usedDiskGb} / ${totalDiskGb} ГБ (${diskPct}%)`;
  barDiskFill.style.width = `${diskPct}%`;

  // Спецификация
  const dev = data.device || {};
  valDeviceModel.textContent = `${dev.manufacturer || ''} ${dev.model || ''}`;
  rackModelText.textContent = dev.model || 'Redmi Pad SE';
  valDeviceOs.textContent = `Android ${dev.android_version || ''} (API ${dev.sdk_int || ''})`;
  valDeviceCores.textContent = `${dev.cores || 8} ядер`;
  valDeviceArch.textContent = dev.arch || 'arm64';
}

// Выполнение в терминале
async function runCommand(cmd) {
  if (!cmd || !cmd.trim()) return;
  const command = cmd.trim();

  const cmdLine = document.createElement('div');
  cmdLine.className = 'term-line term-cmd';
  cmdLine.textContent = `$ ${command}`;
  termOutput.appendChild(cmdLine);

  try {
    const result = await apiCall('/api/exec', 'POST', { command });

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
      codeLine.textContent = `[Процесс завершился с кодом ${result.exit_code}]`;
      termOutput.appendChild(codeLine);
    }
  } catch (err) {
    const failLine = document.createElement('div');
    failLine.className = 'term-line term-stderr';
    failLine.textContent = `Ошибка выполнения: ${err.message}`;
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

// Быстрые кнопки команд
document.querySelectorAll('.btn-chip[data-cmd]').forEach(chip => {
  chip.addEventListener('click', () => {
    runCommand(chip.dataset.cmd);
  });
});

// Файловый браузер
async function loadFiles(path) {
  currentDirPath.textContent = path;
  fileTableBody.innerHTML = '<tr><td colspan="5" class="text-center">Загрузка...</td></tr>';

  try {
    const data = await apiCall(`/api/files?path=${encodeURIComponent(path)}`, 'GET');

    if (data.error) {
      fileTableBody.innerHTML = `<tr><td colspan="5" class="text-center" style="color:var(--pixel-red);">${data.error}</td></tr>`;
      return;
    }

    currentPath = data.current_path;
    currentDirPath.textContent = currentPath;

    if (!data.items || data.items.length === 0) {
      fileTableBody.innerHTML = '<tr><td colspan="5" class="text-center">Папка пуста</td></tr>';
      return;
    }

    fileTableBody.innerHTML = '';
    data.items.forEach(item => {
      const tr = document.createElement('tr');
      tr.className = 'file-row';

      const typeIcon = item.is_dir ? '📁' : '📄';
      const typeLabel = item.is_dir ? 'ПАПКА' : 'ФАЙЛ';
      const sizeLabel = item.is_dir ? '--' : formatFileSize(item.size);
      const modDate = new Date(item.last_modified).toLocaleString('ru-RU');

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
        openBtn.textContent = 'ОТКРЫТЬ';
        openBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          loadFiles(item.path);
        });
        actionTd.appendChild(openBtn);
      } else {
        const dlBtn = document.createElement('button');
        dlBtn.className = 'btn-chip';
        dlBtn.textContent = 'СКАЧАТЬ';
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
    fileTableBody.innerHTML = `<tr><td colspan="5" class="text-center" style="color:var(--pixel-red);">Ошибка подключения: ${err.message}</td></tr>`;
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
  if (bytes === 0) return '0 Б';
  const k = 1024;
  const sizes = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ⚡ 1-Клик Авто-связывание устройств
const btnAutoPair = document.getElementById('btnAutoPair');
const btnSidebarPair = document.getElementById('btnSidebarPair');
const txtAutoPairStatus = document.getElementById('txtAutoPairStatus');
const badgePairStatus = document.getElementById('badgePairStatus');
const pairSuccessBanner = document.getElementById('pairSuccessBanner');

async function triggerAutoPairing() {
  if (btnAutoPair) {
    btnAutoPair.disabled = true;
    btnAutoPair.textContent = '🔍 ПОИСК ПЛАНШЕТА...';
  }
  if (btnSidebarPair) {
    btnSidebarPair.textContent = '🔍 ПОИСК...';
  }
  if (txtAutoPairStatus) {
    txtAutoPairStatus.textContent = 'Поиск планшета в сети Wi-Fi (UDP 8081 & mDNS)...';
    txtAutoPairStatus.style.color = 'var(--agy-blue-light)';
  }
  if (badgePairStatus) {
    badgePairStatus.className = 'badge badge-dim';
    badgePairStatus.textContent = 'ПОИСК...';
  }
  if (pairSuccessBanner) {
    pairSuccessBanner.classList.add('hidden');
  }

  // Переключаем на вкладку настроек, если кликнули из сайдбара
  const settingsTab = document.querySelector('.nav-item[data-tab="settings"]');
  if (settingsTab && !settingsTab.classList.contains('active')) {
    settingsTab.click();
  }

  try {
    const res = await window.electronAPI.autoPairWifi();
    if (res && res.success) {
      wifiHost = res.ip;
      cloudNodeId = res.node_id;
      cloudSecretKey = res.secret_key;
      cloudRelayUrl = res.relay_url || cloudRelayUrl;
      serverPort = res.port || 8080;

      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('android_wifi_host', wifiHost);
        localStorage.setItem('cloud_node_id', cloudNodeId);
        localStorage.setItem('cloud_secret_key', cloudSecretKey);
        localStorage.setItem('cloud_relay_url', cloudRelayUrl);
      }

      if (inputHost) inputHost.value = wifiHost;
      if (inputPort) inputPort.value = serverPort;
      if (inputCloudNodeId) inputCloudNodeId.value = cloudNodeId;
      if (inputCloudSecretKey) inputCloudSecretKey.value = cloudSecretKey;
      if (inputCloudRelayUrl) inputCloudRelayUrl.value = cloudRelayUrl;

      // Сразу поднимаем Cloud Relay соединение
      if (cloudWs) {
        try { cloudWs.close(); } catch (_) {}
        cloudWs = null;
      }
      activeChannel = 'cloud';
      initCloudRelay();

      const devName = (res.device && res.device.model) ? `${res.device.manufacturer || ''} ${res.device.model}` : 'Redmi Pad SE';
      if (txtAutoPairStatus) {
        txtAutoPairStatus.textContent = `✓ Найдено и привязано: ${devName} (${res.ip})`;
        txtAutoPairStatus.style.color = 'var(--agy-green)';
      }
      if (badgePairStatus) {
        badgePairStatus.className = 'badge badge-online';
        badgePairStatus.textContent = '● СВЯЗАНО НАВСЕГДА';
      }
      if (pairSuccessBanner) {
        pairSuccessBanner.innerHTML = `
          <div style="font-family: var(--font-pixel); font-size: 13px; color: #94c55f; margin-bottom: 6px;">
            🎉 УСТРОЙСТВА УСПЕШНО СВЯЗАНЫ НАВСЕГДА!
          </div>
          <div><b>Планшет:</b> ${escapeHtml(devName)} (Wi-Fi IP: <code>${escapeHtml(res.ip)}</code>)</div>
          <div><b>Облачный ID:</b> <code class="code-text" style="color:var(--agy-blue-light);">${escapeHtml(res.node_id)}</code> (E2E-ключ сохранен)</div>
          <div style="margin-top: 8px; font-size: 11px; color: var(--text-main);">
            ✓ Теперь вы можете управлять этим сервером <b>из любой точки мира удаленно</b> через интернет. Кабель и нахождение в одной сети Wi-Fi больше не требуются!
          </div>
        `;
        pairSuccessBanner.classList.remove('hidden');
      }

      fetchTelemetry();

      setTimeout(() => {
        const tabTelemetry = document.querySelector('.nav-item[data-tab="telemetry"]');
        if (tabTelemetry) tabTelemetry.click();
      }, 3000);

    } else {
      const errMsg = res ? (res.error || 'Планшет не найден') : 'Ошибка связывания';
      if (txtAutoPairStatus) {
        txtAutoPairStatus.textContent = errMsg;
        txtAutoPairStatus.style.color = 'var(--agy-coral)';
      }
      if (badgePairStatus) {
        badgePairStatus.className = 'badge badge-offline';
        badgePairStatus.textContent = 'НЕ НАЙДЕНО';
      }
    }
  } catch (err) {
    if (txtAutoPairStatus) {
      txtAutoPairStatus.textContent = `Ошибка: ${err.message}`;
      txtAutoPairStatus.style.color = 'var(--agy-coral)';
    }
  } finally {
    if (btnAutoPair) {
      btnAutoPair.disabled = false;
      btnAutoPair.textContent = '⚡ НАЙТИ И СВЯЗАТЬ УСТРОЙСТВА';
    }
    if (btnSidebarPair) {
      btnSidebarPair.textContent = '⚡ 1-КЛИК АВТО-СВЯЗЫВАНИЕ';
    }
  }
}

if (btnAutoPair) btnAutoPair.addEventListener('click', triggerAutoPairing);
if (btnSidebarPair) btnSidebarPair.addEventListener('click', triggerAutoPairing);

// Настройка подключения
btnAutoScan.addEventListener('click', async () => {
  btnAutoScan.textContent = 'СКАНИРОВАНИЕ...';
  try {
    const res = await window.electronAPI.discoverBonjour();
    if (res.success && res.ip) {
      inputHost.value = res.ip;
      inputPort.value = res.port || 8080;
      wifiHost = res.ip;
      serverPort = res.port || 8080;
      activeChannel = 'wifi';
      if (typeof localStorage !== 'undefined') localStorage.setItem('android_wifi_host', wifiHost);
      btnAutoScan.textContent = `НАЙДЕНО: ${res.ip}`;
      setTimeout(() => { btnAutoScan.textContent = '🔍 АВТО-ПОИСК (MDNS)'; }, 3000);
      fetchTelemetry();
    } else {
      btnAutoScan.textContent = 'НЕ НАЙДЕНО (ИСПОЛЬЗУЙТЕ USB)';
      setTimeout(() => { btnAutoScan.textContent = '🔍 АВТО-ПОИСК (MDNS)'; }, 2500);
    }
  } catch (err) {
    btnAutoScan.textContent = 'ОШИБКА ПОИСКА';
    setTimeout(() => { btnAutoScan.textContent = '🔍 АВТО-ПОИСК (MDNS)'; }, 2500);
  }
});

btnSaveConnect.addEventListener('click', () => {
  const custom = inputHost.value.trim();
  serverPort = parseInt(inputPort.value, 10) || 8080;
  if (custom === '127.0.0.1' || custom === 'localhost') {
    activeChannel = 'usb';
  } else {
    activeChannel = 'wifi';
    wifiHost = custom;
    if (typeof localStorage !== 'undefined') localStorage.setItem('android_wifi_host', wifiHost);
  }
  fetchTelemetry();
});

presetUsb.addEventListener('click', async () => {
  activeChannel = 'usb';
  inputHost.value = USB_HOST;
  inputPort.value = '8080';
  await triggerAdbForward();
  fetchTelemetry();
});

presetWifi.addEventListener('click', () => {
  activeChannel = 'wifi';
  inputHost.value = wifiHost || '192.168.0.82';
  inputPort.value = '8080';
  fetchTelemetry();
});

const presetCloud = document.getElementById('presetCloud');
if (presetCloud) {
  presetCloud.addEventListener('click', () => {
    activeChannel = 'cloud';
    initCloudRelay();
    fetchTelemetry();
  });
}

async function triggerAdbForward() {
  adbOutput.textContent = 'Выполнение adb forward tcp:8080 tcp:8080...';
  const result = await window.electronAPI.forwardAdb(8080);
  if (result.success) {
    adbOutput.textContent = `[УСПЕХ ADB] Порт 8080 перенаправлен по USB.\nГотово к подключению: http://127.0.0.1:8080`;
  } else {
    adbOutput.textContent = `[ОШИБКА ADB] ${result.error}`;
  }
}

btnAdbTunnel.addEventListener('click', triggerAdbForward);

// Проверка ADB при старте
async function initAdb() {
  const dev = await window.electronAPI.checkAdbDevices();
  if (dev.success) {
    adbOutput.textContent = dev.output;
  }
}

// Настройки Cloud Relay
const btnConnectCloud = document.getElementById('btnConnectCloud');
const inputCloudNodeId = document.getElementById('inputCloudNodeId');
const inputCloudSecretKey = document.getElementById('inputCloudSecretKey');
const inputCloudRelayUrl = document.getElementById('inputCloudRelayUrl');

if (inputCloudNodeId) {
  inputCloudNodeId.value = cloudNodeId;
  inputCloudNodeId.addEventListener('input', (e) => {
    cloudNodeId = e.target.value.trim();
    if (typeof localStorage !== 'undefined') localStorage.setItem('cloud_node_id', cloudNodeId);
  });
}
if (inputCloudSecretKey) {
  inputCloudSecretKey.value = cloudSecretKey;
  inputCloudSecretKey.addEventListener('input', (e) => {
    cloudSecretKey = e.target.value.trim();
    if (typeof localStorage !== 'undefined') localStorage.setItem('cloud_secret_key', cloudSecretKey);
  });
}
if (inputCloudRelayUrl) {
  inputCloudRelayUrl.value = cloudRelayUrl;
  inputCloudRelayUrl.addEventListener('input', (e) => {
    cloudRelayUrl = e.target.value.trim();
    if (typeof localStorage !== 'undefined') localStorage.setItem('cloud_relay_url', cloudRelayUrl);
  });
}
if (btnConnectCloud) {
  btnConnectCloud.addEventListener('click', async () => {
    if (inputCloudNodeId) cloudNodeId = inputCloudNodeId.value.trim();
    if (inputCloudSecretKey) cloudSecretKey = inputCloudSecretKey.value.trim();
    if (inputCloudRelayUrl) cloudRelayUrl = inputCloudRelayUrl.value.trim();

    if (!cloudNodeId || !cloudSecretKey) {
      updateCloudUi(false, 'Укажите Node ID и Secret Key');
      return;
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('cloud_node_id', cloudNodeId);
      localStorage.setItem('cloud_secret_key', cloudSecretKey);
      localStorage.setItem('cloud_relay_url', cloudRelayUrl);
    }
    if (cloudWs) {
      try { cloudWs.close(); } catch (_) {}
      cloudWs = null;
    }
    updateCloudUi(false, 'Подключение...');
    initCloudRelay();
    activeChannel = 'cloud';
    fetchTelemetry();
  });
}

// ========================================================
// ⚠️ СБРОС ВСЕХ НАСТРОЕК И СОЕДИНЕНИЯ К ЗАВОДСКИМ (С НУЛЯ)
// ========================================================
const btnFactoryReset = document.getElementById('btnFactoryReset');
const txtFactoryResetStatus = document.getElementById('txtFactoryResetStatus');

if (btnFactoryReset) {
  btnFactoryReset.addEventListener('click', async () => {
    const ok = confirm(
      "⚠️ ВНИМАНИЕ: СБРОС К ЗАВОДСКИМ НАСТРОЙКАМ\n\n" +
      "Это действие полностью сбросит соединение с сервером:\n" +
      "• Будут удалены все сохраненные IP-адреса Wi-Fi\n" +
      "• Будут удалены облачный ID ноды и секретные ключи\n" +
      "• Будет очищен кэш приложения и сессий\n\n" +
      "Приложение вернется к состоянию чистого первого запуска.\n\n" +
      "Сбросить все настройки?"
    );
    if (!ok) return;

    btnFactoryReset.disabled = true;
    btnFactoryReset.textContent = '⏳ СБРОС НАСТРОЕК...';
    if (txtFactoryResetStatus) {
      txtFactoryResetStatus.textContent = 'Очистка кэша и учетных данных...';
      txtFactoryResetStatus.style.color = 'var(--agy-amber)';
    }

    try {
      // 1. Закрываем облачный вебсокет
      if (cloudWs) {
        try { cloudWs.close(); } catch (_) {}
        cloudWs = null;
        cloudIsReady = false;
      }

      // 2. Очищаем LocalStorage браузера / Electron
      if (typeof localStorage !== 'undefined') {
        localStorage.clear();
      }

      // 3. Вызываем Electron API для глубокой очистки сессии на диске
      if (window.electronAPI && typeof window.electronAPI.factoryReset === 'function') {
        await window.electronAPI.factoryReset();
      }

      // 4. Сбрасываем переменные в памяти
      wifiHost = '';
      cloudNodeId = '';
      cloudSecretKey = '';
      cloudRelayUrl = 'ws://192.168.0.199:8088';
      serverPort = 8080;
      activeChannel = 'usb';
      isConnected = false;

      // 5. Очищаем поля ввода
      if (inputHost) inputHost.value = '127.0.0.1';
      if (inputPort) inputPort.value = '8080';
      if (inputCloudNodeId) inputCloudNodeId.value = '';
      if (inputCloudSecretKey) inputCloudSecretKey.value = '';
      if (inputCloudRelayUrl) inputCloudRelayUrl.value = 'ws://192.168.0.199:8088';

      // 6. Сбрасываем бейджи и баннеры
      if (badgePairStatus) {
        badgePairStatus.className = 'badge badge-dim';
        badgePairStatus.textContent = 'ГОТОВО К ПОИСКУ';
      }
      if (txtAutoPairStatus) txtAutoPairStatus.textContent = '';
      if (pairSuccessBanner) {
        pairSuccessBanner.classList.add('hidden');
        pairSuccessBanner.innerHTML = '';
      }
      if (badgeCloudStatus) {
        badgeCloudStatus.className = 'badge badge-dim';
        badgeCloudStatus.textContent = '☁ НЕ НАСТРОЕНО';
      }
      if (txtCloudConnectStatus) txtCloudConnectStatus.textContent = '';
      if (connBadge) {
        connBadge.className = 'badge badge-offline';
        connBadge.textContent = '○ СБРОШЕНО';
      }
      if (latencyBadge) latencyBadge.textContent = 'ПИНГ: --мс';
      if (valActiveHost) valActiveHost.textContent = 'http://127.0.0.1:8080';
      if (valDaemonStatus) {
        valDaemonStatus.className = 'metric-val';
        valDaemonStatus.textContent = 'Сброшено';
      }

      if (txtFactoryResetStatus) {
        txtFactoryResetStatus.textContent = '✓ Все настройки сброшены к заводским! Приложение готово к новому первому запуску.';
        txtFactoryResetStatus.style.color = 'var(--agy-green)';
        setTimeout(() => {
          if (txtFactoryResetStatus) txtFactoryResetStatus.textContent = '';
        }, 5000);
      }
    } catch (err) {
      if (txtFactoryResetStatus) {
        txtFactoryResetStatus.textContent = `Ошибка сброса: ${err.message}`;
        txtFactoryResetStatus.style.color = 'var(--agy-coral)';
      }
    } finally {
      btnFactoryReset.disabled = false;
      btnFactoryReset.textContent = '🗑 СБРОСИТЬ ВСЕ НАСТРОЙКИ С НУЛЯ';
    }
  });
}

const btnScreenOff = document.getElementById('btnScreenOff');
const btnWakeRemote = document.getElementById('btnWakeRemote');
const btnDimRemote = document.getElementById('btnDimRemote');
const screenControlStatus = document.getElementById('screenControlStatus');

function updateScreenStatus(msg) {
  if (!screenControlStatus) return;
  screenControlStatus.textContent = msg;
  setTimeout(() => {
    if (screenControlStatus.textContent === msg) screenControlStatus.textContent = '';
  }, 4000);
}

if (btnScreenOff) {
  btnScreenOff.addEventListener('click', async () => {
    updateScreenStatus('Отправка команды выключения экрана...');
    let done = false;
    if (window.electronAPI && typeof window.electronAPI.execAdb === 'function') {
      const adbRes = await window.electronAPI.execAdb('input keyevent 223');
      if (adbRes.success) done = true;
    }
    try {
      await apiCall('/api/screen/off', 'POST');
    } catch (_) {}

    if (done) {
      updateScreenStatus('✓ Экран планшета выключен (сервер продолжает работу в фоне)');
    } else {
      updateScreenStatus('✓ Команда сна отправлена на устройство');
    }
  });
}

if (btnWakeRemote) {
  btnWakeRemote.addEventListener('click', async () => {
    updateScreenStatus('Отправка команды включения экрана...');
    let done = false;
    if (window.electronAPI && typeof window.electronAPI.execAdb === 'function') {
      const adbRes = await window.electronAPI.execAdb('input keyevent 224');
      if (adbRes.success) done = true;
    }
    try {
      await apiCall('/api/screen/on', 'POST');
    } catch (_) {}

    if (done) {
      updateScreenStatus('✓ Экран планшета пробужден');
    } else {
      updateScreenStatus('✓ Команда пробуждения отправлена');
    }
  });
}

if (btnDimRemote) {
  btnDimRemote.addEventListener('click', async () => {
    if (window.androidAPI && typeof window.androidAPI.toggleDim === 'function') {
      window.androidAPI.toggleDim();
      updateScreenStatus('Режим приглушения переключен');
      return;
    }
    updateScreenStatus('Приглушение яркости экрана...');
    if (window.electronAPI && typeof window.electronAPI.execAdb === 'function') {
      await window.electronAPI.execAdb('settings put system screen_brightness 1');
    }
    try {
      await apiCall('/api/exec', 'POST', { command: 'settings put system screen_brightness 1' });
    } catch (_) {}
    updateScreenStatus('✓ Яркость экрана установлена на минимум (1)');
  });
}

// Логика вкладки удаленных логов
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
    const data = await apiCall('/api/logs');
    allRemoteLogs = (data && data.logs) ? data.logs : [];
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
    logsCounter.textContent = `${filtered.length} записей (всего: ${allRemoteLogs.length})`;
  }

  if (filtered.length === 0) {
    macLogOutput.innerHTML = `<div class="term-line term-system">Нет записей по заданному фильтру.</div>`;
    return;
  }

  const isScrolledToBottom = macLogOutput.scrollHeight - macLogOutput.clientHeight <= macLogOutput.scrollTop + 50;

  macLogOutput.innerHTML = filtered.map(e => {
    const timeStr = e.timestamp ? new Date(e.timestamp).toLocaleTimeString('ru-RU') : '--:--:--';
    const lvl = (e.level || 'ИНФО').toUpperCase();
    let lvlClass = 'log-lvl-info';
    if (lvl === 'WARN' || lvl === 'ВНИМАНИЕ') lvlClass = 'log-lvl-warn';
    else if (lvl === 'ERROR' || lvl === 'ОШИБКА') lvlClass = 'log-lvl-err';
    else if (lvl === 'SYSTEM' || lvl === 'СИСТЕМА') lvlClass = 'log-lvl-green';

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
    btnPauseLogs.textContent = isLogsPaused ? 'ВОЗОБНОВИТЬ' : 'ПАУЗА ПОТОКА';
    btnPauseLogs.style.background = isLogsPaused ? 'var(--agy-amber)' : '';
  });
}

if (btnClearRemoteLogs) {
  btnClearRemoteLogs.addEventListener('click', async () => {
    try {
      await apiCall('/api/logs/clear', 'POST');
      allRemoteLogs = [];
      renderRemoteLogs();
    } catch (_) {}
  });
}

if (btnCopyLogs) {
  btnCopyLogs.addEventListener('click', () => {
    const text = allRemoteLogs.map(e => `[${new Date(e.timestamp).toLocaleTimeString('ru-RU')}] [${e.level}] ${e.message}`).join('\n');
    navigator.clipboard.writeText(text);
    btnCopyLogs.textContent = 'СКОПИРОВАНО!';
    setTimeout(() => { btnCopyLogs.textContent = 'КОПИРОВАТЬ ВСЁ'; }, 2000);
  });
}

// Управление приложениями и деплой
const btnTypeGit = document.getElementById('btnTypeGit');
const btnTypeZip = document.getElementById('btnTypeZip');
const groupGitDeploy = document.getElementById('groupGitDeploy');
const groupZipDeploy = document.getElementById('groupZipDeploy');
const inputGitUrl = document.getElementById('inputGitUrl');
const inputGitToken = document.getElementById('inputGitToken');
const inputZipFile = document.getElementById('inputZipFile');
const btnPickZip = document.getElementById('btnPickZip');
const txtZipChosen = document.getElementById('txtZipChosen');
const inputAppName = document.getElementById('inputAppName');
const inputAppCmd = document.getElementById('inputAppCmd');
const btnDeployApp = document.getElementById('btnDeployApp');
const deployStatusBox = document.getElementById('deployStatusBox');
const btnRefreshApps = document.getElementById('btnRefreshApps');
const appsListGrid = document.getElementById('appsListGrid');

const modalAppLogs = document.getElementById('modalAppLogs');
const modalAppTitle = document.getElementById('modalAppTitle');
const modalAppLogBody = document.getElementById('modalAppLogBody');
const btnModalRefreshLogs = document.getElementById('btnModalRefreshLogs');
const btnModalCloseLogs = document.getElementById('btnModalCloseLogs');

let deployMode = 'git'; // 'git' или 'zip'
let chosenZipBase64 = null;
let currentViewingApp = null;

if (btnTypeGit && btnTypeZip) {
  btnTypeGit.addEventListener('click', () => {
    deployMode = 'git';
    btnTypeGit.classList.add('active');
    btnTypeZip.classList.remove('active');
    groupGitDeploy.classList.remove('hidden');
    groupZipDeploy.classList.add('hidden');
  });

  btnTypeZip.addEventListener('click', () => {
    deployMode = 'zip';
    btnTypeZip.classList.add('active');
    btnTypeGit.classList.remove('active');
    groupZipDeploy.classList.remove('hidden');
    groupGitDeploy.classList.add('hidden');
  });
}

if (btnPickZip && inputZipFile) {
  btnPickZip.addEventListener('click', () => inputZipFile.click());
  inputZipFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      txtZipChosen.textContent = `${file.name} (${formatFileSize(file.size)})`;
      if (!inputAppName.value.trim()) {
        inputAppName.value = file.name.replace(/\.zip$/i, '');
      }
      const reader = new FileReader();
      reader.onload = (evt) => {
        const dataUrl = evt.target.result;
        chosenZipBase64 = dataUrl.split(',')[1];
      };
      reader.readAsDataURL(file);
    }
  });
}

if (inputGitUrl) {
  inputGitUrl.addEventListener('input', () => {
    if (!inputAppName.value.trim() && inputGitUrl.value.trim()) {
      const parts = inputGitUrl.value.trim().replace(/\.git$/i, '').split('/');
      const last = parts[parts.length - 1];
      if (last) inputAppName.value = last;
    }
  });
}

function showDeployStatus(msg, type = 'loading') {
  if (!deployStatusBox) return;
  deployStatusBox.className = `deploy-status-box ${type}`;
  deployStatusBox.textContent = msg;
  deployStatusBox.classList.remove('hidden');
}

if (btnDeployApp) {
  btnDeployApp.addEventListener('click', async () => {
    const name = inputAppName.value.trim();
    const command = inputAppCmd.value.trim();

    if (!name) {
      showDeployStatus('Пожалуйста, укажите имя приложения (папку)', 'error');
      return;
    }

    if (deployMode === 'git') {
      const url = inputGitUrl.value.trim();
      const token = inputGitToken ? inputGitToken.value.trim() : '';
      if (!url) {
        showDeployStatus('Пожалуйста, укажите ссылку на Git-репозиторий', 'error');
        return;
      }

      showDeployStatus(`Загрузка и деплой репозитория '${name}'...`, 'loading');
      try {
        const data = await apiCall('/api/apps/deploy-git', 'POST', { url, name, command, token });
        if (data && data.error) {
          showDeployStatus(`Ошибка деплоя: ${data.error}`, 'error');
        } else {
          showDeployStatus(`✓ Приложение '${name}' успешно развернуто и запущено! (PID: ${data.pid || '--'})`, 'success');
          loadAppsList();
        }
      } catch (err) {
        showDeployStatus(`Сетевая ошибка: ${err.message}`, 'error');
      }
    } else {
      if (!chosenZipBase64) {
        showDeployStatus('Пожалуйста, выберите ZIP-файл для загрузки', 'error');
        return;
      }

      showDeployStatus(`Загрузка архива и запуск приложения '${name}'...`, 'loading');
      try {
        const data = await apiCall('/api/apps/deploy-zip', 'POST', { name, zip_base64: chosenZipBase64, command });
        if (data && data.error) {
          showDeployStatus(`Ошибка деплоя: ${data.error}`, 'error');
        } else {
          showDeployStatus(`✓ Приложение '${name}' успешно развернуто и запущено! (PID: ${data.pid || '--'})`, 'success');
          loadAppsList();
        }
      } catch (err) {
        showDeployStatus(`Сетевая ошибка: ${err.message}`, 'error');
      }
    }
  });
}

if (btnRefreshApps) {
  btnRefreshApps.addEventListener('click', loadAppsList);
}

async function loadAppsList() {
  if (!appsListGrid) return;
  try {
    const data = await apiCall('/api/apps');
    const apps = (data && data.apps) ? data.apps : [];

    if (apps.length === 0) {
      appsListGrid.innerHTML = `
        <div style="grid-column: 1/-1; padding: 24px; text-align: center; color: var(--text-muted); background: var(--bg-surface); border: 1px dashed var(--border-color);">
          <div style="font-size: 24px; margin-bottom: 8px;">📦</div>
          <div>Нет установленных приложений в /sdcard/ServerApps</div>
          <div style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">Используйте форму выше для деплоя Git репозитория или ZIP архива</div>
        </div>
      `;
      return;
    }

    appsListGrid.innerHTML = apps.map(app => {
      const isRunning = app.running;
      const statusBadge = isRunning ? 
        `<span class="app-badge-running">● ЗАПУЩЕНО</span>` : 
        `<span class="app-badge-stopped">○ ОСТАНОВЛЕНО</span>`;

      const uptimeStr = isRunning ? formatSeconds(app.uptime_s) : '--';
      const pidStr = isRunning ? app.pid : '--';
      const shortPath = app.path.includes('ServerApps') ? 
        `.../ServerApps/${app.name}` : 
        app.path;

      return `
        <div class="app-card ${isRunning ? 'running' : 'stopped'}">
          <div class="app-head">
            <span class="app-title">${escapeHtml(app.name)}</span>
            ${statusBadge}
          </div>
          <div class="app-info-row">
            <span class="label">Путь:</span>
            <span class="val" title="${escapeHtml(app.path)}">${escapeHtml(shortPath)}</span>
          </div>
          <div class="app-info-row">
            <span class="label">PID:</span>
            <span class="val">${pidStr}</span>
          </div>
          <div class="app-info-row">
            <span class="label">Аптайм:</span>
            <span class="val">${uptimeStr}</span>
          </div>
          <div class="app-info-row">
            <span class="label">Команда:</span>
            <span class="val" style="color: var(--agy-amber);">${escapeHtml(app.command)}</span>
          </div>

          <div class="app-actions-row">
            ${isRunning ? 
              `<button class="btn-chip btn-stop-app" data-name="${escapeHtml(app.name)}" style="color: var(--agy-coral); border-color: var(--agy-coral);">⏻ ОСТАНОВИТЬ</button>` : 
              `<button class="btn-chip btn-start-app" data-name="${escapeHtml(app.name)}" style="color: var(--agy-green); border-color: var(--agy-green);">▶ ЗАПУСТИТЬ</button>`
            }
            <button class="btn-chip btn-view-app-logs" data-name="${escapeHtml(app.name)}">📋 ЛОГИ</button>
            <button class="btn-chip btn-del-app" data-name="${escapeHtml(app.name)}" style="margin-left: auto; color: var(--text-dim);">🗑 УДАЛИТЬ</button>
          </div>
        </div>
      `;
    }).join('');

    // Вешаем слушатели на кнопки карточек
    appsListGrid.querySelectorAll('.btn-stop-app').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.textContent = '...';
        await apiCall('/api/apps/stop', 'POST', { name: btn.dataset.name });
        loadAppsList();
      });
    });

    appsListGrid.querySelectorAll('.btn-start-app').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.textContent = '...';
        await apiCall('/api/apps/start', 'POST', { name: btn.dataset.name });
        loadAppsList();
      });
    });

    appsListGrid.querySelectorAll('.btn-del-app').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm(`Удалить приложение '${btn.dataset.name}' и все его файлы из /sdcard/ServerApps?`)) {
          btn.textContent = '...';
          await apiCall('/api/apps/delete', 'POST', { name: btn.dataset.name });
          loadAppsList();
        }
      });
    });

    appsListGrid.querySelectorAll('.btn-view-app-logs').forEach(btn => {
      btn.addEventListener('click', () => {
        openAppLogsModal(btn.dataset.name);
      });
    });

  } catch (err) {
    appsListGrid.innerHTML = `<div style="color: var(--agy-coral); padding: 10px;">Ошибка загрузки приложений: ${err.message}</div>`;
  }
}

async function openAppLogsModal(appName) {
  currentViewingApp = appName;
  modalAppTitle.textContent = `[ ЛОГИ ПРИЛОЖЕНИЯ: ${appName} ]`;
  modalAppLogBody.textContent = 'Загрузка логов...';
  modalAppLogs.classList.remove('hidden');

  try {
    const data = await apiCall(`/api/apps/logs?name=${encodeURIComponent(appName)}`, 'GET');
    modalAppLogBody.textContent = (data && data.logs) ? data.logs : 'Логи пусты';
    modalAppLogBody.scrollTop = modalAppLogBody.scrollHeight;
  } catch (err) {
    modalAppLogBody.textContent = `Ошибка получения логов: ${err.message}`;
  }
}

if (btnModalCloseLogs) {
  btnModalCloseLogs.addEventListener('click', () => {
    modalAppLogs.classList.add('hidden');
    currentViewingApp = null;
  });
}

if (btnModalRefreshLogs) {
  btnModalRefreshLogs.addEventListener('click', () => {
    if (currentViewingApp) openAppLogsModal(currentViewingApp);
  });
}

// Запуск опроса
initAdb();
triggerAdbForward().then(() => fetchTelemetry());
pollInterval = setInterval(fetchTelemetry, 2500);
setInterval(fetchRemoteLogs, 2000);

// Автопоиск ноды в локальной сети по mDNS раз в 10 сек
async function autoScanBonjour() {
  try {
    if (window.electronAPI && typeof window.electronAPI.discoverBonjour === 'function') {
      const res = await window.electronAPI.discoverBonjour();
      if (res && res.success && res.ip && res.ip !== '127.0.0.1') {
        if (wifiHost !== res.ip) {
          wifiHost = res.ip;
          if (typeof localStorage !== 'undefined') localStorage.setItem('android_wifi_host', wifiHost);
        }
      }
    }
  } catch (_) {}
}
autoScanBonjour();
setInterval(autoScanBonjour, 10000);

// Фоновая проверка восстановления USB-кабеля (если работаем по Wi-Fi или Облаку)
async function checkUsbReconnection() {
  if (activeChannel !== 'wifi' && activeChannel !== 'cloud') return;
  try {
    if (window.electronAPI && typeof window.electronAPI.forwardAdb === 'function') {
      const fwd = await window.electronAPI.forwardAdb(serverPort);
      if (fwd && fwd.success) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 600);
        const res = await fetch(`http://${USB_HOST}:${serverPort}/api/ping`, { signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) {
          activeChannel = 'usb';
          fetchTelemetry();
        }
      }
    }
  } catch (_) {}
}
setInterval(checkUsbReconnection, 3500);
