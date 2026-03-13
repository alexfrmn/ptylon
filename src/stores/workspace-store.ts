import { create } from 'zustand';

export type TabType = 'terminal' | 'editor' | 'files';

export interface Tab {
  id: string;
  type: TabType;
  sessionId?: string; // PTY session ID for terminal tabs
  name: string;
  color: string;
  filePath?: string; // for editor tabs
}

interface WorkspaceState {
  // Auth
  authenticated: boolean;
  wsToken: string | null;
  setAuth: (authenticated: boolean, wsToken?: string) => void;

  // Tabs
  tabs: Tab[];
  activeTabId: string | null;
  addTab: (tab: Tab) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, updates: Partial<Tab>) => void;

  // WebSocket
  ws: WebSocket | null;
  wsConnected: boolean;
  setWs: (ws: WebSocket | null) => void;
  setWsConnected: (connected: boolean) => void;

  // Theme
  theme: 'light' | 'dark' | 'auto';
  setTheme: (theme: 'light' | 'dark' | 'auto') => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  // Auth
  authenticated: false,
  wsToken: null,
  setAuth: (authenticated, wsToken) => set({ authenticated, wsToken: wsToken || null }),

  // Tabs
  tabs: [],
  activeTabId: null,
  addTab: (tab) =>
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
    })),
  removeTab: (id) =>
    set((state) => {
      const newTabs = state.tabs.filter((t) => t.id !== id);
      const newActive =
        state.activeTabId === id
          ? newTabs.length > 0
            ? newTabs[newTabs.length - 1].id
            : null
          : state.activeTabId;
      return { tabs: newTabs, activeTabId: newActive };
    }),
  setActiveTab: (id) => set({ activeTabId: id }),
  updateTab: (id, updates) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),

  // WebSocket
  ws: null,
  wsConnected: false,
  setWs: (ws) => set({ ws }),
  setWsConnected: (connected) => set({ wsConnected: connected }),

  // Theme
  theme: 'dark',
  setTheme: (theme) => set({ theme }),
}));
