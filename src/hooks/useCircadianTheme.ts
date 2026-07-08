import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BUILT_IN_THEME_PALETTES,
  CIRCADIAN_PALETTE_ID,
  THEME_VARIABLE_NAMES,
  normalizeThemePalette,
  sanitizeThemeId,
  type ThemePalette,
} from '@/lib/theme-palettes';
import { saveThemeSettings, type ThemeSettings } from '@/stores/workspace-store';

export type CircadianPhase = 'dawn' | 'morning' | 'day' | 'evening' | 'night' | 'late';
export type CircadianMode = 'auto' | 'day' | 'evening' | 'night' | 'system';

export interface CircadianTheme {
  phase: CircadianPhase;
  mode: CircadianMode;
  colorTemp: number;
  isDark: boolean;
  paletteId: string;
  previewPaletteId: string | null;
  palettes: ThemePalette[];
  activePalette: ThemePalette | null;
  setMode: (mode: CircadianMode) => void;
  setOverride: (phase: CircadianPhase) => void;
  clearOverride: () => void;
  resetToAuto: () => void;
  setPalette: (paletteId: string) => void;
  previewPalette: (paletteId: string | null) => void;
  clearPreview: () => void;
  importPalette: (palette: unknown) => ThemePalette | null;
}

const PHASE_CONFIG: Record<CircadianPhase, { colorTemp: number; isDark: boolean }> = {
  dawn: { colorTemp: 5500, isDark: false },
  morning: { colorTemp: 6500, isDark: false },
  day: { colorTemp: 6500, isDark: false },
  evening: { colorTemp: 4000, isDark: false },
  night: { colorTemp: 3000, isDark: true },
  late: { colorTemp: 2700, isDark: true },
};

const MODE_STORAGE_KEY = 'circadian-theme-mode';
const LEGACY_OVERRIDE_KEY = 'circadian-theme-override';
const PALETTE_STORAGE_KEY = 'circadian-theme-palette';
const CUSTOM_PALETTES_STORAGE_KEY = 'circadian-theme-custom-palettes';

function getPhaseAtTime(date = new Date()): CircadianPhase {
  const hour = date.getHours();
  if (hour >= 6 && hour < 8) return 'dawn';
  if (hour >= 8 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'day';
  if (hour >= 17 && hour < 20) return 'evening';
  if (hour >= 20 && hour < 23) return 'night';
  return 'late';
}

function phaseForMode(mode: CircadianMode, autoPhase: CircadianPhase, systemIsDark: boolean): CircadianPhase {
  if (mode === 'auto') return autoPhase;
  if (mode === 'system') return systemIsDark ? 'night' : 'day';
  return mode;
}

function modeFromPhase(phase: CircadianPhase): CircadianMode {
  if (phase === 'evening') return 'evening';
  if (phase === 'night' || phase === 'late') return 'night';
  return 'day';
}

function readInitialMode(): CircadianMode {
  if (typeof window === 'undefined') return 'auto';
  const storedMode = localStorage.getItem(MODE_STORAGE_KEY);
  if (storedMode === 'auto' || storedMode === 'day' || storedMode === 'evening' || storedMode === 'night' || storedMode === 'system') {
    return storedMode;
  }
  const legacyPhase = localStorage.getItem(LEGACY_OVERRIDE_KEY);
  if (legacyPhase && legacyPhase in PHASE_CONFIG) {
    const migrated = modeFromPhase(legacyPhase as CircadianPhase);
    localStorage.setItem(MODE_STORAGE_KEY, migrated);
    localStorage.removeItem(LEGACY_OVERRIDE_KEY);
    return migrated;
  }
  return 'auto';
}

function getSystemIsDark() {
  if (typeof window === 'undefined') return true;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

function readInitialPaletteId() {
  if (typeof window === 'undefined') return CIRCADIAN_PALETTE_ID;
  return localStorage.getItem(PALETTE_STORAGE_KEY) || CIRCADIAN_PALETTE_ID;
}

function readCustomPalettes() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(CUSTOM_PALETTES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeThemePalette).filter(Boolean) as ThemePalette[];
  } catch {
    return [];
  }
}

function saveCustomPalettes(palettes: ThemePalette[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(CUSTOM_PALETTES_STORAGE_KEY, JSON.stringify(palettes));
}

function isCircadianMode(value: unknown): value is CircadianMode {
  return value === 'auto' || value === 'day' || value === 'evening' || value === 'night' || value === 'system';
}

function applyPaletteVariables(palette: ThemePalette | null) {
  const root = document.documentElement;
  if (!palette) {
    for (const key of THEME_VARIABLE_NAMES) root.style.removeProperty(key);
    return;
  }
  for (const key of THEME_VARIABLE_NAMES) {
    const value = palette.variables[key];
    if (value) root.style.setProperty(key, value);
    else root.style.removeProperty(key);
  }
}

export function useCircadianTheme(syncEnabled = false): CircadianTheme {
  const [autoPhase, setAutoPhase] = useState<CircadianPhase>(() => getPhaseAtTime());
  const [mode, setModeState] = useState<CircadianMode>(() => readInitialMode());
  const [systemIsDark, setSystemIsDark] = useState(() => getSystemIsDark());
  const [paletteId, setPaletteIdState] = useState(() => readInitialPaletteId());
  const [previewPaletteId, setPreviewPaletteId] = useState<string | null>(null);
  const [customPalettes, setCustomPalettes] = useState<ThemePalette[]>(() => readCustomPalettes());
  const applyingRemoteRef = useRef(false);
  const currentPhase = phaseForMode(mode, autoPhase, systemIsDark);
  const palettes = [...BUILT_IN_THEME_PALETTES, ...customPalettes];
  const effectivePaletteId = previewPaletteId || paletteId;
  const activePalette = effectivePaletteId === CIRCADIAN_PALETTE_ID
    ? null
    : palettes.find((palette) => palette.id === effectivePaletteId) || null;

  const updatePhase = useCallback(() => {
    setAutoPhase(getPhaseAtTime());
  }, []);

  const applySyncedTheme = useCallback((settings: ThemeSettings | undefined) => {
    if (!settings) return;
    applyingRemoteRef.current = true;
    try {
      if (isCircadianMode(settings.mode)) {
        setModeState(settings.mode);
        localStorage.setItem(MODE_STORAGE_KEY, settings.mode);
        localStorage.removeItem(LEGACY_OVERRIDE_KEY);
      }

      const syncedPalettes = Array.isArray(settings.customPalettes)
        ? settings.customPalettes.map(normalizeThemePalette).filter(Boolean) as ThemePalette[]
        : null;
      if (syncedPalettes) {
        const next = syncedPalettes.slice(-12);
        setCustomPalettes(next);
        saveCustomPalettes(next);
      }

      if (typeof settings.paletteId === 'string') {
        const normalized = settings.paletteId === CIRCADIAN_PALETTE_ID ? CIRCADIAN_PALETTE_ID : sanitizeThemeId(settings.paletteId);
        setPreviewPaletteId(null);
        setPaletteIdState(normalized);
        localStorage.setItem(PALETTE_STORAGE_KEY, normalized);
      }
    } finally {
      window.setTimeout(() => { applyingRemoteRef.current = false; }, 0);
    }
  }, []);

  useEffect(() => {
    const onWorkspaceSync = (event: Event) => {
      const state = (event as CustomEvent<{ state?: { themeSettings?: ThemeSettings } }>).detail?.state;
      applySyncedTheme(state?.themeSettings);
    };
    window.addEventListener('web-console-workspace-sync', onWorkspaceSync);
    return () => window.removeEventListener('web-console-workspace-sync', onWorkspaceSync);
  }, [applySyncedTheme]);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return;
    const onChange = () => setSystemIsDark(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Apply to DOM
  useEffect(() => {
    document.documentElement.setAttribute('data-circadian-phase', currentPhase);
    document.documentElement.setAttribute('data-circadian-mode', mode);
    document.documentElement.setAttribute('data-theme-palette', effectivePaletteId);
    applyPaletteVariables(activePalette);
    const themeConfig = activePalette || PHASE_CONFIG[currentPhase];
    document.documentElement.setAttribute('data-terminal-tone', themeConfig.isDark ? 'dark' : 'light');
    window.dispatchEvent(new CustomEvent('circadian-theme-change', {
      detail: { phase: currentPhase, mode, paletteId: effectivePaletteId, palette: activePalette, ...themeConfig },
    }));
  }, [activePalette, currentPhase, effectivePaletteId, mode]);

  // Update every 5 min
  useEffect(() => {
    const interval = setInterval(updatePhase, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [updatePhase]);

  const setMode = useCallback((nextMode: CircadianMode) => {
    setModeState(nextMode);
    localStorage.setItem(MODE_STORAGE_KEY, nextMode);
    localStorage.removeItem(LEGACY_OVERRIDE_KEY);
  }, []);

  const setPalette = useCallback((nextPaletteId: string) => {
    const normalized = nextPaletteId === CIRCADIAN_PALETTE_ID ? CIRCADIAN_PALETTE_ID : sanitizeThemeId(nextPaletteId);
    setPreviewPaletteId(null);
    setPaletteIdState(normalized);
    localStorage.setItem(PALETTE_STORAGE_KEY, normalized);
  }, []);

  const resetToAuto = useCallback(() => {
    setPreviewPaletteId(null);
    setModeState('auto');
    setPaletteIdState(CIRCADIAN_PALETTE_ID);
    localStorage.setItem(MODE_STORAGE_KEY, 'auto');
    localStorage.setItem(PALETTE_STORAGE_KEY, CIRCADIAN_PALETTE_ID);
    localStorage.removeItem(LEGACY_OVERRIDE_KEY);
  }, []);

  const importPalette = useCallback((value: unknown) => {
    const palette = normalizeThemePalette(value);
    if (!palette) return null;
    const existingIds = new Set([...BUILT_IN_THEME_PALETTES.map((item) => item.id), CIRCADIAN_PALETTE_ID]);
    const safePalette = {
      ...palette,
      id: existingIds.has(palette.id) ? `${palette.id}-custom` : palette.id,
      custom: true,
    };
    setCustomPalettes((current) => {
      const next = [...current.filter((item) => item.id !== safePalette.id), safePalette].slice(-12);
      saveCustomPalettes(next);
      return next;
    });
    setPalette(safePalette.id);
    return safePalette;
  }, [setPalette]);

  useEffect(() => {
    if (!syncEnabled || applyingRemoteRef.current) return;
    saveThemeSettings({
      mode,
      paletteId,
      customPalettes,
      updatedAt: Date.now(),
    });
  }, [customPalettes, mode, paletteId, syncEnabled]);

  return {
    phase: currentPhase,
    mode,
    colorTemp: activePalette?.colorTemp || PHASE_CONFIG[currentPhase].colorTemp,
    isDark: activePalette?.isDark ?? PHASE_CONFIG[currentPhase].isDark,
    paletteId,
    previewPaletteId,
    palettes,
    activePalette,
    setMode,
    setOverride: useCallback((phase: CircadianPhase) => setMode(modeFromPhase(phase)), [setMode]),
    clearOverride: resetToAuto,
    resetToAuto,
    setPalette,
    previewPalette: setPreviewPaletteId,
    clearPreview: useCallback(() => setPreviewPaletteId(null), []),
    importPalette,
  };
}
