/**
 * PTY Manager — manages persistent terminal sessions
 * Each terminal = own node-pty process, no tmux
 * Sessions survive browser disconnect, reconnect by ID
 */

import { spawn } from 'node-pty';
import { randomUUID } from 'crypto';

const SCROLLBACK_LIMIT = 10000; // lines
const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h

class PtyManager {
  constructor() {
    /** @type {Map<string, {pty: any, scrollback: string[], cwd: string, createdAt: number, lastActivity: number, cols: number, rows: number, name: string, color: string}>} */
    this.sessions = new Map();
    this._cleanupInterval = setInterval(() => this._cleanupIdle(), 60 * 60 * 1000);
  }

  /**
   * Create a new PTY session
   */
  create({ cols = 120, rows = 30, cwd = '/opt/lifecoach', name = 'Terminal', color = '#40E0D0' } = {}) {
    const sessionId = randomUUID();
    const pty = spawn('/bin/bash', [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: 'en_US.UTF-8',
        // Помечаем что это web-console PTY
        WEB_CONSOLE_SESSION: sessionId,
      },
    });

    const session = {
      pty,
      scrollback: [],
      cwd,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      cols,
      rows,
      name,
      color,
      pid: pty.pid,
    };

    // Collect scrollback
    pty.onData((data) => {
      session.lastActivity = Date.now();
      const lines = data.split('\n');
      for (const line of lines) {
        session.scrollback.push(line);
      }
      // Trim scrollback
      if (session.scrollback.length > SCROLLBACK_LIMIT) {
        session.scrollback = session.scrollback.slice(-SCROLLBACK_LIMIT);
      }
    });

    pty.onExit(({ exitCode }) => {
      console.log(`[PTY] Session ${sessionId} exited with code ${exitCode}`);
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, session);
    console.log(`[PTY] Created session ${sessionId} (pid=${pty.pid}, cwd=${cwd})`);
    return sessionId;
  }

  /**
   * Get session by ID
   */
  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Write to PTY stdin
   */
  write(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.pty.write(data);
    session.lastActivity = Date.now();
    return true;
  }

  /**
   * Resize PTY
   */
  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
    return true;
  }

  /**
   * Get scrollback buffer for reconnect
   */
  getScrollback(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return session.scrollback.join('\n');
  }

  /**
   * Kill a session
   */
  kill(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.pty.kill();
    this.sessions.delete(sessionId);
    console.log(`[PTY] Killed session ${sessionId}`);
    return true;
  }

  /**
   * Update session metadata
   */
  update(sessionId, { name, color }) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (name !== undefined) session.name = name;
    if (color !== undefined) session.color = color;
    return true;
  }

  /**
   * List all active sessions
   */
  list() {
    const result = [];
    for (const [id, s] of this.sessions) {
      result.push({
        id,
        name: s.name,
        color: s.color,
        cwd: s.cwd,
        pid: s.pid,
        cols: s.cols,
        rows: s.rows,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        scrollbackLines: s.scrollback.length,
      });
    }
    return result;
  }

  /**
   * Get memory usage stats
   */
  stats() {
    const mem = process.memoryUsage();
    return {
      sessions: this.sessions.size,
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    };
  }

  /**
   * Cleanup idle sessions (>24h no activity)
   */
  _cleanupIdle() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > IDLE_TIMEOUT_MS) {
        console.log(`[PTY] Cleaning up idle session ${id} (inactive ${Math.round((now - session.lastActivity) / 3600000)}h)`);
        session.pty.kill();
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Graceful shutdown
   */
  destroy() {
    clearInterval(this._cleanupInterval);
    for (const [id, session] of this.sessions) {
      session.pty.kill();
    }
    this.sessions.clear();
    console.log('[PTY] All sessions destroyed');
  }
}

// Singleton
export const ptyManager = new PtyManager();
export default ptyManager;
