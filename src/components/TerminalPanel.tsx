'use client';

import { useEffect, useRef, useCallback, useState } from 'react';

interface TerminalPanelProps {
  sessionId: string | null;
  ws: WebSocket | null;
  isActive: boolean;
  onSessionCreated?: (sessionId: string) => void;
}

export default function TerminalPanel({ sessionId, ws, isActive, onSessionCreated }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const attachedRef = useRef(false);

  const handleWsMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.sessionId && msg.sessionId !== sessionId && msg.sessionId !== 'pending') return;

        switch (msg.type) {
          case 'created':
            if (onSessionCreated) onSessionCreated(msg.sessionId);
            setStatus('connected');
            break;

          case 'attached':
            setStatus('connected');
            break;

          case 'output':
            if (termRef.current) termRef.current.write(msg.data);
            break;

          case 'scrollback':
            if (termRef.current) termRef.current.write(msg.data);
            break;

          case 'exit':
            setStatus('disconnected');
            break;
        }
      } catch {
        // ignore
      }
    },
    [sessionId, onSessionCreated]
  );

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let term: any;
    let fitAddon: any;

    async function init() {
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');
      const { WebLinksAddon } = await import('@xterm/addon-web-links');

      if (disposed) return;

      term = new Terminal({
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

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      term.open(containerRef.current!);
      fitAddon.fit();

      // Terminal input → WS
      term.onData((data: string) => {
        if (ws && ws.readyState === WebSocket.OPEN && sessionId) {
          ws.send(JSON.stringify({ type: 'input', sessionId, data }));
        }
      });

      // Resize observer
      const observer = new ResizeObserver(() => {
        if (!disposed && fitAddon) {
          fitAddon.fit();
          if (ws && ws.readyState === WebSocket.OPEN && sessionId && term) {
            ws.send(
              JSON.stringify({ type: 'resize', sessionId, cols: term.cols, rows: term.rows })
            );
          }
        }
      });
      observer.observe(containerRef.current!);

      // Create or attach to session
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (sessionId && !attachedRef.current) {
          ws.send(JSON.stringify({ type: 'attach', sessionId }));
          attachedRef.current = true;
        } else if (!sessionId) {
          const cols = term.cols;
          const rows = term.rows;
          ws.send(JSON.stringify({ type: 'create', cols, rows }));
        }
      }

      return () => {
        observer.disconnect();
      };
    }

    init();

    return () => {
      disposed = true;
      termRef.current?.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      attachedRef.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen to WS messages
  useEffect(() => {
    if (!ws) return;
    ws.addEventListener('message', handleWsMessage);
    return () => ws.removeEventListener('message', handleWsMessage);
  }, [ws, handleWsMessage]);

  // Focus terminal when tab becomes active
  useEffect(() => {
    if (isActive && termRef.current) {
      termRef.current.focus();
      fitAddonRef.current?.fit();
    }
  }, [isActive]);

  return (
    <div className="h-full w-full relative">
      {/* Status indicator */}
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

      {/* Terminal container */}
      <div ref={containerRef} className="h-full w-full" style={{ padding: '4px' }} />
    </div>
  );
}
