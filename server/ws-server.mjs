/**
 * WebSocket Server — routes terminal I/O between browser and PTY sessions
 * Protocol: JSON messages { type, sessionId, data, ... }
 */

import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { ptyManager } from './pty-manager.mjs';

const WS_PORT = parseInt(process.env.WS_PORT || '8791', 10);
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required for WS server');
}

// Track which WS client is attached to which PTY session
// Multiple clients can attach to same session (multi-device)
const clientSessions = new Map(); // ws -> Set<sessionId>
const sessionClients = new Map(); // sessionId -> Set<ws>
const hookedSessions = new Set(); // sessionIds with output hooks installed

function broadcastToSession(sessionId, data, excludeWs = null) {
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws !== excludeWs && ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

function attachHooksIfNeeded(sessionId, session) {
  if (!session || hookedSessions.has(sessionId)) return;

  session.pty.onData((output) => {
    broadcastToSession(sessionId, { type: 'output', sessionId, data: output });
  });

  session.pty.onExit(({ exitCode }) => {
    broadcastToSession(sessionId, { type: 'exit', sessionId, code: exitCode });
    sessionClients.delete(sessionId);
    hookedSessions.delete(sessionId);
  });

  hookedSessions.add(sessionId);
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

export function startWsServer() {
  const wss = new WebSocketServer({ port: WS_PORT });

  wss.on('connection', (ws, req) => {
    // Auth: verify JWT from query param
    const url = new URL(req.url, `http://localhost:${WS_PORT}`);
    const token = url.searchParams.get('token');

    if (!token) {
      ws.send(JSON.stringify({ type: 'error', data: 'Missing auth token' }));
      ws.close(4001, 'Unauthorized');
      return;
    }

    try {
      jwt.verify(token, JWT_SECRET);
    } catch {
      ws.send(JSON.stringify({ type: 'error', data: 'Invalid auth token' }));
      ws.close(4001, 'Unauthorized');
      return;
    }

    console.log(`[WS] Client connected from ${req.socket.remoteAddress}`);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed
      }

      const { type, sessionId, data } = msg;

      switch (type) {
        // Create new terminal session
        case 'create': {
          const { cols, rows, cwd, name, color } = msg;
          const newId = ptyManager.create({ cols, rows, cwd, name, color });
          const session = ptyManager.get(newId);

          // Attach client
          attachClient(ws, newId);
          attachHooksIfNeeded(newId, session);

          ws.send(
            JSON.stringify({
              type: 'created',
              sessionId: newId,
              name: session.name,
              color: session.color,
              pid: session.pid,
            }),
          );
          break;
        }

        // Attach to existing session (reconnect)
        case 'attach': {
          const session = ptyManager.get(sessionId);
          if (!session) {
            ws.send(JSON.stringify({ type: 'error', data: `Session ${sessionId} not found` }));
            break;
          }

          attachClient(ws, sessionId);
          attachHooksIfNeeded(sessionId, session);

          // Send scrollback
          const scrollback = ptyManager.getScrollback(sessionId);
          if (scrollback) {
            ws.send(JSON.stringify({ type: 'scrollback', sessionId, data: scrollback }));
          }

          ws.send(
            JSON.stringify({
              type: 'attached',
              sessionId,
              name: session.name,
              color: session.color,
              cols: session.cols,
              rows: session.rows,
            }),
          );
          break;
        }

        // Terminal input
        case 'input': {
          ptyManager.write(sessionId, data);
          break;
        }

        // Resize
        case 'resize': {
          const { cols, rows } = msg;
          ptyManager.resize(sessionId, cols, rows);
          break;
        }

        // Kill session
        case 'kill': {
          ptyManager.kill(sessionId);
          hookedSessions.delete(sessionId);
          broadcastToSession(sessionId, { type: 'killed', sessionId });
          break;
        }

        // Update metadata (name, color)
        case 'update': {
          const { name, color } = msg;
          ptyManager.update(sessionId, { name, color });
          broadcastToSession(sessionId, { type: 'updated', sessionId, name, color });
          break;
        }

        // List sessions
        case 'list': {
          ws.send(JSON.stringify({ type: 'sessions', data: ptyManager.list() }));
          break;
        }

        // Stats
        case 'stats': {
          ws.send(JSON.stringify({ type: 'stats', data: ptyManager.stats() }));
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', data: `Unknown message type: ${type}` }));
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

    // Send welcome + session list
    ws.send(
      JSON.stringify({
        type: 'welcome',
        sessions: ptyManager.list(),
        stats: ptyManager.stats(),
      }),
    );
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('[WS] Shutting down...');
    ptyManager.destroy();
    wss.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`[WS] WebSocket PTY server listening on port ${WS_PORT}`);
  return wss;
}

// Run directly
startWsServer();
