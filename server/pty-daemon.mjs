/**
 * PTY Daemon — owns terminal processes independently from the browser WS gateway.
 *
 * The public WebSocket server is allowed to restart without killing shells; this
 * daemon is the long-lived owner of node-pty processes and their scrollback.
 */

import { WebSocketServer } from 'ws';
import { ptyManager } from './pty-manager.mjs';
import { isAllowedPtyClient } from './pty-network-policy.mjs';

const PTY_DAEMON_HOST = process.env.PTY_DAEMON_HOST || '127.0.0.1';
const PTY_DAEMON_PORT = parseInt(process.env.PTY_DAEMON_PORT || '8792', 10);
const PTY_DAEMON_ALLOW_NETWORK = process.env.PTY_DAEMON_ALLOW_NETWORK === 'true';

const clientSessions = new Map(); // ws -> Set<sessionId>
const sessionClients = new Map(); // sessionId -> Set<ws>
const wiredSessions = new Set();

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
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
}

function broadcastToSession(sessionId, data) {
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  for (const ws of clients) send(ws, data);
}

function wireSession(sessionId) {
  if (wiredSessions.has(sessionId)) return;
  const session = ptyManager.get(sessionId);
  if (!session) return;
  wiredSessions.add(sessionId);

  session.pty.onData((output) => {
    broadcastToSession(sessionId, { type: 'output', sessionId, data: output });
  });

  session.pty.onExit(({ exitCode }) => {
    broadcastToSession(sessionId, { type: 'exit', sessionId, code: exitCode });
    sessionClients.delete(sessionId);
    wiredSessions.delete(sessionId);
  });
}

function welcomePayload() {
  return {
    type: 'welcome',
    sessions: ptyManager.list(),
    stats: ptyManager.stats(),
  };
}

export function startPtyDaemon() {
  const wss = new WebSocketServer({ host: PTY_DAEMON_HOST, port: PTY_DAEMON_PORT });

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
    const remote = req.socket.remoteAddress;
    if (!isAllowedPtyClient(remote, PTY_DAEMON_ALLOW_NETWORK)) {
      send(ws, { type: 'error', data: 'PTY daemon accepts localhost clients only' });
      ws.close(4003, 'Forbidden');
      return;
    }

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    send(ws, welcomePayload());

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const { type, sessionId, data, _cid } = msg;

      switch (type) {
        case 'create': {
          const { cols, rows, cwd, name, color } = msg;
          const newId = ptyManager.create({ cols, rows, cwd, name, color });
          const session = ptyManager.get(newId);
          wireSession(newId);
          attachClient(ws, newId);
          send(ws, {
            type: 'created',
            sessionId: newId,
            name: session.name,
            color: session.color,
            pid: session.pid,
            cols: session.cols,
            rows: session.rows,
            _cid,
          });
          break;
        }

        case 'attach': {
          const session = ptyManager.get(sessionId);
          if (!session) {
            send(ws, { type: 'error', data: `Session ${sessionId} not found`, sessionId, _cid });
            break;
          }
          ptyManager.touch(sessionId);
          wireSession(sessionId);
          attachClient(ws, sessionId);

          const scrollback = ptyManager.getScrollback(sessionId);
          if (scrollback) {
            send(ws, { type: 'scrollback', sessionId, data: scrollback, _cid });
          }

          send(ws, {
            type: 'attached',
            sessionId,
            name: session.name,
            color: session.color,
            cols: session.cols,
            rows: session.rows,
            _cid,
          });
          break;
        }

        case 'input':
          ptyManager.write(sessionId, data);
          break;

        case 'resize': {
          const { cols, rows } = msg;
          ptyManager.resize(sessionId, cols, rows);
          break;
        }

        case 'kill':
          if (ptyManager.kill(sessionId)) {
            broadcastToSession(sessionId, { type: 'killed', sessionId });
            sessionClients.delete(sessionId);
            wiredSessions.delete(sessionId);
          }
          break;

        case 'update': {
          const { name, color } = msg;
          if (ptyManager.update(sessionId, { name, color })) {
            broadcastToSession(sessionId, { type: 'updated', sessionId, name, color });
          }
          break;
        }

        case 'list':
          send(ws, { type: 'sessions', data: ptyManager.list(), _cid });
          break;

        case 'stats':
          send(ws, { type: 'stats', data: ptyManager.stats(), _cid });
          break;

        case 'metadata':
          send(ws, { type: 'metadata', data: await ptyManager.metadata(), _cid });
          break;

        default:
          send(ws, { type: 'error', data: `Unknown message type: ${type}`, _cid });
      }
    });

    ws.on('close', () => detachClient(ws));
    ws.on('error', () => detachClient(ws));
  });

  const shutdown = () => {
    console.log('[PTYD] Shutting down...');
    clearInterval(heartbeat);
    ptyManager.destroy();
    wss.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`[PTYD] PTY daemon listening on ${PTY_DAEMON_HOST}:${PTY_DAEMON_PORT}`);
  return wss;
}

startPtyDaemon();
