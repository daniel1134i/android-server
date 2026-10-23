/**
 * Android Server Controller - Embedded Wi-Fi / Cloud Relay Service
 * 
 * Runs locally inside Electron or standalone on port 8088.
 * Provides zero-trust WebSocket tunneling between Android Tablet and Mac Controller.
 * Resolves Wi-Fi client isolation, AP isolation, and cross-subnet communication.
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

const rooms = new Map();
const pendingRpcRoutes = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pendingRpcRoutes.entries()) {
    if (now - entry.timestamp > 60000) {
      pendingRpcRoutes.delete(id);
    }
  }
}, 30000);

function createRelayServer(port = 8088) {
  const server = http.createServer((req, res) => {
    // CORS headers for local fetch
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (req.url === '/health' || req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        service: 'android-server-cloud-relay',
        rooms: rooms.size,
        time: Date.now()
      }));
    }

    // ⚡ Авто-связывание через релей (если нода уже на связи по Wi-Fi)
    if (req.url === '/api/pair' || req.url === '/api/active-node') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      for (const [nodeId, room] of rooms.entries()) {
        if (room.nodeWs && room.nodeWs.readyState === WebSocket.OPEN) {
          return res.end(JSON.stringify({
            status: 'paired',
            node_id: nodeId,
            secret_key: room.token,
            relay_url: `ws://127.0.0.1:${port}`,
            online: true
          }));
        }
      }
      return res.end(JSON.stringify({ status: 'no_nodes' }));
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Android Server Cloud Relay is operational.\n');
  });

  const wss = new WebSocketServer({
    server,
    maxPayload: 25 * 1024 * 1024
  });

  function handleRegistration(ws, msg) {
    const { role, nodeId, token } = msg;
    if (!role || !nodeId || !token) {
      ws.send(JSON.stringify({ type: 'error', code: 400, message: 'Отсутствуют обязательные поля: role, nodeId, token' }));
      return;
    }
    if (role !== 'node' && role !== 'controller') {
      ws.send(JSON.stringify({ type: 'error', code: 400, message: 'Недопустимая роль. Допустимы: node | controller' }));
      return;
    }

    let room = rooms.get(nodeId);
    if (!room) {
      room = { token, nodeWs: null, controllers: new Set() };
      rooms.set(nodeId, room);
    } else {
      if (!safeCompareTokens(room.token, token)) {
        ws.send(JSON.stringify({ type: 'error', code: 403, message: 'Неверный Secret Key (токен) для данной Node ID' }));
        ws.close(4403, 'Invalid Token');
        return;
      }
    }

    ws.authenticated = true;
    ws.clientRole = role;
    ws.currentNodeId = nodeId;

    if (role === 'node') {
      if (room.nodeWs && room.nodeWs !== ws) {
        try { room.nodeWs.close(4001, 'Замещен новым подключением той же ноды'); } catch (_) {}
      }
      room.nodeWs = ws;
      console.log(`[CLOUD RELAY] Нода подключена: ${nodeId}`);
    } else if (role === 'controller') {
      room.controllers.add(ws);
      console.log(`[CLOUD RELAY] Контроллер подключен к комнате: ${nodeId}`);
    }

    ws.send(JSON.stringify({
      type: 'registered',
      status: 'ok',
      role,
      nodeId,
      time: Date.now()
    }));

    if (role === 'controller' && room.nodeWs && room.nodeWs.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'event', event: 'node_online', nodeId }));
    } else if (role === 'node') {
      for (const ctrl of room.controllers) {
        if (ctrl.readyState === WebSocket.OPEN) {
          try { ctrl.send(JSON.stringify({ type: 'event', event: 'node_online', nodeId })); } catch (_) {}
        }
      }
    }
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.authenticated = false;
    ws.clientRole = null;
    ws.currentNodeId = null;

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

        if (msg.type === 'register') {
          handleRegistration(ws, msg);
          return;
        }

        if (!ws.authenticated || !ws.currentNodeId) {
          ws.send(JSON.stringify({ type: 'error', code: 401, message: 'Сначала выполните регистрацию с правильным токеном' }));
          return;
        }

        const room = rooms.get(ws.currentNodeId);
        if (!room) return;

        if (ws.clientRole === 'controller') {
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
        } else if (ws.clientRole === 'node') {
          if (msg.id && pendingRpcRoutes.has(msg.id)) {
            const entry = pendingRpcRoutes.get(msg.id);
            pendingRpcRoutes.delete(msg.id);
            if (entry.ws.readyState === WebSocket.OPEN) {
              entry.ws.send(JSON.stringify(msg));
              return;
            }
          }
          if (msg.event) {
            for (const ctrl of room.controllers) {
              if (ctrl.readyState === WebSocket.OPEN) {
                try { ctrl.send(JSON.stringify(msg)); } catch (_) {}
              }
            }
          }
        }
      } catch (err) {
        console.error('[CLOUD RELAY Message Error]', err);
      }
    });

    ws.on('close', () => {
      if (ws.currentNodeId && rooms.has(ws.currentNodeId)) {
        const room = rooms.get(ws.currentNodeId);
        if (ws.clientRole === 'node' && room.nodeWs === ws) {
          room.nodeWs = null;
          for (const ctrl of room.controllers) {
            if (ctrl.readyState === WebSocket.OPEN) {
              try { ctrl.send(JSON.stringify({ type: 'event', event: 'node_offline', nodeId: ws.currentNodeId })); } catch (_) {}
            }
          }
        } else if (ws.clientRole === 'controller') {
          room.controllers.delete(ws);
        }
      }
    });
  });

  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    });
  }, 25000);

  server.on('close', () => clearInterval(pingInterval));

  return server;
}

function startRelayServer(port = 8088) {
  const server = createRelayServer(port);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[CLOUD RELAY] Порт ${port} уже занят другим процессом, используем существующий релей.`);
    } else {
      console.error('[CLOUD RELAY Startup Error]', err);
    }
  });

  try {
    server.listen(port, '0.0.0.0', () => {
      console.log(`[CLOUD RELAY] Встроенный Wi-Fi / Cloud Relay активен на http://0.0.0.0:${port}`);
    });
  } catch (_) {}

  return server;
}

module.exports = { startRelayServer, createRelayServer, rooms };
