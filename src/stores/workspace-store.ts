import { create } from 'zustand';
import type { SplitNode } from '@/components/SplitContainer';

export type TabType = 'terminal' | 'editor' | 'files' | 'browser';

export interface Tab {
  id: string;
  type: TabType;
  sessionId?: string;
  browserSessionId?: string;
  name: string;
  color: string;
  filePath?: string;
  url?: string;
  cwd?: string;
  initCommand?: string; // auto-run on PTY creation (templates)
}

export interface Workspace {
  id: string;
  name: string;
  color: string;
  tabs: Tab[];
  splitTree: SplitNode | null;
  activeTabId: string | null;
}

export interface WorkspaceNotification {
  id: string;
  tabId: string;
  sessionId?: string;
  workspaceId?: string | null;
  title: string;
  subtitle?: string;
  body?: string;
  protocol: 'osc777' | 'osc99' | 'osc9';
  createdAt: number;
  read: boolean;
}

export interface SessionMetadata {
  id: string;
  sessionId: string;
  pid?: number;
  activePid?: number;
  activeCommand?: string;
  activeArgs?: string;
  cwd?: string;
  git?: {
    root?: string;
    branch?: string;
    dirty?: boolean;
  } | null;
  updatedAt: number;
}

export interface ThemeSettings {
  mode?: 'auto' | 'day' | 'evening' | 'night' | 'system';
  paletteId?: string;
  customPalettes?: unknown[];
  updatedAt?: number;
}

// Persisted workspace state (survives browser close)
interface PersistedState {
  tabs: Tab[];
  activeTabId: string | null;
  splitTree: SplitNode | null;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  sidebarOpen: boolean;
  notifications?: WorkspaceNotification[];
  themeSettings?: ThemeSettings;
  _version?: number;
  _savedAt?: number;
}

const STORAGE_KEY = 'web-console-workspace';
const STORAGE_VERSION = 2; // Bump when schema changes to force migration

function loadPersistedState(): Partial<PersistedState> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    // Version check: if old format, clear and start fresh
    if (!data._version || data._version < STORAGE_VERSION) {
      // Preserve tabs if they exist (migrate forward), but clear everything else
      const safeTabs = Array.isArray(data.tabs) ? data.tabs.filter(
        (t: Record<string, unknown>) => t && typeof t.id === 'string' && typeof t.type === 'string'
      ) : [];
      return { tabs: safeTabs };
    }
    return data;
  } catch {
    // Corrupted data — clear it
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    return {};
  }
}

function savePersistedState(state: PersistedState) {
  if (typeof window === 'undefined') return;
  const payload = { ...state, _version: STORAGE_VERSION, _savedAt: Date.now() };
  if (!payload.themeSettings) {
    try {
      const current = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<PersistedState>;
      if (current.themeSettings) payload.themeSettings = current.themeSettings;
    } catch { /* ignore */ }
  }
  // Save to localStorage (instant cache)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch { /* quota exceeded */ }
  // Save to server (cross-device persistence)
  saveToServer(payload);
}

function stateWeight(state: Partial<PersistedState>) {
  const workspaces = Array.isArray(state.workspaces) ? state.workspaces : [];
  const activeTabs = Array.isArray(state.tabs) ? state.tabs : [];
  const workspaceTabs = workspaces.reduce((sum, ws) => sum + (Array.isArray(ws.tabs) ? ws.tabs.length : 0), 0);
  return {
    workspaces: workspaces.length,
    tabs: Math.max(activeTabs.length, workspaceTabs),
  };
}

function shouldUseServerState(serverState: Partial<PersistedState>, localState: Partial<PersistedState>) {
  const localHasState = Array.isArray(localState.tabs) || Array.isArray(localState.workspaces);
  if (!localHasState) return true;

  const serverWeight = stateWeight(serverState);
  const localWeight = stateWeight(localState);
  if (localWeight.workspaces > serverWeight.workspaces) return false;
  if (localWeight.workspaces === serverWeight.workspaces && localWeight.tabs > serverWeight.tabs) return false;
  if (serverWeight.workspaces > localWeight.workspaces) return true;
  if (serverWeight.workspaces === localWeight.workspaces && serverWeight.tabs > localWeight.tabs) return true;

  const serverSavedAt = typeof serverState._savedAt === 'number' ? serverState._savedAt : 0;
  const localSavedAt = typeof localState._savedAt === 'number' ? localState._savedAt : 0;
  if (serverSavedAt || localSavedAt) return serverSavedAt >= localSavedAt;

  // Backward-compatible migration path for states saved before _savedAt existed:
  // keep the richer local browser layout instead of replacing it with an older
  // server snapshot during F5/reconnect.
  return true;
}

let serverSaveTimer: ReturnType<typeof setTimeout>;
function saveToServer(payload: Record<string, unknown>) {
  clearTimeout(serverSaveTimer);
  serverSaveTimer = setTimeout(() => {
    fetch('/api/workspace', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => { /* offline — localStorage still has it */ });
  }, 2000); // 2s debounce for server (localStorage is 500ms)
}

function dispatchWorkspaceSync(state: Partial<PersistedState>) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('web-console-workspace-sync', { detail: { state } }));
}

// Load from server — called after auth, merges with localStorage
export async function loadFromServer(): Promise<Partial<PersistedState> | null> {
  try {
    const res = await fetch('/api/workspace');
    if (!res.ok) return null;
    const { state } = await res.json();
    if (!state) return null;
    // Server state is newer if it has _version
    if (state._version && state._version >= STORAGE_VERSION) {
      const localState = loadPersistedState();
      if (!shouldUseServerState(state as Partial<PersistedState>, localState)) {
        savePersistedState(localState as PersistedState);
        return localState;
      }
      // Save to localStorage as cache
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch { /* ignore */ }
      return state as Partial<PersistedState>;
    }
    return null;
  } catch {
    return null; // Offline or error — use localStorage
  }
}

interface WorkspaceState {
  // Auth
  authenticated: boolean;
  wsToken: string | null;
  setAuth: (authenticated: boolean, wsToken?: string) => void;

  // Tabs (active workspace)
  tabs: Tab[];
  activeTabId: string | null;
  addTab: (tab: Tab) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, updates: Partial<Tab>) => void;

  // Split tree (active workspace)
  splitTree: SplitNode | null;
  setSplitTree: (tree: SplitNode | null) => void;

  // Workspaces
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  addWorkspace: (ws: Workspace) => void;
  removeWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  duplicateWorkspace: (id: string) => void;
  switchWorkspace: (id: string) => void;
  clearMissingTerminalSessions: (serverSessionIds: Set<string>) => void;

  // Attention notifications
  notifications: WorkspaceNotification[];
  addNotification: (notification: Omit<WorkspaceNotification, 'id' | 'createdAt' | 'read'> & { read?: boolean }) => void;
  markNotificationsReadForTab: (tabId: string) => void;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;

  // Live session metadata
  sessionMetadata: Record<string, SessionMetadata>;
  setSessionMetadata: (items: SessionMetadata[]) => void;

  // Server sync
  syncFromServer: () => Promise<void>;

  // WebSocket
  ws: WebSocket | null;
  wsConnected: boolean;
  setWs: (ws: WebSocket | null) => void;
  setWsConnected: (connected: boolean) => void;

  // Theme
  theme: 'light' | 'dark' | 'auto';
  setTheme: (theme: 'light' | 'dark' | 'auto') => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  let persisted: Partial<PersistedState> = {};
  try {
    persisted = loadPersistedState();
  } catch {
    // Total fallback — empty state
    persisted = {};
  }

  // Migration: ensure at least one workspace exists
  let workspaces = Array.isArray(persisted.workspaces) ? persisted.workspaces : [];
  let activeWorkspaceId = persisted.activeWorkspaceId || null;
  const initialTabs = Array.isArray(persisted.tabs) ? persisted.tabs : [];
  const initialSplitTree = persisted.splitTree || null;
  const initialActiveTabId = persisted.activeTabId || null;
  const initialNotifications = Array.isArray(persisted.notifications) ? persisted.notifications.slice(-100) : [];

  if (workspaces.length === 0 && initialTabs.length > 0) {
    // Migrate: create Main workspace from existing tabs
    const mainId = typeof window !== 'undefined' ? crypto.randomUUID() : 'main';
    workspaces = [{
      id: mainId,
      name: 'Main',
      color: '#40E0D0',
      tabs: initialTabs,
      splitTree: initialSplitTree,
      activeTabId: initialActiveTabId,
    }];
    activeWorkspaceId = mainId;
  }

  // Debounced save — always reads latest state
  function triggerSave() {
    const s = get();
    // Auto-save current state to active workspace
    const updatedWorkspaces = s.workspaces.map(ws =>
      ws.id === s.activeWorkspaceId
        ? { ...ws, tabs: s.tabs, splitTree: s.splitTree, activeTabId: s.activeTabId }
        : ws
    );
    savePersistedState({
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      splitTree: s.splitTree,
      workspaces: updatedWorkspaces,
      activeWorkspaceId: s.activeWorkspaceId,
      sidebarOpen: s.sidebarOpen,
      notifications: s.notifications.slice(-100),
    });
  }

  return {
    // Auth
    authenticated: false,
    wsToken: null,
    setAuth: (authenticated, wsToken) => set({ authenticated, wsToken: wsToken || null }),

    // Tabs (restore from localStorage)
    tabs: initialTabs,
    activeTabId: initialActiveTabId,
    addTab: (tab) => {
      set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
      triggerSave();
    },
    removeTab: (id) => {
      set((state) => {
        const newTabs = state.tabs.filter((t) => t.id !== id);
        const newActive = state.activeTabId === id
          ? newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null
          : state.activeTabId;
        const tab = state.tabs.find((t) => t.id === id);
        const sessionMetadata = { ...state.sessionMetadata };
        if (tab?.sessionId) delete sessionMetadata[tab.sessionId];
        return {
          tabs: newTabs,
          activeTabId: newActive,
          notifications: state.notifications.filter((n) => n.tabId !== id),
          sessionMetadata,
        };
      });
      triggerSave();
    },
    setActiveTab: (id) => {
      set({ activeTabId: id });
      triggerSave();
    },
    updateTab: (id, updates) => {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t)),
        workspaces: state.workspaces.map((ws) => ({
          ...ws,
          tabs: ws.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t)),
        })),
      }));
      triggerSave();
    },

    // Split tree
    splitTree: initialSplitTree,
    setSplitTree: (tree) => {
      set({ splitTree: tree });
      triggerSave();
    },

    // Workspaces
    workspaces,
    activeWorkspaceId,
    sidebarOpen: persisted.sidebarOpen ?? false,
    setSidebarOpen: (open) => {
      set({ sidebarOpen: open });
      // Auto-create Main workspace if none exist
      const s = get();
      if (open && s.workspaces.length === 0 && s.tabs.length > 0) {
        const mainId = crypto.randomUUID();
        set({
          workspaces: [{
            id: mainId, name: 'Main', color: '#40E0D0',
            tabs: s.tabs, splitTree: s.splitTree, activeTabId: s.activeTabId,
          }],
          activeWorkspaceId: mainId,
        });
      }
      triggerSave();
    },

    addWorkspace: (ws) => {
      set((state) => ({ workspaces: [...state.workspaces, ws] }));
      triggerSave();
    },

    removeWorkspace: (id) => {
      const s = get();
      if (s.workspaces.length <= 1) return; // can't delete last workspace
      set((state) => {
        const newWorkspaces = state.workspaces.filter(ws => ws.id !== id);
        // If deleting active, switch to first remaining
        if (state.activeWorkspaceId === id && newWorkspaces.length > 0) {
          const target = newWorkspaces[0];
          return {
            workspaces: newWorkspaces,
            activeWorkspaceId: target.id,
            tabs: target.tabs,
            splitTree: target.splitTree,
            activeTabId: target.activeTabId,
          };
        }
        return { workspaces: newWorkspaces };
      });
      triggerSave();
    },

    renameWorkspace: (id, name) => {
      set((state) => ({
        workspaces: state.workspaces.map(ws => ws.id === id ? { ...ws, name } : ws),
      }));
      triggerSave();
    },

    duplicateWorkspace: (id) => {
      const s = get();
      const source = s.workspaces.find(ws => ws.id === id);
      if (!source) return;
      const newWs: Workspace = {
        id: crypto.randomUUID(),
        name: `${source.name} (copy)`,
        color: source.color,
        tabs: source.tabs.map(t => ({ ...t, id: crypto.randomUUID(), sessionId: undefined })),
        splitTree: null, // will be re-initialized on switch
        activeTabId: null,
      };
      set((state) => ({ workspaces: [...state.workspaces, newWs] }));
      triggerSave();
    },

    switchWorkspace: (targetId) => {
      const s = get();
      if (s.activeWorkspaceId === targetId) return;

      // Save current state to current workspace
      const savedWorkspaces = s.workspaces.map(ws =>
        ws.id === s.activeWorkspaceId
          ? { ...ws, tabs: s.tabs, splitTree: s.splitTree, activeTabId: s.activeTabId }
          : ws
      );

      // Load target workspace
      const target = savedWorkspaces.find(ws => ws.id === targetId);
      if (!target) return;

      set({
        workspaces: savedWorkspaces,
        activeWorkspaceId: targetId,
        tabs: target.tabs,
        splitTree: target.splitTree,
        activeTabId: target.activeTabId,
      });
      triggerSave();
    },

    clearMissingTerminalSessions: (serverSessionIds) => {
      const clearTab = (tab: Tab): Tab =>
        tab.type === 'terminal' && tab.sessionId && !serverSessionIds.has(tab.sessionId)
          ? { ...tab, sessionId: undefined }
          : tab;

      set((state) => ({
        tabs: state.tabs.map(clearTab),
        workspaces: state.workspaces.map((ws) => ({
          ...ws,
          tabs: ws.tabs.map(clearTab),
        })),
      }));
      triggerSave();
    },

    // Attention notifications
    notifications: initialNotifications,
    addNotification: (notification) => {
      set((state) => ({
        notifications: [
          ...state.notifications,
          {
            ...notification,
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            read: notification.read ?? false,
          },
        ].slice(-100),
      }));
      triggerSave();
    },
    markNotificationsReadForTab: (tabId) => {
      set((state) => ({
        notifications: state.notifications.map((n) => n.tabId === tabId ? { ...n, read: true } : n),
      }));
      triggerSave();
    },
    markNotificationRead: (id) => {
      set((state) => ({
        notifications: state.notifications.map((n) => n.id === id ? { ...n, read: true } : n),
      }));
      triggerSave();
    },
    markAllNotificationsRead: () => {
      set((state) => ({
        notifications: state.notifications.map((n) => ({ ...n, read: true })),
      }));
      triggerSave();
    },

    // Live session metadata
    sessionMetadata: {},
    setSessionMetadata: (items) => {
      set((state) => {
        const next = { ...state.sessionMetadata };
        for (const item of items) {
          if (item.sessionId) next[item.sessionId] = item;
        }
        return { sessionMetadata: next };
      });
    },

    // Server sync — load state from SQLite on login
    syncFromServer: async () => {
      const serverState = await loadFromServer();
      if (!serverState) return; // No server data or offline — keep localStorage state

      // Server has valid data — apply it
      let ws = Array.isArray(serverState.workspaces) ? serverState.workspaces : [];
      let awsId = serverState.activeWorkspaceId || null;
      const tabs = Array.isArray(serverState.tabs) ? serverState.tabs : [];
      const tree = serverState.splitTree || null;
      const tabId = serverState.activeTabId || null;
      const notifications = Array.isArray(serverState.notifications) ? serverState.notifications.slice(-100) : [];

      if (ws.length === 0 && tabs.length > 0) {
        const mainId = crypto.randomUUID();
        ws = [{ id: mainId, name: 'Main', color: '#40E0D0', tabs, splitTree: tree, activeTabId: tabId }];
        awsId = mainId;
      }

      set({
        tabs,
        activeTabId: tabId,
        splitTree: tree,
        workspaces: ws,
        activeWorkspaceId: awsId,
        sidebarOpen: serverState.sidebarOpen ?? false,
        notifications,
      });
      dispatchWorkspaceSync(serverState);
    },

    // WebSocket
    ws: null,
    wsConnected: false,
    setWs: (ws) => set({ ws }),
    setWsConnected: (connected) => set({ wsConnected: connected }),

    // Theme
    theme: 'dark',
    setTheme: (theme) => set({ theme }),
  };
});

export function saveThemeSettings(themeSettings: ThemeSettings) {
  const state = useWorkspaceStore.getState();
  savePersistedState({
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    splitTree: state.splitTree,
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
    sidebarOpen: state.sidebarOpen,
    notifications: state.notifications,
    themeSettings,
  });
}
