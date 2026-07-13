'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useCircadianTheme, CircadianMode } from '@/hooks/useCircadianTheme';
import { metadataPrimary, metadataSecondary } from '@/lib/session-metadata';
import { buildWorkspaceFromRecipe, type WorkspaceRecipe } from '@/lib/recipes';
import LoginPage from '@/components/LoginPage';
import TabBar from '@/components/TabBar';
import Sidebar from '@/components/Sidebar';
import Onboarding from '@/components/Onboarding';
import CommandPalette from '@/components/CommandPalette';
import ThemeGallery from '@/components/ThemeGallery';
import FileManager from '@/components/FileManager';
import DropZone from '@/components/DropZone';
import ErrorBoundary from '@/components/ErrorBoundary';
import SplitContainer, { type SplitNode } from '@/components/SplitContainer';
import VoiceInput from '@/components/VoiceInput';
import dynamic from 'next/dynamic';

const TerminalPanel = dynamic(() => import('@/components/TerminalPanel'), { ssr: false });
const MonacoEditorPanel = dynamic(() => import('@/components/MonacoEditor'), { ssr: false });
const BrowserPanel = dynamic(() => import('@/components/BrowserPanel'), { ssr: false });

const THEME_LABELS: Record<CircadianMode, string> = {
  auto: 'auto',
  day: 'day',
  evening: 'evening',
  night: 'night',
  system: 'system',
};
const THEME_MODES: CircadianMode[] = ['auto', 'day', 'evening', 'night', 'system'];
const DEFAULT_WS_PORT = process.env.NEXT_PUBLIC_WS_PORT || '8791';
const APP_LABEL = process.env.NEXT_PUBLIC_APP_LABEL || 'Web Console';

// --- Tree helpers ---

function findLeafByTabId(node: SplitNode | null, tabId: string): SplitNode | null {
  if (!node) return null;
  if (node.type === 'leaf' && node.tabId === tabId) return node;
  for (const child of node.children || []) {
    const found = findLeafByTabId(child, tabId);
    if (found) return found;
  }
  return null;
}

function findLeafById(node: SplitNode | null, id: string): SplitNode | null {
  if (!node) return null;
  if (node.id === id && node.type === 'leaf') return node;
  for (const child of node.children || []) {
    const found = findLeafById(child, id);
    if (found) return found;
  }
  return null;
}

function findFirstLeaf(node: SplitNode): SplitNode | null {
  if (node.type === 'leaf') return node;
  for (const child of node.children || []) {
    const found = findFirstLeaf(child);
    if (found) return found;
  }
  return null;
}

function updateNodeInTree(root: SplitNode, id: string, updater: (n: SplitNode) => SplitNode): SplitNode {
  if (root.id === id) return updater(root);
  if (root.type === 'split' && root.children) {
    return { ...root, children: root.children.map((c) => updateNodeInTree(c, id, updater)) };
  }
  return root;
}

function removeLeafFromTree(root: SplitNode, leafId: string): SplitNode | null {
  if (root.type === 'leaf') return root.id === leafId ? null : root;
  const next = (root.children ?? []).map((c) => removeLeafFromTree(c, leafId)).filter(Boolean) as SplitNode[];
  if (next.length === 0) return null;
  if (next.length === 1) return next[0];
  const sizes = new Array(next.length).fill(100 / next.length);
  return { ...root, children: next, sizes };
}

function countLeaves(node: SplitNode): number {
  if (node.type === 'leaf') return 1;
  return (node.children || []).reduce((sum, c) => sum + countLeaves(c), 0);
}

function collectKnownSessionIds(
  tabs: ReturnType<typeof useWorkspaceStore.getState>['tabs'],
  workspaces: ReturnType<typeof useWorkspaceStore.getState>['workspaces']
) {
  const ids = new Set<string>();
  const addTabSession = (tab: { sessionId?: string }) => {
    if (tab.sessionId) ids.add(tab.sessionId);
  };
  tabs.forEach(addTabSession);
  workspaces.forEach((ws) => ws.tabs.forEach(addTabSession));
  return ids;
}

function getWebSocketUrl() {
  const override = process.env.NEXT_PUBLIC_WS_URL;
  if (override) {
    return override;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const isLocalHost = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
  if (isLocalHost) {
    return `${protocol}//${window.location.hostname}:${DEFAULT_WS_PORT}`;
  }
  return `${protocol}//${window.location.host}/ws`;
}

function browserTabName(url: string) {
  try {
    return new URL(url).hostname || 'Browser';
  } catch {
    return 'Browser';
  }
}

// --- Main Component ---

export default function Home() {
  const { authenticated, setAuth, tabs, activeTabId, addTab, removeTab, updateTab, setActiveTab,
          ws, setWs, setWsConnected, wsConnected, splitTree, setSplitTree,
          sidebarOpen, setSidebarOpen, workspaces, activeWorkspaceId, addWorkspace, switchWorkspace,
          notifications, addNotification, markNotificationsReadForTab,
          sessionMetadata, setSessionMetadata } = useWorkspaceStore();
  const [checking, setChecking] = useState(true);
  const [serverSynced, setServerSynced] = useState(false);
  const [wsReconnectKey, setWsReconnectKey] = useState(0);
  const circadian = useCircadianTheme(authenticated && serverSynced);
  const [editorFiles, setEditorFiles] = useState<Record<string, { content: string; dirty: boolean }>>({});
  const editorRestored = useRef<Set<string>>(new Set());
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [themeGalleryOpen, setThemeGalleryOpen] = useState(false);
  const [recipes, setRecipes] = useState<WorkspaceRecipe[]>([]);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mobileSidebarInitializedRef = useRef(false);

  // --- Auth + Server Sync ---
  useEffect(() => {
    fetch('/api/auth')
      .then((r) => r.json())
      .then(async (data) => {
        if (data.authenticated) {
          setAuth(true, data.wsToken);
          // Load state from server (cross-device sync)
          await useWorkspaceStore.getState().syncFromServer();
          setServerSynced(true);
        } else {
          // Do not retain a client-side login after the server rejects an
          // expired or rotated token; otherwise the UI loops on a closed WS.
          setAuth(false);
        }
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, [setAuth]);

  // On phones, a sidebar restored from desktop should not cover the first view.
  useEffect(() => {
    if (!authenticated || checking || mobileSidebarInitializedRef.current) return;
    mobileSidebarInitializedRef.current = true;
    if (window.matchMedia('(max-width: 640px)').matches && sidebarOpen) {
      setSidebarOpen(false);
    }
  }, [authenticated, checking, sidebarOpen, setSidebarOpen]);

  useEffect(() => {
    if (!authenticated) return;
    fetch('/api/recipes')
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((data) => setRecipes(Array.isArray(data?.recipes) ? data.recipes : []))
      .catch(() => setRecipes([]));
  }, [authenticated]);

  // --- Editor content restore ---
  useEffect(() => {
    if (!authenticated) return;
    const editorTabs = tabs.filter((t) => t.type === 'editor' && t.filePath);
    for (const tab of editorTabs) {
      if (editorFiles[tab.id] || editorRestored.current.has(tab.id)) continue;
      editorRestored.current.add(tab.id);
      fetch(`/api/files/read?path=${encodeURIComponent(tab.filePath!)}`)
        .then((r) => r.ok ? r.json() : Promise.reject(r.status))
        .then((data) => {
          if (data?.content !== undefined) {
            setEditorFiles((prev) => prev[tab.id] ? prev : { ...prev, [tab.id]: { content: data.content, dirty: false } });
          }
        })
        .catch(() => {
          setEditorFiles((prev) => prev[tab.id] ? prev : { ...prev, [tab.id]: { content: '', dirty: false } });
        });
    }
  }, [authenticated, tabs, editorFiles]);

  // --- WebSocket ---
  useEffect(() => {
    if (!authenticated) return;
    let closedByCleanup = false;
    const wsUrl = getWebSocketUrl();
    const socket = new WebSocket(wsUrl);
    socket.onopen = () => {
      if (closedByCleanup) return;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      setWs(socket);
      setWsConnected(true);
    };
    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'workspace_updated') {
          useWorkspaceStore.getState().syncFromServer();
          return;
        }
        if (msg.type === 'admin_notify') {
          const state = useWorkspaceStore.getState();
          const tabId = state.activeTabId || state.tabs[0]?.id;
          if (tabId) {
            state.addNotification({
              tabId,
              workspaceId: state.activeWorkspaceId,
              protocol: 'osc9',
              title: String(msg.title || 'Web Console'),
              body: typeof msg.body === 'string' ? msg.body : undefined,
            });
          }
          return;
        }
        if (msg.type === 'welcome') {
          const state = useWorkspaceStore.getState();
          const sessions = Array.isArray(msg.sessions) ? msg.sessions as Array<{ id: string; name?: string }> : [];
          const serverSessions = new Set<string>(sessions.map((s) => s.id));
          const sessionsTrusted = msg.sessionsTrusted !== false;
          if (state.tabs.length > 0 && sessionsTrusted) {
            state.clearMissingTerminalSessions(serverSessions);
            const nextState = useWorkspaceStore.getState();
            const knownSessionIds = collectKnownSessionIds(nextState.tabs, nextState.workspaces);
            for (const s of sessions) {
              if (!knownSessionIds.has(s.id)) {
                addTab({ id: crypto.randomUUID(), type: 'terminal', sessionId: s.id, name: s.name || 'Recovered Terminal', color: '#40E0D0' });
                knownSessionIds.add(s.id);
              }
            }
          } else if (state.tabs.length === 0 && sessions.length > 0) {
            for (const s of sessions) {
              addTab({ id: crypto.randomUUID(), type: 'terminal', sessionId: s.id, name: s.name || 'Terminal', color: '#40E0D0' });
            }
          } else if (state.tabs.length === 0 && sessionsTrusted) {
            addTab({ id: crypto.randomUUID(), type: 'terminal', name: 'Terminal 1', color: '#40E0D0' });
          }
        }
      } catch { /* ignore */ }
    };
    socket.onclose = () => {
      if (closedByCleanup) return;
      setWsConnected(false);
      setWs(null);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        if (useWorkspaceStore.getState().authenticated) {
          setWsReconnectKey((n) => n + 1);
        }
      }, 3000);
    };
    socket.onerror = () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    };
    return () => {
      closedByCleanup = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      socket.close();
    };
  }, [authenticated, wsReconnectKey, setWs, setWsConnected, addTab, setAuth]);

  // --- Server stats polling ---
  const [serverStats, setServerStats] = useState<{ sessions: number; heapMB: number; rssMB: number } | null>(null);
  useEffect(() => {
    if (!ws || !wsConnected) return;
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'stats' && msg.data) {
          setServerStats({
            sessions: msg.data.sessions ?? 0,
            heapMB: msg.data.heapUsedMB ?? Math.round((msg.data.heapUsed ?? 0) / 1024 / 1024),
            rssMB: msg.data.rssMB ?? Math.round((msg.data.rss ?? 0) / 1024 / 1024),
          });
        }
        if (msg.type === 'metadata' && Array.isArray(msg.data)) {
          setSessionMetadata(msg.data);
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    // Request live telemetry without touching PTY stdin.
    ws.send(JSON.stringify({ type: 'stats' }));
    ws.send(JSON.stringify({ type: 'metadata' }));
    const statsInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stats' }));
    }, 15000);
    const metadataInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'metadata' }));
    }, 5000);
    return () => {
      ws.removeEventListener('message', handler);
      clearInterval(statsInterval);
      clearInterval(metadataInterval);
    };
  }, [ws, wsConnected, setSessionMetadata]);

  // --- Voice transcript → active terminal ---
  const handleVoiceTranscript = useCallback((text: string) => {
    const state = useWorkspaceStore.getState();
    const leaf = activeLeafId && state.splitTree ? findLeafById(state.splitTree, activeLeafId) : null;
    const tab = leaf?.tabId
      ? state.tabs.find(t => t.id === leaf.tabId)
      : state.tabs.find(t => t.id === state.activeTabId);
    if (!tab?.sessionId || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'input', sessionId: tab.sessionId, data: text }));
  }, [ws, activeLeafId]);

  // --- TabBar handlers (must be defined before keyboard shortcuts useEffect) ---

  const handleTabClick = useCallback((tabId: string) => {
    const tree = useWorkspaceStore.getState().splitTree;
    if (!tree) return;
    const leaf = findLeafByTabId(tree, tabId);
    if (leaf) {
      setActiveLeafId(leaf.id);
      setActiveTab(tabId);
      markNotificationsReadForTab(tabId);
      return;
    }
    // Tab not in a leaf — show it in the active leaf
    if (activeLeafId) {
      setSplitTree(updateNodeInTree(tree, activeLeafId, (n) => ({ ...n, tabId })));
    }
    setActiveTab(tabId);
    markNotificationsReadForTab(tabId);
  }, [activeLeafId, setActiveTab, setSplitTree, markNotificationsReadForTab]);

  const handleRunRecipe = useCallback((recipe: WorkspaceRecipe) => {
    const nextWorkspace = buildWorkspaceFromRecipe(recipe);
    addWorkspace(nextWorkspace);
    switchWorkspace(nextWorkspace.id);
    const first = nextWorkspace.splitTree ? findFirstLeaf(nextWorkspace.splitTree) : null;
    setActiveLeafId(first?.id || null);
  }, [addWorkspace, switchWorkspace]);

  // --- Global keyboard shortcuts ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      // Ctrl+B: toggle sidebar
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setSidebarOpen(!useWorkspaceStore.getState().sidebarOpen);
        return;
      }
      // Ctrl+PageDown: next tab
      if (e.ctrlKey && e.key === 'PageDown') {
        e.preventDefault();
        const state = useWorkspaceStore.getState();
        const idx = state.tabs.findIndex(t => t.id === state.activeTabId);
        if (idx >= 0 && state.tabs.length > 1) {
          const next = state.tabs[(idx + 1) % state.tabs.length];
          handleTabClick(next.id);
        }
        return;
      }
      // Ctrl+PageUp: prev tab
      if (e.ctrlKey && e.key === 'PageUp') {
        e.preventDefault();
        const state = useWorkspaceStore.getState();
        const idx = state.tabs.findIndex(t => t.id === state.activeTabId);
        if (idx >= 0 && state.tabs.length > 1) {
          const prev = state.tabs[(idx - 1 + state.tabs.length) % state.tabs.length];
          handleTabClick(prev.id);
        }
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSidebarOpen, handleTabClick]);

  // --- Initialize split tree (migration from tab-only layout) ---
  useEffect(() => {
    if (splitTree || tabs.length === 0 || !authenticated) return;
    const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
    if (!activeTab) return;
    const leafId = crypto.randomUUID();
    setSplitTree({ id: leafId, type: 'leaf', tabId: activeTab.id });
    queueMicrotask(() => setActiveLeafId(leafId));
  }, [splitTree, tabs, activeTabId, authenticated, setSplitTree]);

  // --- Initialize activeLeafId from existing tree ---
  useEffect(() => {
    if (!splitTree) {
      if (activeLeafId) queueMicrotask(() => setActiveLeafId(null));
      return;
    }
    if (activeLeafId && findLeafById(splitTree, activeLeafId)) return;
    const first = findFirstLeaf(splitTree);
    if (first) queueMicrotask(() => setActiveLeafId(first.id));
  }, [activeLeafId, splitTree]);

  // --- Core handlers ---

  const handleSessionCreated = useCallback(
    (tabId: string, sessionId: string) => updateTab(tabId, { sessionId }),
    [updateTab]
  );

  const handleSaveFile = useCallback(async (tabId: string) => {
    const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === tabId);
    const file = editorFiles[tabId];
    if (!tab?.filePath || !file) return;
    await fetch('/api/files/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tab.filePath, content: file.content }),
    });
    setEditorFiles((prev) => ({ ...prev, [tabId]: { ...prev[tabId], dirty: false } }));
  }, [editorFiles]);

  // Open file: show in active leaf
  const handleOpenFile = useCallback(async (filePath: string) => {
    const state = useWorkspaceStore.getState();
    const existing = state.tabs.find((t) => t.filePath === filePath);
    if (existing) {
      const leaf = findLeafByTabId(state.splitTree, existing.id);
      if (leaf) {
        setActiveLeafId(leaf.id);
      } else if (state.splitTree && activeLeafId) {
        setSplitTree(updateNodeInTree(state.splitTree, activeLeafId, (n) => ({ ...n, tabId: existing.id })));
      }
      setActiveTab(existing.id);
      return;
    }
    try {
      const res = await fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      const tabId = crypto.randomUUID();
      const name = filePath.split('/').pop() || 'file';
      setEditorFiles((prev) => ({ ...prev, [tabId]: { content: data.content, dirty: false } }));
      addTab({ id: tabId, type: 'editor', name, color: '#74c0fc', filePath });
      const tree = useWorkspaceStore.getState().splitTree;
      if (tree && activeLeafId) {
        setSplitTree(updateNodeInTree(tree, activeLeafId, (n) => ({ ...n, tabId })));
      }
    } catch { /* ignore */ }
  }, [addTab, activeLeafId, setActiveTab, setSplitTree]);

  // --- TabBar handlers ---

  const handleCloseTab = useCallback((tabId: string) => {
    const state = useWorkspaceStore.getState();
    const tab = state.tabs.find((t) => t.id === tabId);
    if (tab?.sessionId && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'kill', sessionId: tab.sessionId }));
    }
    const tree = state.splitTree;
    if (tree) {
      const leaf = findLeafByTabId(tree, tabId);
      if (leaf) {
        const newTree = removeLeafFromTree(tree, leaf.id);
        if (newTree) {
          setSplitTree(newTree);
          if (activeLeafId === leaf.id) {
            const first = findFirstLeaf(newTree);
            if (first) setActiveLeafId(first.id);
          }
        } else {
          setSplitTree(null);
          setActiveLeafId(null);
        }
      }
    }
    removeTab(tabId);
  }, [ws, removeTab, activeLeafId, setSplitTree]);

  const handleNewTerminal = useCallback(() => {
    const tabId = crypto.randomUUID();
    const name = `Terminal ${tabs.filter((t) => t.type === 'terminal').length + 1}`;
    addTab({ id: tabId, type: 'terminal', name, color: '#40E0D0' });
    const tree = useWorkspaceStore.getState().splitTree;
    if (!tree) {
      const leafId = crypto.randomUUID();
      setSplitTree({ id: leafId, type: 'leaf', tabId });
      setActiveLeafId(leafId);
      return;
    }
    const targetId = activeLeafId || findFirstLeaf(tree)?.id;
    if (!targetId) return;
    const newLeafId = crypto.randomUUID();
    setSplitTree(updateNodeInTree(tree, targetId, (node) => ({
      id: crypto.randomUUID(),
      type: 'split' as const,
      direction: 'horizontal' as const,
      children: [{ ...node }, { id: newLeafId, type: 'leaf' as const, tabId }],
      sizes: [50, 50],
    })));
    setActiveLeafId(newLeafId);
  }, [tabs, addTab, activeLeafId, setSplitTree]);

  const handleNewFiles = useCallback(() => {
    const existing = tabs.find((t) => t.type === 'files');
    if (existing) { handleTabClick(existing.id); return; }
    const tabId = crypto.randomUUID();
    addTab({ id: tabId, type: 'files', name: 'Files', color: '#69db7c' });
    const tree = useWorkspaceStore.getState().splitTree;
    if (tree && activeLeafId) {
      setSplitTree(updateNodeInTree(tree, activeLeafId, (n) => ({ ...n, tabId })));
    }
  }, [tabs, addTab, activeLeafId, setSplitTree, handleTabClick]);

  const handleNewBrowser = useCallback((url = 'http://127.0.0.1:8790') => {
    const tabId = crypto.randomUUID();
    addTab({ id: tabId, type: 'browser', name: 'Browser', color: '#f59f00', url });
    const tree = useWorkspaceStore.getState().splitTree;
    if (!tree) {
      const leafId = crypto.randomUUID();
      setSplitTree({ id: leafId, type: 'leaf', tabId });
      setActiveLeafId(leafId);
      return;
    }
    const targetId = activeLeafId || findFirstLeaf(tree)?.id;
    if (!targetId) return;
    const newLeafId = crypto.randomUUID();
    setSplitTree(updateNodeInTree(tree, targetId, (node) => ({
      id: crypto.randomUUID(),
      type: 'split' as const,
      direction: 'horizontal' as const,
      children: [{ ...node }, { id: newLeafId, type: 'leaf' as const, tabId }],
      sizes: [55, 45],
    })));
    setActiveLeafId(newLeafId);
  }, [addTab, activeLeafId, setSplitTree]);

  // --- SplitContainer handlers ---

  const handleSplitNewLeaf = useCallback((leafId: string) => {
    const tabId = crypto.randomUUID();
    const name = `Terminal ${tabs.filter((t) => t.type === 'terminal').length + 1}`;
    addTab({ id: tabId, type: 'terminal', name, color: '#40E0D0' });
    const tree = useWorkspaceStore.getState().splitTree;
    if (tree) {
      setSplitTree(updateNodeInTree(tree, leafId, (n) => ({ ...n, tabId })));
    }
  }, [tabs, addTab, setSplitTree]);

  const handleSplitCloseLeaf = useCallback((leafId: string, nextTree: SplitNode | null) => {
    const tree = useWorkspaceStore.getState().splitTree;
    if (!tree) return;
    const leaf = findLeafById(tree, leafId);
    if (leaf?.tabId) {
      const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === leaf.tabId);
      if (tab?.sessionId && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'kill', sessionId: tab.sessionId }));
      }
      removeTab(leaf.tabId);
    }
    if (!nextTree) {
      setSplitTree(null);
      setActiveLeafId(null);
    }
  }, [ws, removeTab, setSplitTree]);

  // --- Render leaf content ---

  const renderLeaf = useCallback((node: SplitNode, isActive: boolean) => {
    const tab = tabs.find((t) => t.id === node.tabId);
    if (!tab) {
      return (
        <div className="h-full flex items-center justify-center" style={{ background: 'var(--terminal-bg)' }}>
          <p className="font-mono text-sm" style={{ color: 'var(--muted)' }}>Empty pane</p>
        </div>
      );
    }
    if (tab.type === 'terminal') {
      return (
        <DropZone sessionId={tab.sessionId || null} ws={ws}>
          <TerminalPanel
            key={tab.id}
            sessionId={tab.sessionId || null}
            ws={ws}
            isActive={isActive}
            onSessionCreated={(sid) => handleSessionCreated(tab.id, sid)}
            onNotification={(notification) => addNotification({
              ...notification,
              tabId: tab.id,
              sessionId: tab.sessionId || undefined,
              workspaceId: activeWorkspaceId,
            })}
            cwd={tab.cwd}
            initCommand={tab.initCommand}
          />
        </DropZone>
      );
    }
    if (tab.type === 'editor') {
      return (
        <ErrorBoundary fallbackLabel="Editor">
          {editorFiles[tab.id] ? (
            <MonacoEditorPanel
              key={tab.id}
              filePath={tab.filePath || ''}
              value={editorFiles[tab.id].content}
              onChange={(v) => setEditorFiles((prev) => ({ ...prev, [tab.id]: { content: v, dirty: true } }))}
              onSave={() => handleSaveFile(tab.id)}
              onOpenFile={handleOpenFile}
            />
          ) : (
            <div className="h-full flex items-center justify-center" style={{ background: 'var(--terminal-bg)' }}>
              <div className="font-mono text-sm animate-pulse" style={{ color: 'var(--accent)' }}>
                Loading {tab.filePath?.split('/').pop() || 'file'}...
              </div>
            </div>
          )}
        </ErrorBoundary>
      );
    }
    if (tab.type === 'files') {
      return (
        <ErrorBoundary fallbackLabel="File Manager">
          <FileManager onOpenFile={handleOpenFile} />
        </ErrorBoundary>
      );
    }
    if (tab.type === 'browser') {
      return (
        <ErrorBoundary fallbackLabel="Browser">
          <BrowserPanel
            key={tab.id}
            url={tab.url}
            browserSessionId={tab.browserSessionId}
            isActive={isActive}
            onBrowserChange={(changes) => updateTab(tab.id, {
              ...changes,
              name: changes.url ? browserTabName(changes.url) : tab.name,
            })}
          />
        </ErrorBoundary>
      );
    }
    return null;
  }, [tabs, ws, editorFiles, handleSessionCreated, handleSaveFile, handleOpenFile, addNotification, activeWorkspaceId, updateTab]);

  // --- Render ---

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--background)' }}>
        <div className="font-mono animate-pulse" style={{ color: 'var(--accent)' }}>Loading...</div>
      </div>
    );
  }

  if (!authenticated) return <LoginPage onServerSynced={() => setServerSynced(true)} />;

  const activeLeaf = activeLeafId && splitTree ? findLeafById(splitTree, activeLeafId) : null;
  const activeTab = activeLeaf?.tabId
    ? tabs.find((t) => t.id === activeLeaf.tabId)
    : tabs.find((t) => t.id === activeTabId);
  const leafCount = splitTree ? countLeaves(splitTree) : 0;
  const latestUnread = notifications.filter((n) => !n.read).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  const activeMetadata = activeTab?.sessionId ? sessionMetadata[activeTab.sessionId] : undefined;

  function handleJumpLatestUnread() {
    if (!latestUnread) return;
    if (latestUnread.workspaceId && latestUnread.workspaceId !== activeWorkspaceId) {
      switchWorkspace(latestUnread.workspaceId);
      setActiveTab(latestUnread.tabId);
      setTimeout(() => {
        const tree = useWorkspaceStore.getState().splitTree;
        const leaf = findLeafByTabId(tree, latestUnread.tabId);
        if (leaf) setActiveLeafId(leaf.id);
        markNotificationsReadForTab(latestUnread.tabId);
      }, 0);
      return;
    }
    handleTabClick(latestUnread.tabId);
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: 'var(--background)', color: 'var(--foreground)' }}>
      <Onboarding />
      <CommandPalette
        open={paletteOpen}
        recipes={recipes}
        onClose={() => setPaletteOpen(false)}
        onRunRecipe={handleRunRecipe}
        onNewTerminal={handleNewTerminal}
        onNewBrowser={handleNewBrowser}
        onToggleSidebar={() => setSidebarOpen(!useWorkspaceStore.getState().sidebarOpen)}
        onOpenThemeGallery={() => setThemeGalleryOpen(true)}
      />
      <ThemeGallery
        open={themeGalleryOpen}
        circadian={circadian}
        onClose={() => setThemeGalleryOpen(false)}
      />

      {/* Tab bar */}
      <TabBar
        onTabClick={handleTabClick}
        onCloseTab={handleCloseTab}
        onNewTerminal={handleNewTerminal}
        onNewFiles={handleNewFiles}
        onNewBrowser={handleNewBrowser}
        activeLeafTabId={activeLeaf?.tabId || null}
      />

      {/* Main area: sidebar + content */}
      <div className="relative flex-1 flex overflow-hidden">
      {/* Sidebar */}
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Hide workspaces"
          className="fixed left-0 right-0 top-9 bottom-6 z-30 bg-black/35 sm:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      {sidebarOpen && <Sidebar />}

      {/* Content — SplitContainer */}
      <div className="flex-1 overflow-hidden">
        {splitTree ? (
          <SplitContainer
            tree={splitTree}
            activeLeafId={activeLeafId || ''}
            onTreeChange={setSplitTree}
            onActiveChange={setActiveLeafId}
            onNewLeaf={handleSplitNewLeaf}
            onCloseLeaf={handleSplitCloseLeaf}
            renderLeaf={renderLeaf}
          />
        ) : tabs.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-4" style={{ color: 'var(--accent)' }}>⬡</div>
              <p className="font-mono" style={{ color: 'var(--muted)' }}>No tabs open</p>
              <p className="font-mono text-sm mt-1" style={{ color: 'var(--muted)' }}>Click + to create a terminal</p>
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center" style={{ background: 'var(--terminal-bg)' }}>
            <div className="font-mono animate-pulse" style={{ color: 'var(--accent)' }}>Initializing...</div>
          </div>
        )}
      </div>
      </div>

      {/* Status bar */}
      <div className="h-6 border-t flex items-center overflow-x-auto px-2 gap-3 whitespace-nowrap text-xs font-mono sm:px-3 sm:gap-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--muted)' }}>
        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="cursor-pointer"
          style={{ color: sidebarOpen ? 'var(--accent)' : undefined }}
          title={sidebarOpen ? 'Hide workspaces' : 'Show workspaces'}
        >
          &#9776;
        </button>
        <span className="flex items-center gap-1">
          <div className={`w-1.5 h-1.5 rounded-full ${wsConnected ? 'bg-green-400' : 'bg-red-400'}`} />
          {wsConnected ? 'Connected' : 'Disconnected'}
        </span>
        <button
          onClick={() => setPaletteOpen(true)}
          className="cursor-pointer"
          style={{ color: 'var(--accent)' }}
          title="Command palette (Ctrl+K)"
        >
          Ctrl+K
        </button>
        <span>{tabs.length} tab{tabs.length !== 1 ? 's' : ''}</span>
        {leafCount > 1 && <span style={{ color: 'var(--accent)' }}>{leafCount} panes</span>}
        {latestUnread && (
          <button
            onClick={handleJumpLatestUnread}
            className="min-w-0 max-w-[220px] truncate cursor-pointer"
            style={{ color: 'var(--accent)' }}
            title={`${latestUnread.title}${latestUnread.body ? `: ${latestUnread.body}` : ''}`}
          >
            ! {latestUnread.title}
          </button>
        )}
        {workspaces.length > 1 && (
          <span>
            {workspaces.find(w => w.id === activeWorkspaceId)?.name || 'Main'}
          </span>
        )}
        {activeTab?.type === 'editor' && editorFiles[activeTab.id]?.dirty && (
          <span style={{ color: 'var(--accent)' }}>modified</span>
        )}
        {activeMetadata && (
          <span
            className="max-w-[240px] truncate"
            title={metadataSecondary(activeMetadata) || activeMetadata.cwd}
          >
            {metadataPrimary(activeMetadata)}
          </span>
        )}
        {serverStats && (
          <span title={`PTY: ${serverStats.sessions} sessions, Heap: ${serverStats.heapMB}MB, RSS: ${serverStats.rssMB}MB`}>
            PTY:{serverStats.sessions} RAM:{serverStats.rssMB}MB
          </span>
        )}
        <button
          onClick={(event) => {
            if (event.shiftKey) {
              setThemeGalleryOpen(true);
              return;
            }
            const idx = THEME_MODES.indexOf(circadian.mode);
            circadian.setMode(THEME_MODES[(idx + 1) % THEME_MODES.length]);
          }}
          className="cursor-pointer"
          style={{ color: 'var(--accent)' }}
          title={`Theme: ${circadian.activePalette?.name || circadian.mode}, phase: ${circadian.phase}, ${circadian.colorTemp}K. Click to cycle mode, Shift-click for gallery.`}
        >
          {circadian.activePalette?.name || THEME_LABELS[circadian.mode]} {circadian.colorTemp}K
        </button>
        <button
          onClick={() => setThemeGalleryOpen(true)}
          className="cursor-pointer"
          style={{ color: 'var(--muted-strong)' }}
          title="Open theme gallery"
        >
          themes
        </button>
        <button
          onClick={() => circadian.resetToAuto()}
          style={{ color: circadian.mode === 'auto' && circadian.paletteId === 'circadian' ? 'var(--accent)' : undefined }}
          title="Auto circadian theme"
        >
          auto
        </button>
        <span className="border-l pl-3 ml-1" style={{ borderColor: 'var(--border)' }} />
        <VoiceInput onTranscript={handleVoiceTranscript} />
        <span className="ml-auto hidden sm:inline">{APP_LABEL}</span>
      </div>
    </div>
  );
}
