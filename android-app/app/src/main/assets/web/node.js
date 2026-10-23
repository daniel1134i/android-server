let isDimmed = false;
let isRunning = true;
let lastLogCount = 0;

// DOM Элементы мониторинга
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

// DOM Элементы вкладок
const nodeTabs = document.querySelectorAll('.node-tab');
const tabTelemetry = document.getElementById('tab-telemetry');
const tabApps = document.getElementById('tab-apps');
const chipAppsLink = document.getElementById('chipAppsLink');

// DOM Элементы вкладки Приложения
const btnRefreshApps = document.getElementById('btnRefreshApps');
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
const appsListGrid = document.getElementById('appsListGrid');

// Модальное окно логов приложения
const modalAppLogs = document.getElementById('modalAppLogs');
const modalAppTitle = document.getElementById('modalAppTitle');
const modalAppLogBody = document.getElementById('modalAppLogBody');
const btnModalRefreshLogs = document.getElementById('btnModalRefreshLogs');
const btnModalCloseLogs = document.getElementById('btnModalCloseLogs');

let deployMode = 'git'; // 'git' или 'zip'
let chosenZipBase64 = null;
let currentViewingApp = null;

// Вспомогательные функции
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Б';
  const k = 1024;
  const sizes = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatSeconds(sec) {
  if (!sec && sec !== 0) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}ч ${m}м ${s}с`;
}

function appendLogEntry(msg, level = 'ИНФО', timestamp = null) {
  if (!logStreamBox) return;
  const row = document.createElement('div');
  row.className = 'log-row';

  const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString('ru-RU') : new Date().toLocaleTimeString('ru-RU');
  
  if (msg.includes('GET') || msg.includes('POST')) {
    row.classList.add('http');
  } else if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('ошибка')) {
    row.classList.add('err');
  } else if (msg.toLowerCase().includes('warn') || msg.toLowerCase().includes('battery') || msg.toLowerCase().includes('батаре')) {
    row.classList.add('warn');
  } else if (msg.toLowerCase().includes('started') || msg.toLowerCase().includes('online') || msg.toLowerCase().includes('запущен')) {
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

// Переключение вкладок
function switchTab(targetTab) {
  nodeTabs.forEach(tab => {
    if (tab.dataset.tab === targetTab) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  if (targetTab === 'telemetry') {
    if (tabTelemetry) tabTelemetry.classList.remove('hidden');
    if (tabApps) tabApps.classList.add('hidden');
  } else if (targetTab === 'apps') {
    if (tabTelemetry) tabTelemetry.classList.add('hidden');
    if (tabApps) tabApps.classList.remove('hidden');
    loadAppsList();
  }
}

nodeTabs.forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

if (chipAppsLink) {
  chipAppsLink.addEventListener('click', () => switchTab('apps'));
}

// Опрос статуса сервера
async function pollStatus() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error('Оффлайн');
    const data = await res.json();

    // Демон активен
    isRunning = true;
    if (badgeDaemon) {
      badgeDaemon.className = 'badge badge-online';
      badgeDaemon.textContent = '● ДЕМОН: ОНЛАЙН';
    }
    if (pulseLed) {
      pulseLed.style.background = 'var(--agy-green)';
      pulseLed.style.boxShadow = '0 0 10px var(--agy-green)';
    }
    if (txtDaemonTitle) {
      txtDaemonTitle.textContent = 'ДЕМОН АКТИВЕН И СЛУШАЕТ ПОРТ';
      txtDaemonTitle.style.color = '#94c55f';
    }
    if (txtDaemonSub) {
      txtDaemonSub.textContent = 'Прием запросов HTTP/JSON RPC на порту 8080 и mDNS на порту 8081';
    }
    if (btnToggleDaemon) {
      btnToggleDaemon.className = 'btn-node btn-toggle';
      btnToggleDaemon.innerHTML = '<span class="btn-icon">⏻</span> ОСТАНОВИТЬ ДЕМОН';
    }

    // Батарея
    const bat = data.battery || {};
    const batPct = bat.percent || 0;
    if (valBatPct) valBatPct.textContent = `${batPct}%`;
    if (valBatTemp) valBatTemp.textContent = `${bat.temp_c || 0}°C`;
    if (barBat) barBat.style.width = `${batPct}%`;
    
    let statusRu = 'ЗАРЯДКА';
    if (bat.status === 'Discharging') statusRu = 'РАЗРЯДКА';
    else if (bat.status === 'Full') statusRu = 'ЗАРЯЖЕНО';
    else if (bat.status === 'Not charging') statusRu = 'НЕ ЗАРЯЖАЕТСЯ';
    if (valBatStatus) valBatStatus.textContent = statusRu;

    let sourceRu = 'Сетевой адаптер (AC)';
    if (bat.plugged === 'USB') sourceRu = 'Порт USB';
    else if (bat.plugged === 'Wireless') sourceRu = 'Беспроводная';
    else if (bat.plugged === 'Battery') sourceRu = 'От аккумулятора';
    if (valBatSource) valBatSource.textContent = sourceRu;

    if (valBatHealth) valBatHealth.textContent = bat.health === 'Good' ? 'Отличное' : (bat.health || 'В норме');
    if (badgeBattery) badgeBattery.textContent = `🔋 ${batPct}%`;

    // ОЗУ
    const mem = data.memory || {};
    const memUsedGb = ((mem.used_mb || 0) / 1024).toFixed(1);
    const memTotalGb = ((mem.total_mb || 0) / 1024).toFixed(1);
    const memPct = mem.used_percent || 0;
    if (valRamPct) valRamPct.textContent = `${memPct}%`;
    if (valRamUsed) valRamUsed.textContent = memUsedGb;
    if (valRamTotal) valRamTotal.textContent = memTotalGb;
    if (barRam) barRam.style.width = `${memPct}%`;

    // Диск
    const st = data.storage || {};
    const diskUsedGb = ((st.used_mb || 0) / 1024).toFixed(1);
    const diskTotalGb = ((st.total_mb || 0) / 1024).toFixed(1);
    const diskPct = st.used_percent || 0;
    if (valDiskPct) valDiskPct.textContent = `${diskPct}%`;
    if (valDiskUsed) valDiskUsed.textContent = diskUsedGb;
    if (valDiskTotal) valDiskTotal.textContent = diskTotalGb;
    if (barDisk) barDisk.style.width = `${diskPct}%`;

    // Устройство и аптайм
    const dev = data.device || {};
    if (valCpuCores) valCpuCores.textContent = `${dev.cores || 8} ядер`;
    if (valCpuArch) valCpuArch.textContent = dev.arch || 'arm64-v8a';
    if (valDeviceModel) valDeviceModel.textContent = dev.model || 'Redmi Pad SE';
    if (valDaemonUptime) valDaemonUptime.textContent = formatSeconds(data.uptime_s);
    if (valSysUptime) valSysUptime.textContent = formatSeconds(data.system_uptime_s);

    // Сетевой IP
    const net = data.network || {};
    if (net.ip && net.ip !== '127.0.0.1') {
      if (valWifiUrl) valWifiUrl.textContent = `http://${net.ip}:${net.port || 8080}`;
      if (badgeWifi) badgeWifi.textContent = `WI-FI: http://${net.ip}:${net.port || 8080}`;
    }

    // Облачный Relay статус
    const cloud = data.cloud || {};
    const valCloudId = document.getElementById('valCloudId');
    if (valCloudId && cloud.node_id) {
      if (valCloudId.textContent && valCloudId.textContent !== cloud.node_id && valCloudId.textContent !== 'node_...') {
        appendLogEntry(`⚡ [ЗАВОДСКОЙ СБРОС] Новые ключи ноды: ${cloud.node_id}`, 'СИСТЕМА');
        showResetBanner();
        if (logStreamBox) logStreamBox.innerHTML = '';
        lastLogCount = 0;
      }
      valCloudId.textContent = cloud.node_id;
      valCloudId.title = `Секретный ключ: ${cloud.secret_key || ''}\nСтатус: ${cloud.connected ? 'Подключено к релею' : 'Ожидание'}`;
      valCloudId.onclick = () => {
        alert(`Ваш облачный доступ:\n\nNode ID: ${cloud.node_id}\nСекретный ключ: ${cloud.secret_key}\nРелей: ${cloud.relay_url}\n\nНикому не сообщайте секретный ключ!`);
      };
    }

    // Счетчик приложений на чипе
    try {
      const appsRes = await fetch('/api/apps', { cache: 'no-store' });
      if (appsRes.ok) {
        const appsData = await appsRes.json();
        const apps = appsData.apps || [];
        const running = apps.filter(a => a.running).length;
        const valAppsCount = document.getElementById('valAppsCount');
        if (valAppsCount) {
          valAppsCount.textContent = `${running} активных (${apps.length} всего) ↗`;
        }
      }
    } catch (_) {}

  } catch (err) {
    isRunning = false;
    if (badgeDaemon) {
      badgeDaemon.className = 'badge badge-offline';
      badgeDaemon.textContent = '○ ДЕМОН: ОСТАНОВЛЕН';
    }
    if (pulseLed) {
      pulseLed.style.background = 'var(--agy-coral)';
      pulseLed.style.boxShadow = '0 0 10px var(--agy-coral)';
    }
    if (txtDaemonTitle) {
      txtDaemonTitle.textContent = 'ДЕМОН ОСТАНОВЛЕН / НА ПАУЗЕ';
      txtDaemonTitle.style.color = 'var(--agy-coral)';
    }
    if (txtDaemonSub) {
      txtDaemonSub.textContent = 'Служба сервера остановлена. Нажмите ЗАПУСТИТЬ ДЕМОН для возобновления.';
    }
    if (btnToggleDaemon) {
      btnToggleDaemon.className = 'btn-node btn-toggle is-stopped';
      btnToggleDaemon.innerHTML = '<span class="btn-icon">▶</span> ЗАПУСТИТЬ ДЕМОН';
    }
  }
}

// Получение логов сервера
async function pollLogs() {
  try {
    const res = await fetch('/api/logs', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const logs = data.logs || [];

    if (logs.length < lastLogCount) {
      // Буфер логов был сброшен на сервере! Очищаем экранный виджет
      if (logStreamBox) logStreamBox.innerHTML = '';
      lastLogCount = 0;
    }

    if (logs.length > lastLogCount) {
      const newEntries = logs.slice(lastLogCount);
      newEntries.forEach(e => appendLogEntry(e.message, e.level, e.timestamp));
      lastLogCount = logs.length;
    }
  } catch (_) {}
}

// Переключение типа деплоя (Git / ZIP)
if (btnTypeGit && btnTypeZip) {
  btnTypeGit.addEventListener('click', () => {
    deployMode = 'git';
    btnTypeGit.classList.add('active');
    btnTypeZip.classList.remove('active');
    if (groupGitDeploy) groupGitDeploy.classList.remove('hidden');
    if (groupZipDeploy) groupZipDeploy.classList.add('hidden');
  });

  btnTypeZip.addEventListener('click', () => {
    deployMode = 'zip';
    btnTypeZip.classList.add('active');
    btnTypeGit.classList.remove('active');
    if (groupZipDeploy) groupZipDeploy.classList.remove('hidden');
    if (groupGitDeploy) groupGitDeploy.classList.add('hidden');
  });
}

// Выбор ZIP файла
if (btnPickZip && inputZipFile) {
  btnPickZip.addEventListener('click', () => inputZipFile.click());
  inputZipFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      if (txtZipChosen) txtZipChosen.textContent = `${file.name} (${formatFileSize(file.size)})`;
      if (inputAppName && !inputAppName.value.trim()) {
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

// Автоподстановка имени приложения из Git URL
if (inputGitUrl) {
  inputGitUrl.addEventListener('input', () => {
    if (inputAppName && !inputAppName.value.trim() && inputGitUrl.value.trim()) {
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

// Деплой приложения
if (btnDeployApp) {
  btnDeployApp.addEventListener('click', async () => {
    const name = inputAppName ? inputAppName.value.trim() : '';
    const command = inputAppCmd ? inputAppCmd.value.trim() : '';

    if (!name) {
      showDeployStatus('Пожалуйста, укажите имя приложения (папку)', 'error');
      return;
    }

    if (deployMode === 'git') {
      const url = inputGitUrl ? inputGitUrl.value.trim() : '';
      const token = inputGitToken ? inputGitToken.value.trim() : '';
      if (!url) {
        showDeployStatus('Пожалуйста, укажите ссылку на Git-репозиторий', 'error');
        return;
      }

      showDeployStatus(`Загрузка и деплой репозитория '${name}'...`, 'loading');
      try {
        const res = await fetch('/api/apps/deploy-git', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, name, command, token })
        });
        const data = await res.json();
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
        const res = await fetch('/api/apps/deploy-zip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, zip_base64: chosenZipBase64, command })
        });
        const data = await res.json();
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

// Загрузка списка развернутых приложений
async function loadAppsList() {
  if (!appsListGrid) return;
  try {
    const res = await fetch('/api/apps', { cache: 'no-store' });
    if (!res.ok) throw new Error('Ошибка связи с сервером');
    const data = await res.json();
    const apps = (data && data.apps) ? data.apps : [];

    const running = apps.filter(a => a.running).length;
    const valAppsCount = document.getElementById('valAppsCount');
    if (valAppsCount) {
      valAppsCount.textContent = `${running} активных (${apps.length} всего) ↗`;
    }

    if (apps.length === 0) {
      appsListGrid.innerHTML = `
        <div class="apps-empty">
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

    // Привязка обработчиков действий
    appsListGrid.querySelectorAll('.btn-start-app').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name;
        btn.textContent = '...';
        await fetch('/api/apps/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        loadAppsList();
      });
    });

    appsListGrid.querySelectorAll('.btn-stop-app').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name;
        btn.textContent = '...';
        await fetch('/api/apps/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        loadAppsList();
      });
    });

    appsListGrid.querySelectorAll('.btn-del-app').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name;
        if (confirm(`Удалить приложение '${name}' и все его файлы?`)) {
          btn.textContent = '...';
          await fetch('/api/apps/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
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
    appsListGrid.innerHTML = `<div class="apps-empty" style="color: var(--agy-coral);">Ошибка загрузки: ${escapeHtml(err.message)}</div>`;
  }
}

if (btnRefreshApps) {
  btnRefreshApps.addEventListener('click', loadAppsList);
}

// Модальное окно просмотра логов приложения
async function openAppLogsModal(appName) {
  currentViewingApp = appName;
  if (!modalAppLogs) return;
  if (modalAppTitle) modalAppTitle.textContent = `[ ЛОГИ: ${appName} ]`;
  if (modalAppLogBody) modalAppLogBody.textContent = 'Загрузка логов приложения...';
  modalAppLogs.classList.remove('hidden');

  await fetchAppLogs(appName);
}

async function fetchAppLogs(appName) {
  if (!appName || !modalAppLogBody) return;
  try {
    const res = await fetch(`/api/apps/logs?name=${encodeURIComponent(appName)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Ошибка чтения логов');
    const data = await res.json();
    const logs = data.logs || '(Лог пуст. Приложение еще ничего не вывело в stdout/stderr)';
    modalAppLogBody.textContent = logs;
    modalAppLogBody.scrollTop = modalAppLogBody.scrollHeight;
  } catch (err) {
    modalAppLogBody.textContent = `Не удалось загрузить логи: ${err.message}`;
  }
}

if (btnModalCloseLogs && modalAppLogs) {
  btnModalCloseLogs.addEventListener('click', () => {
    modalAppLogs.classList.add('hidden');
    currentViewingApp = null;
  });

  modalAppLogs.addEventListener('click', (e) => {
    if (e.target === modalAppLogs) {
      modalAppLogs.classList.add('hidden');
      currentViewingApp = null;
    }
  });
}

if (btnModalRefreshLogs) {
  btnModalRefreshLogs.addEventListener('click', () => {
    if (currentViewingApp) fetchAppLogs(currentViewingApp);
  });
}

// Кнопки управления хост-нодой
if (btnDimScreen) {
  btnDimScreen.addEventListener('click', () => {
    if (window.androidAPI && typeof window.androidAPI.toggleDim === 'function') {
      isDimmed = !isDimmed;
      window.androidAPI.toggleDim();
      btnDimScreen.innerHTML = isDimmed ? 
        '<span class="btn-icon">💡</span> ВЕРНУТЬ ЯРКОСТЬ' : 
        '<span class="btn-icon">🌙</span> OLED ЭКО (ЭКОНОМИЯ 95%)';
      appendLogEntry(`Яркость экрана ${isDimmed ? 'приглушена до минимума' : 'восстановлена'}`, 'ПИТАНИЕ');
    }
  });
}

if (btnToggleDaemon) {
  btnToggleDaemon.addEventListener('click', () => {
    if (window.androidAPI && typeof window.androidAPI.toggleServer === 'function') {
      window.androidAPI.toggleServer();
      setTimeout(pollStatus, 500);
    }
  });
}

if (btnClearLogs) {
  btnClearLogs.addEventListener('click', async () => {
    if (logStreamBox) logStreamBox.innerHTML = '';
    lastLogCount = 0;
    try {
      await fetch('/api/logs/clear');
    } catch (_) {}
    appendLogEntry('Отображение логов очищено', 'СИСТЕМА');
  });
}

const bannerResetAlert = document.getElementById('bannerResetAlert');
const btnDismissResetBanner = document.getElementById('btnDismissResetBanner');
let resetBannerTimer = null;

function showResetBanner() {
  if (bannerResetAlert) {
    bannerResetAlert.style.display = 'flex';
    bannerResetAlert.classList.remove('hidden');
    if (resetBannerTimer) clearTimeout(resetBannerTimer);
    resetBannerTimer = setTimeout(hideResetBanner, 15000);
  }
}

function hideResetBanner() {
  if (bannerResetAlert) {
    bannerResetAlert.style.display = 'none';
    bannerResetAlert.classList.add('hidden');
    if (resetBannerTimer) {
      clearTimeout(resetBannerTimer);
      resetBannerTimer = null;
    }
  }
}

if (btnDismissResetBanner) {
  btnDismissResetBanner.addEventListener('click', (e) => {
    e.stopPropagation();
    hideResetBanner();
  });
  btnDismissResetBanner.addEventListener('touchend', (e) => {
    e.stopPropagation();
    hideResetBanner();
  });
}

if (window.location.search && window.location.search.includes('reset=1')) {
  showResetBanner();
  if (logStreamBox) logStreamBox.innerHTML = '';
  lastLogCount = 0;
  try { window.history.replaceState({}, document.title, window.location.pathname); } catch (_) {}
}

// Инициализация при старте
pollStatus();
pollLogs();

setInterval(pollStatus, 2500);
setInterval(pollLogs, 1500);
