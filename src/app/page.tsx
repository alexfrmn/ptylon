'use client';

import { useEffect, useState, useCallback } from 'react';
import { useWorkspaceStore } from '@/stores/workspace-store';
import LoginPage from '@/components/LoginPage';
import TabBar from '@/components/TabBar';
import dynamic from 'next/dynamic';

// Lazy-load terminal to avoid SSR issues with xterm.js
const TerminalPanel = dynamic(() => import('@/components/TerminalPanel'), { ssr: false });

export default function Home() {
  const { authenticated, setAuth, tabs, activeTabId, addTab, updateTab, ws, setWs, setWsConnected } =
    useWorkspaceStore();
  const [checking, setChecking] = useState(true);
  const [reconnectNonce, setReconnectNonce] = useState(0);

  // Check auth on mount
  useEffect(() => {
    fetch('/api/auth')
      .then((r) => r.json())
      .then((data) => {
        if (data.authenticated) {
          setAuth(true, data.wsToken);
        }
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, [setAuth]);

  // Connect WebSocket when authenticated
  useEffect(() => {
    if (!authenticated) return;
    const { wsToken } = useWorkspaceStore.getState();
    if (!wsToken) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${wsToken}`;

    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('[WS] Connected');
      setWs(socket);
      setWsConnected(true);
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'welcome') {
          // If server has existing sessions — restore them
          if (msg.sessions && msg.sessions.length > 0) {
            for (const s of msg.sessions) {
              const existing = useWorkspaceStore.getState().tabs.find((t) => t.sessionId === s.id);
              if (!existing) {
                addTab({
                  id: crypto.randomUUID(),
                  type: 'terminal',
                  sessionId: s.id,
                  name: s.name || 'Terminal',
                  color: s.color || '#40E0D0',
                });
              }
            }
          }
          // If no tabs at all — create first one
          if (useWorkspaceStore.getState().tabs.length === 0) {
            addTab({
              id: crypto.randomUUID(),
              type: 'terminal',
              name: 'Terminal 1',
              color: '#40E0D0',
            });
          }
        }
      } catch {
        // ignore
      }
    };

    socket.onclose = () => {
      console.log('[WS] Disconnected');
      setWsConnected(false);
      setWs(null);

      // Reconnect after 3s
      window.setTimeout(() => {
        if (useWorkspaceStore.getState().authenticated) {
          setReconnectNonce((v) => v + 1);
        }
      }, 3000);
    };

    socket.onerror = (err) => {
      console.error('[WS] Error:', err);
    };

    return () => {
      socket.close();
    };
  }, [authenticated, reconnectNonce, setWs, setWsConnected, addTab]);

  const handleSessionCreated = useCallback(
    (tabId: string, sessionId: string) => {
      updateTab(tabId, { sessionId });
    },
    [updateTab],
  );

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0e14]">
        <div className="text-[#40E0D0] font-mono animate-pulse">Loading...</div>
      </div>
    );
  }

  if (!authenticated) {
    return <LoginPage />;
  }

  return (
    <div className="h-screen flex flex-col bg-[#0a0e14] overflow-hidden">
      {/* Tab bar */}
      <TabBar />

      {/* Terminal panels */}
      <div className="flex-1 relative">
        {tabs.map((tab) => (
          <div key={tab.id} className={`absolute inset-0 ${activeTabId === tab.id ? 'z-10' : 'z-0 invisible'}`}>
            {tab.type === 'terminal' && (
              <TerminalPanel
                sessionId={tab.sessionId || null}
                ws={ws}
                isActive={activeTabId === tab.id}
                onSessionCreated={(sid) => handleSessionCreated(tab.id, sid)}
              />
            )}
          </div>
        ))}

        {tabs.length === 0 && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-4 text-[#40E0D0]">⬡</div>
              <p className="text-gray-500 font-mono">No terminals open</p>
              <p className="text-gray-600 font-mono text-sm mt-1">Click + to create one</p>
            </div>
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="h-6 bg-[#0d1117] border-t border-[#1a1e24] flex items-center px-3 gap-4 text-xs font-mono text-gray-600">
        <span className="flex items-center gap-1">
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              useWorkspaceStore.getState().wsConnected ? 'bg-green-400' : 'bg-red-400'
            }`}
          />
          {useWorkspaceStore.getState().wsConnected ? 'Connected' : 'Disconnected'}
        </span>
        <span>
          {tabs.length} tab{tabs.length !== 1 ? 's' : ''}
        </span>
        <span className="ml-auto">console.zakaz.su</span>
      </div>
    </div>
  );
}
