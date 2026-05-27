import { defineStore } from 'pinia';
import { TABLE_ORDER_FIELD_ACU } from '../../shared/constants';

export type VisualizerMode = 'data' | 'config' | 'assistant' | 'global' | 'table-management';
export type VisualizerOpenSource = 'external-api' | 'v2-shell';
export type VisualizerSaveTarget = 'chat' | 'global';

export interface VisualizerSheetItem {
  key: string;
  name: string;
  rowCount: number;
  columnCount: number;
}

export interface VisualizerLockDraft {
  rows: number[];
  cols: number[];
  cells: string[];
  specialIndexLocked: boolean;
}

export type VisualizerAssistantTurnState =
  | {
      id: string;
      type: 'user';
      userRequest: string;
      anchorSheetKey: string;
      createdAt: number;
    }
  | {
      id: string;
      type: 'round';
      round: number;
      maxRounds: number;
      roundData: any;
      anchorSheetKey: string;
      createdAt: number;
    }
  | {
      id: string;
      type: 'final';
      userRequest: string;
      result: any;
      anchorSheetKey: string;
      createdAt: number;
    }
  | {
      id: string;
      type: 'error';
      errorMessage: string;
      anchorSheetKey: string;
      createdAt: number;
    };

interface VisualizerEntrySnapshot {
  source: VisualizerOpenSource;
  wasShellOpen: boolean;
  previousPageId: string | null;
}

interface VisualizerCloseResult {
  shouldCloseShell: boolean;
  previousPageId: string | null;
}

interface VisualizerState {
  isActive: boolean;
  mode: VisualizerMode;
  dirty: boolean;
  externalRevisionChanged: boolean;
  currentSheetKey: string | null;
  tempData: Record<string, any> | null;
  sheetOrder: string[];
  deletedSheetKeys: string[];
  pendingLockChanges: any[];
  tableLockDrafts: Record<string, VisualizerLockDraft>;
  isLoading: boolean;
  loadError: string;
  isSaving: boolean;
  lastSavedTarget: VisualizerSaveTarget | null;
  lastLoadedAt: number;
  lastSavedAt: number;
  openTick: number;
  focusTick: number;
  externalRefreshTick: number;
  entrySnapshot: VisualizerEntrySnapshot | null;
  assistantUserRequest: string;
  assistantMaxRounds: number;
  assistantTableApiPreset: string;
  assistantIsRunning: boolean;
  assistantErrorMessage: string;
  assistantRounds: any[];
  assistantLatestResult: any | null;
  assistantTurns: VisualizerAssistantTurnState[];
  assistantRiskConfirmations: Record<string, boolean>;
}

function cloneData<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeSheetName(sheet: any, fallback: string): string {
  const name = String(sheet?.name || '').trim();
  return name || fallback;
}

function listSheetKeys(data: Record<string, any> | null): string[] {
  if (!data || typeof data !== 'object') return [];
  return Object.keys(data).filter(key => key.startsWith('sheet_'));
}

function buildSheetOrder(data: Record<string, any>, preferredOrder: string[] = []): string[] {
  const existing = listSheetKeys(data);
  const ordered: string[] = [];

  for (const key of preferredOrder) {
    if (existing.includes(key) && !ordered.includes(key)) ordered.push(key);
  }

  const missing = existing
    .filter(key => !ordered.includes(key))
    .sort((a, b) => {
      const ao = Number.isFinite(data?.[a]?.[TABLE_ORDER_FIELD_ACU])
        ? Math.trunc(data[a][TABLE_ORDER_FIELD_ACU])
        : Infinity;
      const bo = Number.isFinite(data?.[b]?.[TABLE_ORDER_FIELD_ACU])
        ? Math.trunc(data[b][TABLE_ORDER_FIELD_ACU])
        : Infinity;
      if (ao !== bo) return ao - bo;
      return normalizeSheetName(data[a], a).localeCompare(normalizeSheetName(data[b], b));
    });

  return [...ordered, ...missing];
}

function applyOrderNumbers(data: Record<string, any> | null, orderedKeys: string[]): void {
  if (!data) return;
  orderedKeys.forEach((key, index) => {
    if (data[key] && typeof data[key] === 'object') {
      data[key][TABLE_ORDER_FIELD_ACU] = index;
    }
  });
}

export const useVisualizerStore = defineStore('acu-v2-visualizer', {
  state: (): VisualizerState => ({
    isActive: false,
    mode: 'data',
    dirty: false,
    externalRevisionChanged: false,
    currentSheetKey: null,
    tempData: null,
    sheetOrder: [],
    deletedSheetKeys: [],
    pendingLockChanges: [],
    tableLockDrafts: {},
    isLoading: false,
    loadError: '',
    isSaving: false,
    lastSavedTarget: null,
    lastLoadedAt: 0,
    lastSavedAt: 0,
    openTick: 0,
    focusTick: 0,
    externalRefreshTick: 0,
    entrySnapshot: null,
    assistantUserRequest: '',
    assistantMaxRounds: 3,
    assistantTableApiPreset: '',
    assistantIsRunning: false,
    assistantErrorMessage: '',
    assistantRounds: [],
    assistantLatestResult: null,
    assistantTurns: [],
    assistantRiskConfirmations: {},
  }),
  getters: {
    sheetItems(state): VisualizerSheetItem[] {
      if (!state.tempData) return [];
      return state.sheetOrder
        .filter(key => !!state.tempData?.[key])
        .map(key => {
          const sheet = state.tempData?.[key] || {};
          const content = Array.isArray(sheet.content) ? sheet.content : [];
          const headers = Array.isArray(content[0]) ? content[0] : [];
          return {
            key,
            name: normalizeSheetName(sheet, key),
            rowCount: Math.max(0, content.length - 1),
            columnCount: Math.max(0, headers.length - 1),
          };
        });
    },
    currentSheet(state): any | null {
      if (!state.tempData || !state.currentSheetKey) return null;
      return state.tempData[state.currentSheetKey] || null;
    },
    hasSheets(state): boolean {
      return state.sheetOrder.some(key => !!state.tempData?.[key]);
    },
  },
  actions: {
    open(snapshot: VisualizerEntrySnapshot): void {
      if (this.isActive) {
        this.focusTick += 1;
        if (!this.dirty) this.externalRefreshTick += 1;
        return;
      }
      this.isActive = true;
      this.mode = 'data';
      this.externalRevisionChanged = false;
      this.entrySnapshot = snapshot;
      this.openTick += 1;
      this.focusTick += 1;
    },
    setMode(mode: VisualizerMode): void {
      this.mode = mode;
    },
    setDirty(dirty: boolean): void {
      this.dirty = dirty;
      if (!dirty) this.externalRevisionChanged = false;
    },
    setLoading(loading: boolean): void {
      this.isLoading = loading;
      if (loading) this.loadError = '';
    },
    setLoadError(message: string): void {
      this.loadError = String(message || '');
      this.isLoading = false;
    },
    setSaving(saving: boolean): void {
      this.isSaving = saving;
    },
    loadSnapshot(data: Record<string, any>, orderedKeys: string[] = []): void {
      const nextData = cloneData(data || { mate: { type: 'chatSheets', version: 1 } });
      if (!nextData.mate || typeof nextData.mate !== 'object') {
        nextData.mate = { type: 'chatSheets', version: 1 };
      }
      const nextOrder = buildSheetOrder(nextData, orderedKeys);
      applyOrderNumbers(nextData, nextOrder);

      this.tempData = nextData;
      this.sheetOrder = nextOrder;
      this.deletedSheetKeys = [];
      this.pendingLockChanges = [];
      this.tableLockDrafts = {};
      this.currentSheetKey = nextOrder.includes(this.currentSheetKey || '')
        ? this.currentSheetKey
        : nextOrder[0] || null;
      if ((this.mode === 'global' || this.mode === 'table-management') || !this.currentSheetKey) {
        this.mode = this.currentSheetKey ? 'data' : 'global';
      }
      this.dirty = false;
      this.externalRevisionChanged = false;
      this.loadError = '';
      this.isLoading = false;
      this.lastLoadedAt = Date.now();
      this.clearAssistantDraftState();
    },
    loadLockDrafts(drafts: Record<string, VisualizerLockDraft>): void {
      this.tableLockDrafts = cloneData(drafts || {});
    },
    clearAssistantDraftState(): void {
      this.assistantIsRunning = false;
      this.assistantErrorMessage = '';
      this.assistantRounds = [];
      this.assistantLatestResult = null;
      this.assistantTurns = [];
      this.assistantRiskConfirmations = {};
    },
    clearExternalRefreshConflict(): void {
      this.externalRevisionChanged = false;
    },
    selectSheet(key: string): void {
      if (!this.tempData?.[key]) return;
      this.currentSheetKey = key;
      if (this.mode === 'global' || this.mode === 'table-management') this.mode = 'data';
    },
    selectGlobalConfig(): void {
      this.mode = 'global';
    },
    selectTableManagement(): void {
      this.mode = 'table-management';
    },
    addSheet(key: string, sheet: Record<string, any>): void {
      if (!this.tempData) this.tempData = { mate: { type: 'chatSheets', version: 1 } };
      const normalizedKey = String(key || '').trim();
      if (!normalizedKey || this.tempData[normalizedKey]) return;
      this.tempData[normalizedKey] = cloneData(sheet);
      this.sheetOrder = buildSheetOrder(this.tempData, [...this.sheetOrder, normalizedKey]);
      applyOrderNumbers(this.tempData, this.sheetOrder);
      this.currentSheetKey = normalizedKey;
      this.mode = 'data';
      this.setDirty(true);
    },
    deleteSheet(key: string): void {
      if (!this.tempData?.[key]) return;
      delete this.tempData[key];
      if (!this.deletedSheetKeys.includes(key)) this.deletedSheetKeys.push(key);
      this.sheetOrder = this.sheetOrder.filter(item => item !== key);
      applyOrderNumbers(this.tempData, this.sheetOrder);
      if (this.currentSheetKey === key) this.currentSheetKey = this.sheetOrder[0] || null;
      if (!this.currentSheetKey && this.mode !== 'table-management') this.mode = 'global';
      this.setDirty(true);
    },
    moveSheet(key: string, direction: 'up' | 'down'): void {
      const index = this.sheetOrder.indexOf(key);
      if (index === -1) return;
      const nextIndex = direction === 'up' ? index - 1 : index + 1;
      if (nextIndex < 0 || nextIndex >= this.sheetOrder.length) return;
      const next = [...this.sheetOrder];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      this.sheetOrder = next;
      applyOrderNumbers(this.tempData, this.sheetOrder);
      this.setDirty(true);
    },
    addRow(): void {
      const sheet = this.currentSheet;
      if (!sheet) return;
      if (!Array.isArray(sheet.content)) sheet.content = [[null, '列1']];
      const headers = Array.isArray(sheet.content[0]) ? sheet.content[0] : [null, '列1'];
      sheet.content[0] = headers;
      const row = new Array(headers.length).fill('');
      row[0] = null;
      sheet.content.push(row);
      this.setDirty(true);
    },
    deleteRow(rowIndex: number): void {
      const sheet = this.currentSheet;
      if (!sheet || !Array.isArray(sheet.content)) return;
      const target = Math.trunc(Number(rowIndex));
      if (target < 0 || target >= sheet.content.length - 1) return;
      sheet.content.splice(target + 1, 1);
      this.setDirty(true);
    },
    updateCell(rowIndex: number, columnIndex: number, value: string): void {
      const sheet = this.currentSheet;
      if (!sheet || !Array.isArray(sheet.content)) return;
      const row = Math.trunc(Number(rowIndex));
      const col = Math.trunc(Number(columnIndex));
      if (row < 0 || col < 0) return;
      const contentRow = sheet.content[row + 1];
      if (!Array.isArray(contentRow)) return;
      contentRow[col + 1] = String(value ?? '');
      this.setDirty(true);
    },
    markSaved(target: VisualizerSaveTarget): void {
      this.deletedSheetKeys = [];
      this.pendingLockChanges = [];
      this.lastSavedTarget = target;
      this.lastSavedAt = Date.now();
      this.setDirty(false);
    },
    getLockDraft(sheetKey: string | null | undefined): VisualizerLockDraft {
      const key = String(sheetKey || '').trim();
      if (!key) return { rows: [], cols: [], cells: [], specialIndexLocked: true };
      if (!this.tableLockDrafts[key]) {
        this.tableLockDrafts[key] = { rows: [], cols: [], cells: [], specialIndexLocked: true };
      }
      return this.tableLockDrafts[key];
    },
    isRowLocked(sheetKey: string | null | undefined, rowIndex: number): boolean {
      return this.getLockDraft(sheetKey).rows.includes(Math.trunc(Number(rowIndex)));
    },
    isColumnLocked(sheetKey: string | null | undefined, columnIndex: number): boolean {
      return this.getLockDraft(sheetKey).cols.includes(Math.trunc(Number(columnIndex)));
    },
    isCellLocked(sheetKey: string | null | undefined, rowIndex: number, columnIndex: number): boolean {
      return this.getLockDraft(sheetKey).cells.includes(`${Math.trunc(Number(rowIndex))}:${Math.trunc(Number(columnIndex))}`);
    },
    isSpecialIndexLocked(sheetKey: string | null | undefined): boolean {
      return this.getLockDraft(sheetKey).specialIndexLocked !== false;
    },
    toggleRowLock(sheetKey: string | null | undefined, rowIndex: number): void {
      const lock = this.getLockDraft(sheetKey);
      const value = Math.trunc(Number(rowIndex));
      if (!Number.isFinite(value)) return;
      lock.rows = lock.rows.includes(value)
        ? lock.rows.filter(item => item !== value)
        : [...lock.rows, value];
      this.setDirty(true);
    },
    toggleColumnLock(sheetKey: string | null | undefined, columnIndex: number): void {
      const lock = this.getLockDraft(sheetKey);
      const value = Math.trunc(Number(columnIndex));
      if (!Number.isFinite(value)) return;
      lock.cols = lock.cols.includes(value)
        ? lock.cols.filter(item => item !== value)
        : [...lock.cols, value];
      this.setDirty(true);
    },
    toggleCellLock(sheetKey: string | null | undefined, rowIndex: number, columnIndex: number): void {
      const lock = this.getLockDraft(sheetKey);
      const key = `${Math.trunc(Number(rowIndex))}:${Math.trunc(Number(columnIndex))}`;
      lock.cells = lock.cells.includes(key)
        ? lock.cells.filter(item => item !== key)
        : [...lock.cells, key];
      this.setDirty(true);
    },
    applyLockChangesToDraft(changes: any[]): void {
      if (!Array.isArray(changes)) return;
      changes.forEach(change => {
        const sheetKey = String(change?.sheetKey || '').trim();
        if (!sheetKey) return;
        const lock = this.getLockDraft(sheetKey);
        const rows = new Set(lock.rows);
        const cols = new Set(lock.cols);
        const cells = new Set(lock.cells);
        (Array.isArray(change.rows) ? change.rows : []).forEach((item: any) => {
          const value = Math.trunc(Number(item?.rowIndex));
          if (!Number.isFinite(value)) return;
          if (item?.locked) rows.add(value);
          else rows.delete(value);
        });
        (Array.isArray(change.columns) ? change.columns : []).forEach((item: any) => {
          const value = Math.trunc(Number(item?.colIndex));
          if (!Number.isFinite(value)) return;
          if (item?.locked) cols.add(value);
          else cols.delete(value);
        });
        (Array.isArray(change.cells) ? change.cells : []).forEach((item: any) => {
          const row = Math.trunc(Number(item?.rowIndex));
          const col = Math.trunc(Number(item?.colIndex));
          if (!Number.isFinite(row) || !Number.isFinite(col)) return;
          const key = `${row}:${col}`;
          if (item?.locked) cells.add(key);
          else cells.delete(key);
        });
        lock.rows = Array.from(rows).sort((a, b) => a - b);
        lock.cols = Array.from(cols).sort((a, b) => a - b);
        lock.cells = Array.from(cells).sort();
        if (typeof change.specialIndexLocked === 'boolean') {
          lock.specialIndexLocked = change.specialIndexLocked;
        }
      });
      if (changes.length) this.setDirty(true);
    },
    queueLockChanges(changes: any[]): void {
      if (!Array.isArray(changes) || changes.length === 0) return;
      this.applyLockChangesToDraft(changes);
      this.pendingLockChanges = [
        ...this.pendingLockChanges,
        ...cloneData(changes),
      ];
      this.setDirty(true);
    },
    requestExternalRefresh(): 'ignored' | 'refreshed' | 'conflicted' {
      if (!this.isActive) return 'ignored';
      if (this.dirty) {
        this.externalRevisionChanged = true;
        return 'conflicted';
      }
      this.externalRevisionChanged = false;
      this.externalRefreshTick += 1;
      return 'refreshed';
    },
    closeSurface(): VisualizerCloseResult {
      const snapshot = this.entrySnapshot;
      this.isActive = false;
      this.mode = 'data';
      this.dirty = false;
      this.externalRevisionChanged = false;
      this.currentSheetKey = null;
      this.tempData = null;
      this.sheetOrder = [];
      this.deletedSheetKeys = [];
      this.pendingLockChanges = [];
      this.tableLockDrafts = {};
      this.isLoading = false;
      this.loadError = '';
      this.isSaving = false;
      this.entrySnapshot = null;
      this.assistantUserRequest = '';
      this.assistantMaxRounds = 3;
      this.assistantTableApiPreset = '';
      this.clearAssistantDraftState();
      return {
        shouldCloseShell: snapshot ? !snapshot.wasShellOpen : false,
        previousPageId: snapshot?.previousPageId ?? null,
      };
    },
  },
});
