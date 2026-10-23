let isDimmed = false;
let isRunning = true;
let lastLogCount = 0;

// DOM Элементы
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

// Форматирование времени
function formatSeconds(sec) {
  if (!sec && sec !== 0) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}ч ${m}м ${s}с`;
}

function appendLogEntry(msg, level = 'ИНФО', timestamp = null) {
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

// Опрос статуса сервера
async function pollStatus() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error('Оффлайн');
    const data = await res.json();

    // Демон активен
    isRunning = true;
    badgeDaemon.className = 'badge badge-online';
    badgeDaemon.textContent = '● ДЕМОН: ОНЛАЙН';
    pulseLed.style.background = 'var(--agy-green)';
    pulseLed.style.boxShadow = '0 0 10px var(--agy-green)';
    txtDaemonTitle.textContent = 'ДЕМОН АКТИВЕН И СЛУШАЕТ ПОРТ';
    txtDaemonTitle.style.color = '#94c55f';
    txtDaemonSub.textContent = 'Прием запросов HTTP/JSON RPC на порту 8080 и mDNS на порту 8081';
    btnToggleDaemon.className = 'btn-node btn-toggle';
    btnToggleDaemon.innerHTML = '<span class="btn-icon">⏻</span> ОСТАНОВИТЬ ДЕМОН';

    // Батарея
    const bat = data.battery || {};
    const batPct = bat.percent || 0;
    valBatPct.textContent = `${batPct}%`;
    valBatTemp.textContent = `${bat.temp_c || 0}°C`;
    barBat.style.width = `${batPct}%`;
    
    let statusRu = 'ЗАРЯДКА';
    if (bat.status === 'Discharging') statusRu = 'РАЗРЯДКА';
    else if (bat.status === 'Full') statusRu = 'ЗАРЯЖЕНО';
    else if (bat.status === 'Not charging') statusRu = 'НЕ ЗАРЯЖАЕТСЯ';
    valBatStatus.textContent = statusRu;

    let sourceRu = 'Сетевой адаптер (AC)';
    if (bat.plugged === 'USB') sourceRu = 'Порт USB';
    else if (bat.plugged === 'Wireless') sourceRu = 'Беспроводная';
    else if (bat.plugged === 'Battery') sourceRu = 'От аккумулятора';
    valBatSource.textContent = sourceRu;

    valBatHealth.textContent = bat.health === 'Good' ? 'Отличное' : (bat.health || 'В норме');
    badgeBattery.textContent = `🔋 ${batPct}%`;

    // ОЗУ
    const mem = data.memory || {};
    const memUsedGb = ((mem.used_mb || 0) / 1024).toFixed(1);
    const memTotalGb = ((mem.total_mb || 0) / 1024).toFixed(1);
    const memPct = mem.used_percent || 0;
    valRamPct.textContent = `${memPct}%`;
    valRamUsed.textContent = memUsedGb;
    valRamTotal.textContent = memTotalGb;
    barRam.style.width = `${memPct}%`;

    // Диск
    const st = data.storage || {};
    const diskUsedGb = ((st.used_mb || 0) / 1024).toFixed(1);
    const diskTotalGb = ((st.total_mb || 0) / 1024).toFixed(1);
    const diskPct = st.used_percent || 0;
    valDiskPct.textContent = `${diskPct}%`;
    valDiskUsed.textContent = diskUsedGb;
    valDiskTotal.textContent = diskTotalGb;
    barDisk.style.width = `${diskPct}%`;

    // Устройство и аптайм
    const dev = data.device || {};
    valCpuCores.textContent = `${dev.cores || 8} ядер`;
    valCpuArch.textContent = dev.arch || 'arm64-v8a';
    valDeviceModel.textContent = dev.model || 'Redmi Pad SE';
    valDaemonUptime.textContent = formatSeconds(data.uptime_s);
    valSysUptime.textContent = formatSeconds(data.system_uptime_s);

    // Сетевой IP
    const net = data.network || {};
    if (net.ip && net.ip !== '127.0.0.1') {
      valWifiUrl.textContent = `http://${net.ip}:${net.port || 8080}`;
      badgeWifi.textContent = `WI-FI: http://${net.ip}:${net.port || 8080}`;
    }

  } catch (err) {
    isRunning = false;
    badgeDaemon.className = 'badge badge-offline';
    badgeDaemon.textContent = '○ ДЕМОН: ОСТАНОВЛЕН';
    pulseLed.style.background = 'var(--agy-coral)';
    pulseLed.style.boxShadow = '0 0 10px var(--agy-coral)';
    txtDaemonTitle.textContent = 'ДЕМОН ОСТАНОВЛЕН / НА ПАУЗЕ';
    txtDaemonTitle.style.color = 'var(--agy-coral)';
    txtDaemonSub.textContent = 'Служба сервера остановлена. Нажмите ЗАПУСТИТЬ ДЕМОН для возобновления.';
    btnToggleDaemon.className = 'btn-node btn-toggle is-stopped';
    btnToggleDaemon.innerHTML = '<span class="btn-icon">▶</span> ЗАПУСТИТЬ ДЕМОН';
  }
}

// Получение логов
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

// Кнопки управления
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
  appendLogEntry('Отображение логов очищено', 'СИСТЕМА');
});

// Инициализация
pollStatus();
pollLogs();

setInterval(pollStatus, 2500);
setInterval(pollLogs, 1500);
