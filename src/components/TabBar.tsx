'use client';

import { useState, useRef, KeyboardEvent } from 'react';
import { useWorkspaceStore, Tab } from '@/stores/workspace-store';

export default function TabBar() {
  const { tabs, activeTabId, setActiveTab, removeTab, updateTab, addTab, ws } =
    useWorkspaceStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function handleNewTab() {
    const id = crypto.randomUUID();
    addTab({
      id,
      type: 'terminal',
      name: `Terminal ${tabs.length + 1}`,
      color: '#40E0D0',
    });
  }

  function handleDoubleClick(tab: Tab) {
    setEditingId(tab.id);
    setEditValue(tab.name);
    setTimeout(() => inputRef.current?.select(), 50);
  }

  function handleEditDone(id: string) {
    if (editValue.trim()) {
      updateTab(id, { name: editValue.trim() });
      if (ws && ws.readyState === WebSocket.OPEN) {
        const tab = tabs.find((t) => t.id === id);
        if (tab?.sessionId) {
          ws.send(JSON.stringify({ type: 'update', sessionId: tab.sessionId, name: editValue.trim() }));
        }
      }
    }
    setEditingId(null);
  }

  function handleEditKeyDown(e: KeyboardEvent, id: string) {
    if (e.key === 'Enter') handleEditDone(id);
    if (e.key === 'Escape') setEditingId(null);
  }

  function handleClose(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    const tab = tabs.find((t) => t.id === id);
    if (tab?.sessionId && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'kill', sessionId: tab.sessionId }));
    }
    removeTab(id);
  }

  return (
    <div className="flex items-center h-9 bg-[#0d1117] border-b border-[#1a1e24] overflow-x-auto scrollbar-none">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          onDoubleClick={() => handleDoubleClick(tab)}
          className={`group flex items-center gap-1.5 px-3 h-full cursor-pointer border-r border-[#1a1e24]
                      transition-colors min-w-[120px] max-w-[200px] shrink-0
                      ${
                        activeTabId === tab.id
                          ? 'bg-[#0a0e14] text-white'
                          : 'bg-[#0d1117] text-gray-500 hover:text-gray-300 hover:bg-[#0a0e14]/50'
                      }`}
        >
          {/* Color dot */}
          <div
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: tab.color }}
          />

          {/* Tab name */}
          {editingId === tab.id ? (
            <input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={() => handleEditDone(tab.id)}
              onKeyDown={(e) => handleEditKeyDown(e, tab.id)}
              className="bg-transparent border-b border-[#40E0D0] text-white text-xs font-mono
                         outline-none w-full min-w-0"
              autoFocus
            />
          ) : (
            <span className="text-xs font-mono truncate">{tab.name}</span>
          )}

          {/* Close button */}
          <button
            onClick={(e) => handleClose(e, tab.id)}
            className="ml-auto shrink-0 w-4 h-4 flex items-center justify-center rounded
                       text-gray-600 hover:text-red-400 hover:bg-red-400/10
                       opacity-0 group-hover:opacity-100 transition-opacity"
          >
            ×
          </button>

          {/* Active indicator */}
          {activeTabId === tab.id && (
            <div
              className="absolute bottom-0 left-0 right-0 h-0.5"
              style={{ backgroundColor: tab.color }}
            />
          )}
        </div>
      ))}

      {/* New tab button */}
      <button
        onClick={handleNewTab}
        className="flex items-center justify-center w-8 h-full shrink-0
                   text-gray-600 hover:text-[#40E0D0] hover:bg-[#40E0D0]/10
                   transition-colors font-mono"
      >
        +
      </button>
    </div>
  );
}
