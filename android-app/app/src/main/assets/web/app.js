let serverHost = '127.0.0.1';
let serverPort = 8080;
let isConnected = false;
let currentPath = '/sdcard';
let pollInterval = null;

if (typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http')) {
  serverHost = window.location.hostname || '127.0.0.1';
  serverPort = window.location.port ? parseInt(window.location.port, 10) : 8080;
}

// Заглушка для автономного браузера или Android
if (!window.electronAPI) {
  window.electronAPI = {
    forwardAdb: async () => ({ success: true, output: 'Локальный loopback активен (127.0.0.1:8080)' }),
    checkAdbDevices: async () => ({ success: true, output: 'Локальная нода сервера Android' }),
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

// Опрос телеметрии
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
    connBadge.textContent = '● ОНЛАЙН';
    latencyBadge.textContent = `ПИНГ: ${latency}мс`;
    valDaemonStatus.textContent = 'Онлайн [Активен]';
    valDaemonStatus.className = 'metric-val highlight-green';
    valActiveHost.textContent = getBaseUrl();
  } else {
    connBadge.className = 'badge badge-offline';
    connBadge.textContent = '○ ОФФЛАЙН';
    latencyBadge.textContent = 'ПИНГ: --мс';
    valDaemonStatus.textContent = 'Оффлайн [Недоступен]';
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
    const res = await fetch(`${getBaseUrl()}/api/files?path=${encodeURIComponent(path)}`);
    const data = await res.json();

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

// Настройка подключения
btnAutoScan.addEventListener('click', async () => {
  btnAutoScan.textContent = 'СКАНИРОВАНИЕ...';
  try {
    const res = await window.electronAPI.discoverBonjour();
    if (res.success && res.ip) {
      inputHost.value = res.ip;
      inputPort.value = res.port || 8080;
      serverHost = res.ip;
      serverPort = res.port || 8080;
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
      await fetch(`${getBaseUrl()}/api/logs/clear`);
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
      if (!url) {
        showDeployStatus('Пожалуйста, укажите ссылку на Git-репозиторий', 'error');
        return;
      }

      showDeployStatus(`Загрузка и деплой репозитория '${name}'...`, 'loading');
      try {
        const res = await fetch(`${getBaseUrl()}/api/apps/deploy-git`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, name, command })
        });
        const data = await res.json();
        if (data.error) {
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
        const res = await fetch(`${getBaseUrl()}/api/apps/deploy-zip`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, zip_base64: chosenZipBase64, command })
        });
        const data = await res.json();
        if (data.error) {
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
    const res = await fetch(`${getBaseUrl()}/api/apps`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const apps = data.apps || [];

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

      return `
        <div class="app-card ${isRunning ? 'running' : 'stopped'}">
          <div class="app-head">
            <span class="app-title">${escapeHtml(app.name)}</span>
            ${statusBadge}
          </div>
          <div class="app-info-row">
            <span class="label">Путь:</span>
            <span class="val">${escapeHtml(app.path)}</span>
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
        await fetch(`${getBaseUrl()}/api/apps/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: btn.dataset.name })
        });
        loadAppsList();
      });
    });

    appsListGrid.querySelectorAll('.btn-start-app').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.textContent = '...';
        await fetch(`${getBaseUrl()}/api/apps/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: btn.dataset.name })
        });
        loadAppsList();
      });
    });

    appsListGrid.querySelectorAll('.btn-del-app').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm(`Удалить приложение '${btn.dataset.name}' и все его файлы из /sdcard/ServerApps?`)) {
          btn.textContent = '...';
          await fetch(`${getBaseUrl()}/api/apps/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: btn.dataset.name })
          });
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
    const res = await fetch(`${getBaseUrl()}/api/apps/logs?name=${encodeURIComponent(appName)}`);
    const data = await res.json();
    modalAppLogBody.textContent = data.logs || 'Логи пусты';
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
