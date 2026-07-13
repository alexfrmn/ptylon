/**
 * WebSocket Gateway — authenticated browser WS that proxies terminal I/O to the
 * long-lived localhost PTY daemon.
 */

import { WebSocket, WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';

const WS_PORT = parseInt(process.env.WS_PORT || '8791', 10);
const WS_HOST = process.env.WS_HOST || '127.0.0.1';
const PTY_DAEMON_URL = process.env.PTY_DAEMON_URL || `ws://127.0.0.1:${process.env.PTY_DAEMON_PORT || '8792'}`;

if (!process.env.JWT_SECRET) {
  console.error('[WS] FATAL: JWT_SECRET env var is required');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

const clientSessions = new Map(); // browser ws -> Set<sessionId>
const sessionClients = new Map(); // sessionId -> Set<browser ws>
const browserClients = new Set();
const pending = new Map(); // _cid -> { ws, kind }
const daemonQueue = [];
let requestSeq = 0;
let daemon = null;
let daemonReconnectTimer = null;
let daemonWelcome = { sessions: [], stats: { sessions: 0, heapUsedMB: 0, rssMB: 0 }, metadata: [] };

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function tokenFromCookie(header) {
  if (!header) return '';
  for (const item of header.split(';')) {
    const [name, ...value] = item.trim().split('=');
    if (name === 'wc-token') {
      try {
        return decodeURIComponent(value.join('='));
      } catch {
        return '';
      }
    }
  }
  return '';
}

function makeCid(prefix = 'gw') {
  requestSeq += 1;
  return `${prefix}-${Date.now()}-${requestSeq}`;
}

function attachClient(ws, sessionId) {
  if (!clientSessions.has(ws)) clientSessions.set(ws, new Set());
  clientSessions.get(ws).add(sessionId);

  if (!sessionClients.has(sessionId)) sessionClients.set(sessionId, new Set());
  sessionClients.get(sessionId).add(ws);
}

function detachClient(ws) {
  const sessions = clientSessions.get(ws);
  if (sessions) {
    for (const sid of sessions) {
      const clients = sessionClients.get(sid);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) sessionClients.delete(sid);
      }
    }
  }
  clientSessions.delete(ws);
  browserClients.delete(ws);
}

function detachSession(sessionId) {
  const clients = sessionClients.get(sessionId);
  if (clients) {
    for (const ws of clients) {
      const sessions = clientSessions.get(ws);
      sessions?.delete(sessionId);
    }
  }
  sessionClients.delete(sessionId);
}

function broadcastToSession(sessionId, data) {
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  for (const ws of clients) send(ws, data);
}

function broadcastToAll(data) {
  for (const ws of browserClients) send(ws, data);
}

function daemonOpen() {
  return daemon && daemon.readyState === WebSocket.OPEN;
}

function sendToDaemon(msg) {
  if (!daemonOpen()) return false;
  daemon.send(JSON.stringify(msg));
  return true;
}

function forwardRequest(ws, msg, kind = msg.type) {
  const cid = msg._cid || makeCid(kind);
  pending.set(cid, { ws, kind });
  const payload = { ...msg, _cid: cid };
  if (daemonOpen()) {
    sendToDaemon(payload);
  } else {
    daemonQueue.push(payload);
    connectDaemon();
  }
  return true;
}

function flushDaemonQueue() {
  if (!daemonOpen()) return;
  while (daemonQueue.length > 0) {
    daemon.send(JSON.stringify(daemonQueue.shift()));
  }
}

function refreshDaemonState() {
  if (!daemonOpen()) return;
  sendToDaemon({ type: 'list', _cid: makeCid('list-cache') });
  sendToDaemon({ type: 'stats', _cid: makeCid('stats-cache') });
  sendToDaemon({ type: 'metadata', _cid: makeCid('metadata-cache') });
}

function sendLiveWelcome(ws) {
  if (!daemonOpen()) {
    send(ws, {
      type: 'welcome',
      sessions: daemonWelcome.sessions,
      stats: daemonWelcome.stats,
      metadata: daemonWelcome.metadata,
      daemonConnected: false,
      sessionsTrusted: false,
    });
    connectDaemon();
    return;
  }

  const cid = makeCid('welcome-list');
  pending.set(cid, { ws, kind: 'welcome-list' });
  sendToDaemon({ type: 'list', _cid: cid });
}

function connectDaemon() {
  if (daemonOpen() || daemon?.readyState === WebSocket.CONNECTING) return;

  daemon = new WebSocket(PTY_DAEMON_URL);

  daemon.on('open', () => {
    console.log(`[WS] Connected to PTY daemon at ${PTY_DAEMON_URL}`);
    if (daemonReconnectTimer) {
      clearTimeout(daemonReconnectTimer);
      daemonReconnectTimer = null;
    }
    refreshDaemonState();
    flushDaemonQueue();
  });

  daemon.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'welcome') {
      daemonWelcome = {
        sessions: Array.isArray(msg.sessions) ? msg.sessions : [],
        stats: msg.stats || daemonWelcome.stats,
        metadata: Array.isArray(msg.metadata) ? msg.metadata : daemonWelcome.metadata,
      };
      return;
    }

    if (msg._cid) {
      if (msg._cid.startsWith('list-cache') && msg.type === 'sessions') {
        daemonWelcome = { ...daemonWelcome, sessions: Array.isArray(msg.data) ? msg.data : [] };
        return;
      }
      if (msg._cid.startsWith('stats-cache') && msg.type === 'stats') {
        daemonWelcome = { ...daemonWelcome, stats: msg.data || daemonWelcome.stats };
        return;
      }
      if (msg._cid.startsWith('metadata-cache') && msg.type === 'metadata') {
        daemonWelcome = { ...daemonWelcome, metadata: Array.isArray(msg.data) ? msg.data : [] };
        return;
      }

      const item = pending.get(msg._cid);
      if (item) {
        if (item.kind === 'welcome-list' && msg.type === 'sessions') {
          const sessions = Array.isArray(msg.data) ? msg.data : [];
          daemonWelcome = { ...daemonWelcome, sessions };
          send(item.ws, {
            type: 'welcome',
            sessions,
            stats: daemonWelcome.stats,
            metadata: daemonWelcome.metadata,
            daemonConnected: daemonOpen(),
            sessionsTrusted: true,
          });
          pending.delete(msg._cid);
          return;
        }
        if (msg.type === 'created' || msg.type === 'attached') {
          attachClient(item.ws, msg.sessionId);
        }
        send(item.ws, msg);
        if (msg.type === 'created') {
          forwardRequest(item.ws, {
            type: 'attach',
            sessionId: msg.sessionId,
            cols: msg.cols,
            rows: msg.rows,
          }, 'attach-after-create');
        }
        if (msg.type !== 'scrollback') pending.delete(msg._cid);
        if (msg.type === 'error') pending.delete(msg._cid);
        return;
      }
    }

    if (msg.sessionId) {
      broadcastToSession(msg.sessionId, msg);
      if (msg.type === 'exit' || msg.type === 'killed') detachSession(msg.sessionId);
      return;
    }
  });

  daemon.on('close', () => {
    console.warn('[WS] PTY daemon disconnected');
    daemon = null;
    daemonWelcome = { sessions: [], stats: { sessions: 0, heapUsedMB: 0, rssMB: 0 }, metadata: [] };
    for (const { ws } of pending.values()) {
      send(ws, { type: 'error', data: 'PTY daemon disconnected' });
    }
    pending.clear();
    daemonQueue.length = 0;
    scheduleDaemonReconnect();
  });

  daemon.on('error', (err) => {
    console.error('[WS] PTY daemon error:', err.message);
  });
}

function scheduleDaemonReconnect() {
  if (daemonReconnectTimer) return;
  daemonReconnectTimer = setTimeout(() => {
    daemonReconnectTimer = null;
    connectDaemon();
  }, 1000);
}

export function startWsServer() {
  connectDaemon();
  const wss = new WebSocketServer({ port: WS_PORT, host: WS_HOST });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        detachClient(ws);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  wss.on('connection', (ws, req) => {
    const token = tokenFromCookie(req.headers.cookie);

    if (!token) {
      send(ws, { type: 'error', data: 'Missing auth token' });
      ws.close(4001, 'Unauthorized');
      return;
    }

    try {
      jwt.verify(token, JWT_SECRET);
    } catch {
      send(ws, { type: 'error', data: 'Invalid auth token' });
      ws.close(4001, 'Unauthorized');
      return;
    }

    console.log(`[WS] Client connected from ${req.socket.remoteAddress}`);
    browserClients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case 'create':
        case 'attach':
        case 'list':
        case 'stats':
        case 'metadata':
          forwardRequest(ws, msg);
          break;

        case 'admin_notify':
          broadcastToAll({ type: 'admin_notify', title: msg.title, body: msg.body || '' });
          break;

        case 'workspace_updated':
          broadcastToAll({ type: 'workspace_updated', workspaceId: msg.workspaceId || null });
          break;

        case 'input':
        case 'resize':
          if (!sendToDaemon(msg)) send(ws, { type: 'error', data: 'PTY daemon unavailable' });
          break;

        case 'kill':
          if (sendToDaemon(msg)) detachSession(msg.sessionId);
          else send(ws, { type: 'error', data: 'PTY daemon unavailable' });
          break;

        case 'update':
          if (!sendToDaemon(msg)) send(ws, { type: 'error', data: 'PTY daemon unavailable' });
          break;

        default:
          send(ws, { type: 'error', data: `Unknown message type: ${msg.type}` });
      }
    });

    ws.on('close', () => {
      console.log('[WS] Client disconnected');
      detachClient(ws);
    });

    ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
      detachClient(ws);
    });

    sendLiveWelcome(ws);
  });

  const shutdown = () => {
    console.log('[WS] Shutting down gateway...');
    clearInterval(heartbeat);
    if (daemonReconnectTimer) clearTimeout(daemonReconnectTimer);
    daemon?.close();
    wss.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`[WS] WebSocket gateway listening on ${WS_HOST}:${WS_PORT}`);
  return wss;
}

startWsServer();
