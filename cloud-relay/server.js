/**
 * Android Server - Secure Multi-Tenant Cloud Relay Server
 * 
 * Provides isolated, zero-trust WebSocket tunneling between Android Tablets and Mac Controllers.
 * Each device pair has its own Node ID and Secret Key. No cross-communication is possible.
 * Supports multiple controllers per room, request-response routing, and heartbeat keepalive.
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

function safeCompareTokens(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const PORT = process.env.PORT || 8088;
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'android-server-cloud-relay',
      rooms: rooms.size,
      time: Date.now()
    }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Android Server Cloud Relay is operational.\nConnect via WebSocket wss://<host>/?role=...&nodeId=...&token=...');
});

const wss = new WebSocketServer({
  server,
  maxPayload: 25 * 1024 * 1024 // до 25 МБ для деплоя ZIP-архивов
});

// Map of rooms: nodeId -> { token: string, nodeWs: WebSocket|null, controllers: Set<WebSocket> }
const rooms = new Map();

// Map of RPC request IDs to controller socket: reqId -> { ws: WebSocket, timestamp: number }
const pendingRpcRoutes = new Map();

// Очистка устаревших роутов RPC (старше 60 секунд)
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pendingRpcRoutes.entries()) {
    if (now - entry.timestamp > 60000) {
      pendingRpcRoutes.delete(id);
    }
  }
}, 30000);

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let authenticated = false;
  let clientRole = null; // 'node' (планшет) или 'controller' (Mac)
  let currentNodeId = null;

  const authTimer = setTimeout(() => {
    if (!authenticated) {
      try {
        ws.send(JSON.stringify({ type: 'error', code: 408, message: 'Таймаут авторизации: registration handshake required' }));
        ws.close(4408, 'Auth timeout');
      } catch (_) {}
    }
  }, 12000);

  // Парсинг query params (если переданы в URL)
  try {
    const url = new URL(req.url, 'http://localhost');
    const role = url.searchParams.get('role');
    const nodeId = url.searchParams.get('nodeId');
    const token = url.searchParams.get('token');
    if (role && nodeId && token) {
      handleRegistration(ws, { role, nodeId, token });
    }
  } catch (_) {}

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // 1. Сообщение регистрации/хэндшейка
      if (msg.type === 'register') {
        handleRegistration(ws, msg);
        return;
      }

      // Если клиент еще не авторизован - игнорируем трафик
      if (!authenticated || !currentNodeId) {
        ws.send(JSON.stringify({ type: 'error', code: 401, message: 'Сначала выполните регистрацию с правильным токеном' }));
        return;
      }

      const room = rooms.get(currentNodeId);
      if (!room) return;

      // 2. Перенаправление RPC запросов и ответов
      if (clientRole === 'controller') {
        // Запрос от Mac контроллера -> запоминаем отправителя и пересылаем ноде на планшет
        if (msg.id) {
          pendingRpcRoutes.set(msg.id, { ws, timestamp: Date.now() });
        }
        if (room.nodeWs && room.nodeWs.readyState === WebSocket.OPEN) {
          room.nodeWs.send(JSON.stringify(msg));
        } else {
          ws.send(JSON.stringify({
            rpc: 'res',
            id: msg.id,
            status: 503,
            data: { error: 'Планшет временно недоступен (нода не в сети)' }
          }));
        }
      } else if (clientRole === 'node') {
        // Ответ от ноды планшета -> пересылаем конкретному запросившему контроллеру
        if (msg.id && pendingRpcRoutes.has(msg.id)) {
          const entry = pendingRpcRoutes.get(msg.id);
          pendingRpcRoutes.delete(msg.id);
          if (entry.ws.readyState === WebSocket.OPEN) {
            entry.ws.send(JSON.stringify(msg));
            return;
          }
        }
        // Если роут не найден (или broadcast-событие), отправляем всем подключенным контроллерам комнаты
        for (const ctrl of room.controllers) {
          if (ctrl.readyState === WebSocket.OPEN) {
            try { ctrl.send(JSON.stringify(msg)); } catch (_) {}
          }
        }
      }
    } catch (e) {
      console.error('[RELAY ERROR] Не удалось обработать сообщение:', e.message);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (currentNodeId && rooms.has(currentNodeId)) {
      const room = rooms.get(currentNodeId);
      if (clientRole === 'node' && room.nodeWs === ws) {
        room.nodeWs = null;
        for (const ctrl of room.controllers) {
          if (ctrl.readyState === WebSocket.OPEN) {
            try {
              ctrl.send(JSON.stringify({ type: 'event', event: 'node_disconnected', nodeId: currentNodeId }));
            } catch (_) {}
          }
        }
      } else if (clientRole === 'controller') {
        room.controllers.delete(ws);
      }

      // Если все отключились - очищаем комнату через некоторое время
      if (!room.nodeWs && room.controllers.size === 0) {
        setTimeout(() => {
          const r = rooms.get(currentNodeId);
          if (r && !r.nodeWs && r.controllers.size === 0) {
            rooms.delete(currentNodeId);
          }
        }, 60000);
      }
    }
  });

  function handleRegistration(socket, data) {
    const { role, nodeId, token } = data;
    if (!role || !nodeId || !token) {
      socket.send(JSON.stringify({ type: 'error', code: 400, message: 'Отсутствуют обязательные параметры: role, nodeId, token' }));
      return;
    }

    if (role !== 'node' && role !== 'controller') {
      socket.send(JSON.stringify({ type: 'error', code: 400, message: 'Неверная роль: допустимы node или controller' }));
      return;
    }

    // Если комната уже существует - проверяем токен безопасным сравнением
    if (rooms.has(nodeId)) {
      const room = rooms.get(nodeId);
      if (!safeCompareTokens(room.token, token)) {
        socket.send(JSON.stringify({ type: 'error', code: 403, message: 'Ошибка авторизации: неверный секретный ключ для этого Node ID' }));
        socket.close();
        return;
      }
      if (currentNodeId && currentNodeId !== nodeId && rooms.has(currentNodeId)) {
        const oldRoom = rooms.get(currentNodeId);
        if (clientRole === 'node' && oldRoom.nodeWs === socket) oldRoom.nodeWs = null;
        if (clientRole === 'controller') oldRoom.controllers.delete(socket);
      }
      if (role === 'node') {
        if (room.nodeWs && room.nodeWs !== socket) {
          try { room.nodeWs.close(); } catch (_) {}
        }
        room.nodeWs = socket;
      } else {
        room.controllers.add(socket);
      }
    } else {
      // Только планшет (нода) может первично инициализировать комнату
      if (role !== 'node') {
        socket.send(JSON.stringify({ type: 'error', code: 404, message: 'Планшет с данным Node ID еще не подключен к облаку' }));
        socket.close();
        return;
      }
      if (currentNodeId && currentNodeId !== nodeId && rooms.has(currentNodeId)) {
        const oldRoom = rooms.get(currentNodeId);
        if (clientRole === 'node' && oldRoom.nodeWs === socket) oldRoom.nodeWs = null;
        if (clientRole === 'controller') oldRoom.controllers.delete(socket);
      }
      rooms.set(nodeId, {
        token,
        nodeWs: socket,
        controllers: new Set()
      });
    }

    clearTimeout(authTimer);
    authenticated = true;
    clientRole = role;
    currentNodeId = nodeId;

    socket.send(JSON.stringify({
      type: 'registered',
      status: 'ok',
      role,
      nodeId,
      time: Date.now()
    }));

    // Оповещаем о статусе соединения
    const room = rooms.get(nodeId);
    if (role === 'controller' && room.nodeWs && room.nodeWs.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'event', event: 'node_online', nodeId }));
    } else if (role === 'node') {
      for (const ctrl of room.controllers) {
        if (ctrl.readyState === WebSocket.OPEN) {
          try { ctrl.send(JSON.stringify({ type: 'event', event: 'node_online', nodeId })); } catch (_) {}
        }
      }
    }
  }
});

// Периодический пинг с удалением "зависших" сокетов
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, 25000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[CLOUD RELAY] Сервер запущен на http://0.0.0.0:${PORT} (поддержка multi-controller & heartbeat)`);
});
