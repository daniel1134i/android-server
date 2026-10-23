/**
 * Android Server - Secure Multi-Tenant Cloud Relay Server
 * 
 * Provides isolated, zero-trust WebSocket tunneling between Android Tablets and Mac Controllers.
 * Each device pair has its own Node ID and Secret Key. No cross-communication is possible.
 */

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8088;
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'android-server-cloud-relay', time: Date.now() }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Android Server Cloud Relay is operational.\nConnect via WebSocket wss://<host>/?role=...&nodeId=...&token=...');
});

const wss = new WebSocketServer({ server });

// Map of rooms: nodeId -> { token: string, nodeWs: WebSocket|null, controllerWs: WebSocket|null }
const rooms = new Map();

wss.on('connection', (ws, req) => {
  let authenticated = false;
  let clientRole = null; // 'node' (планшет) или 'controller' (Mac)
  let currentNodeId = null;

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
      if (clientRole === 'controller' && room.nodeWs && room.nodeWs.readyState === WebSocket.OPEN) {
        // Запрос от Mac контроллера -> пересылаем ноде на планшет
        room.nodeWs.send(JSON.stringify(msg));
      } else if (clientRole === 'node' && room.controllerWs && room.controllerWs.readyState === WebSocket.OPEN) {
        // Ответ от ноды планшета -> пересылаем Mac контроллеру
        room.controllerWs.send(JSON.stringify(msg));
      }
    } catch (e) {
      console.error('[RELAY ERROR] Не удалось обработать сообщение:', e.message);
    }
  });

  ws.on('close', () => {
    if (currentNodeId && rooms.has(currentNodeId)) {
      const room = rooms.get(currentNodeId);
      if (clientRole === 'node' && room.nodeWs === ws) {
        room.nodeWs = null;
        if (room.controllerWs && room.controllerWs.readyState === WebSocket.OPEN) {
          room.controllerWs.send(JSON.stringify({ type: 'event', event: 'node_disconnected', nodeId: currentNodeId }));
        }
      } else if (clientRole === 'controller' && room.controllerWs === ws) {
        room.controllerWs = null;
      }

      // Если оба отключились - очищаем комнату через некоторое время
      if (!room.nodeWs && !room.controllerWs) {
        setTimeout(() => {
          const r = rooms.get(currentNodeId);
          if (r && !r.nodeWs && !r.controllerWs) {
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

    // Если комната уже существует - проверяем токен
    if (rooms.has(nodeId)) {
      const room = rooms.get(nodeId);
      if (room.token !== token) {
        socket.send(JSON.stringify({ type: 'error', code: 403, message: 'Ошибка авторизации: неверный секретный ключ для этого Node ID' }));
        socket.close();
        return;
      }
      if (role === 'node') {
        if (room.nodeWs && room.nodeWs !== socket) {
          try { room.nodeWs.close(); } catch (_) {}
        }
        room.nodeWs = socket;
      } else {
        if (room.controllerWs && room.controllerWs !== socket) {
          try { room.controllerWs.close(); } catch (_) {}
        }
        room.controllerWs = socket;
      }
    } else {
      // Создаем новую изолированную комнату с этим токеном
      rooms.set(nodeId, {
        token,
        nodeWs: role === 'node' ? socket : null,
        controllerWs: role === 'controller' ? socket : null
      });
    }

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

    // Оповещаем контроллер о статусе ноды
    const room = rooms.get(nodeId);
    if (role === 'controller' && room.nodeWs && room.nodeWs.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'event', event: 'node_online', nodeId }));
    } else if (role === 'node' && room.controllerWs && room.controllerWs.readyState === WebSocket.OPEN) {
      room.controllerWs.send(JSON.stringify({ type: 'event', event: 'node_online', nodeId }));
    }
  }
});

// Периодический пинг для предотвращения разрыва соединения провайдерами
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.ping(); } catch (_) {}
    }
  });
}, 25000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[CLOUD RELAY] Сервер запущен на http://0.0.0.0:${PORT}`);
});
