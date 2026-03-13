'use client';

import { useEffect, useRef, useState } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

interface TerminalPanelProps {
  sessionId: string | null;
  ws: WebSocket | null;
  isActive: boolean;
  onSessionCreated?: (sessionId: string) => void;
}

export default function TerminalPanel({ sessionId, ws, isActive, onSessionCreated }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeTimerRef = useRef<number | null>(null);

  const sessionIdRef = useRef<string | null>(sessionId);
  const wsRef = useRef<WebSocket | null>(ws);
  const onSessionCreatedRef = useRef(onSessionCreated);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');

  // Keep refs in sync with props
  sessionIdRef.current = sessionId;
  wsRef.current = ws;
  onSessionCreatedRef.current = onSessionCreated;

  // Main init — runs once
  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;

    async function init() {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);

      if (disposed) return;

      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: 'block',
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
        scrollback: 5000,
        theme: {
          background: '#0a0e14',
          foreground: '#e0e0e0',
          cursor: '#40E0D0',
          cursorAccent: '#0a0e14',
          selectionBackground: '#40E0D040',
          black: '#1a1e24',
          red: '#ff6b6b',
          green: '#69db7c',
          yellow: '#ffd43b',
          blue: '#74c0fc',
          magenta: '#da77f2',
          cyan: '#40E0D0',
          white: '#e0e0e0',
          brightBlack: '#495057',
          brightRed: '#ff8787',
          brightGreen: '#8ce99a',
          brightYellow: '#ffe066',
          brightBlue: '#a5d8ff',
          brightMagenta: '#e599f7',
          brightCyan: '#63e6be',
          brightWhite: '#ffffff',
        },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      term.open(containerRef.current!);
      fitAddon.fit();

      // Send create/attach NOW that terminal is ready
      const sock = wsRef.current;
      if (sock && sock.readyState === WebSocket.OPEN) {
        if (sessionIdRef.current) {
          sock.send(JSON.stringify({ type: 'attach', sessionId: sessionIdRef.current }));
        } else {
          sock.send(JSON.stringify({ type: 'create', cols: term.cols, rows: term.rows }));
        }
      }

      // Terminal input → WS (uses refs for latest values)
      term.onData((data: string) => {
        const currentWs = wsRef.current;
        const sid = sessionIdRef.current;
        if (currentWs && currentWs.readyState === WebSocket.OPEN && sid) {
          currentWs.send(JSON.stringify({ type: 'input', sessionId: sid, data }));
        }
      });

      // Resize observer (debounced)
      const observer = new ResizeObserver(() => {
        if (disposed || !fitAddon || !termRef.current) return;

        if (resizeTimerRef.current !== null) {
          window.clearTimeout(resizeTimerRef.current);
        }

        resizeTimerRef.current = window.setTimeout(() => {
          fitAddon.fit();
          const currentWs = wsRef.current;
          const sid = sessionIdRef.current;
          if (currentWs && currentWs.readyState === WebSocket.OPEN && sid && termRef.current) {
            currentWs.send(
              JSON.stringify({ type: 'resize', sessionId: sid, cols: termRef.current.cols, rows: termRef.current.rows }),
            );
          }
        }, 50);
      });

      resizeObserverRef.current = observer;
      observer.observe(containerRef.current!);
    }

    void init();

    return () => {
      disposed = true;

      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }

      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;

      termRef.current?.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // WS message handler — uses refs so no stale closure
  useEffect(() => {
    if (!ws) return;

    function handleMessage(event: MessageEvent) {
      try {
        const msg = JSON.parse(event.data);

        // For 'created' — this is our session being born
        if (msg.type === 'created' && !sessionIdRef.current) {
          sessionIdRef.current = msg.sessionId;
          if (onSessionCreatedRef.current) onSessionCreatedRef.current(msg.sessionId);
          setStatus('connected');
          return;
        }

        // Filter messages for other sessions
        if (msg.sessionId && msg.sessionId !== sessionIdRef.current) return;

        switch (msg.type) {
          case 'attached':
            setStatus('connected');
            break;
          case 'output':
            termRef.current?.write(msg.data);
            break;
          case 'scrollback':
            termRef.current?.write(msg.data);
            break;
          case 'exit':
            setStatus('disconnected');
            break;
          default:
            break;
        }
      } catch {
        // ignore
      }
    }

    ws.addEventListener('message', handleMessage);
    return () => ws.removeEventListener('message', handleMessage);
  }, [ws]);

  // If WS connects AFTER terminal is already initialized
  useEffect(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !termRef.current || sessionIdRef.current) return;
    // Terminal exists but no session yet — create one
    ws.send(JSON.stringify({ type: 'create', cols: termRef.current.cols, rows: termRef.current.rows }));
  }, [ws]);

  // Focus terminal when tab becomes active
  useEffect(() => {
    if (isActive && termRef.current) {
      termRef.current.focus();
      fitAddonRef.current?.fit();
    }
  }, [isActive]);

  return (
    <div className="h-full w-full relative">
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5">
        <div
          className={`w-2 h-2 rounded-full ${
            status === 'connected'
              ? 'bg-green-400 animate-pulse'
              : status === 'connecting'
                ? 'bg-amber-400 animate-pulse'
                : 'bg-red-400'
          }`}
        />
        <span className="text-xs text-gray-500 font-mono">{status}</span>
      </div>
      <div ref={containerRef} className="h-full w-full" style={{ padding: '4px' }} />
    </div>
  );
}
