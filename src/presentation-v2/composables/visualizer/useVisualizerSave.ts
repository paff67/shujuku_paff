import { TABLE_TEMPLATE_ACU } from '../../../shared/defaults-json.js';
import { TABLE_ORDER_FIELD_ACU } from '../../../shared/constants';
import { topLevelWindow_ACU } from '../../../shared/env';
import { safeJsonStringify_ACU } from '../../../shared/json-helpers';
import {
  applySheetOrderNumbers_ACU,
  ensureSheetOrderNumbers_ACU,
  isSummaryOrOutlineTable_ACU,
  logDebug_ACU,
  logWarn_ACU,
  parseTableTemplateJson_ACU,
} from '../../../shared/utils';
import {
  isDefaultTemplatePresetSelection_ACU,
  normalizeTemplatePresetSelectionValue_ACU,
} from '../../../shared/template-preset-utils';
import { getChatArray_ACU } from '../../../service/chat/chat-service';
import {
  currentJsonTableData_ACU,
  getCurrentIsolationKey_ACU,
  settings_ACU,
  _set_currentJsonTableData_ACU,
} from '../../../service/runtime/state-manager';
import {
  applySummaryIndexSequenceToTable_ACU,
  getSummaryIndexColumnIndex_ACU,
  saveTableLocksForSheet_ACU,
  setSpecialIndexLockEnabled_ACU,
} from '../../../service/runtime/helpers-remaining';
import { getCurrentWorldbookConfig_ACU } from '../../../service/settings/settings-readers';
import { saveIndependentTableToChatHistory_ACU } from '../../../service/table/table-service';
import {
  getLatestAiMessageIndexFromChat_ACU,
  resolveTableHistoryStateFromChat_ACU,
} from '../../../service/table/table-history';
import { isSqliteMode } from '../../../service/table/storage-mode';
import { reloadStorageProvider } from '../../../service/table/table-storage-strategy';
import {
  buildChatSheetGuideDataFromData_ACU,
  getChatSheetGuideDataForIsolationKey_ACU,
  getSortedSheetKeys_ACU,
  materializeDataFromSheetGuide_ACU,
  sanitizeTemplateSnapshotForChat_ACU,
  setChatSheetGuideDataForIsolationKey_ACU,
} from '../../../service/template/chat-scope';
import {
  applyTemplatePresetToCurrent_ACU,
  resolveActiveTemplatePresetName_ACU,
  upsertTemplatePreset_ACU,
} from '../../../service/template/template-preset-service';
import {
  getGlobalInjectionConfigFromData_ACU,
  purgeSheetKeysFromChatHistoryHard_ACU,
} from '../../../service/worldbook/injection-engine';
import { refreshMergedDataAndNotify_ACU } from '../../../service/worldbook/pipeline';
import { enqueueSummaryVectorIndexFlush_ACU } from '../../../service/vector/summary-vector-index-flush-queue';
import { useToastStore } from '../../stores/toast-store';
import { useVisualizerStore, type VisualizerLockDraft, type VisualizerSaveTarget } from '../../stores/visualizer-store';

export interface VisualizerSaveInteractions {
  requestGlobalPresetName?: (defaultName: string) => string | null | Promise<string | null>;
  confirmOverwriteGlobalPreset?: (presetName: string) => boolean | Promise<boolean>;
}

type GlobalTemplateSaveResult =
  | { status: 'saved'; presetName: string }
  | { status: 'unchanged' }
  | { status: 'cancelled' };

function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function applySpecialIndexSequenceFromDrafts(
  data: Record<string, any>,
  lockDrafts: Record<string, VisualizerLockDraft>,
): void {
  Object.keys(data || {}).forEach(sheetKey => {
    if (!sheetKey.startsWith('sheet_')) return;
    const table = data[sheetKey];
    if (!table || !isSummaryOrOutlineTable_ACU(String(table.name || ''))) return;
    if (lockDrafts[sheetKey]?.specialIndexLocked === false) return;
    const colIndex = getSummaryIndexColumnIndex_ACU(table);
    if (colIndex < 0) return;
    applySummaryIndexSequenceToTable_ACU(table, colIndex);
  });
}

function buildOrderedData(
  tempData: Record<string, any> | null,
  sheetOrder: string[],
  lockDrafts: Record<string, VisualizerLockDraft>,
): Record<string, any> {
  const source = tempData || { mate: { type: 'chatSheets', version: 1 } };
  const orderedData: Record<string, any> = {};
  Object.keys(source).forEach(key => {
    if (!key.startsWith('sheet_')) orderedData[key] = cloneData(source[key]);
  });
  sheetOrder.forEach(key => {
    if (source[key]) orderedData[key] = cloneData(source[key]);
  });
  applySheetOrderNumbers_ACU(orderedData, sheetOrder);
  applySpecialIndexSequenceFromDrafts(orderedData, lockDrafts);
  return orderedData;
}

function saveLockDrafts(drafts: Record<string, VisualizerLockDraft>): void {
  Object.entries(drafts || {}).forEach(([sheetKey, draft]) => {
    if (!sheetKey) return;
    saveTableLocksForSheet_ACU(sheetKey, {
      rows: new Set(draft.rows || []),
      cols: new Set(draft.cols || []),
      cells: new Set(draft.cells || []),
    });
    setSpecialIndexLockEnabled_ACU(sheetKey, draft.specialIndexLocked !== false);
  });
}

function syncChatSheetGuide(saveToTemplate: boolean): void {
  try {
    const guideIsolationKey = getCurrentIsolationKey_ACU();
    const existingGuide = getChatSheetGuideDataForIsolationKey_ACU(guideIsolationKey);
    const templateObjForSeed = parseTableTemplateJson_ACU({ stripSeedRows: false });
    const guideData = buildChatSheetGuideDataFromData_ACU(currentJsonTableData_ACU, {
      preserveSeedRowsFromGuideData: existingGuide,
      seedRowsFromTemplateObj: templateObjForSeed,
    });
    if (guideData && Object.keys(guideData).some(key => key.startsWith('sheet_'))) {
      const syncTemplateScope = !saveToTemplate;
      const templateScopeSource = materializeDataFromSheetGuide_ACU(guideData, { includeSeedRows: true });
      setChatSheetGuideDataForIsolationKey_ACU(guideIsolationKey, guideData, {
        reason: 'visualizer_v2_save',
        syncTemplateScope,
        templateSource: templateScopeSource,
        presetName: resolveActiveTemplatePresetName_ACU({
          fallbackToGlobal: true,
          isolationKey: guideIsolationKey,
        }),
        source: 'visualizer_v2_save',
      });
    }
  } catch (error) {
    logWarn_ACU('[ACU-V2 Visualizer] Failed to sync chat sheet guide:', error);
  }
}

async function saveGlobalTemplateSnapshot(
  orderedData: Record<string, any>,
  interactions: VisualizerSaveInteractions,
): Promise<GlobalTemplateSaveResult> {
  let templateObj: any = null;
  try {
    templateObj = JSON.parse(TABLE_TEMPLATE_ACU);
  } catch {
    templateObj = parseTableTemplateJson_ACU({ stripSeedRows: false });
  }
  if (!templateObj || typeof templateObj !== 'object') templateObj = {};

  const tempGlobalCfg = getGlobalInjectionConfigFromData_ACU(orderedData, {
    ensureWriteBack: true,
  });
  const prevGlobalCfgStr = safeJsonStringify_ACU(templateObj?.mate?.globalInjectionConfig || {}, '{}');
  const nextGlobalCfgStr = safeJsonStringify_ACU(tempGlobalCfg || {}, '{}');
  if (!templateObj.mate || typeof templateObj.mate !== 'object') {
    templateObj.mate = { type: 'chatSheets', version: 1 };
  }
  if (!templateObj.mate.type) templateObj.mate.type = 'chatSheets';
  if (!Number.isFinite(templateObj.mate.version)) templateObj.mate.version = 1;
  templateObj.mate.globalInjectionConfig = tempGlobalCfg;

  let templateChanged = prevGlobalCfgStr !== nextGlobalCfgStr;

  Object.keys(orderedData || {}).forEach(key => {
    if (!key.startsWith('sheet_')) return;
    const currentTable = orderedData[key];
    if (!templateObj[key]) {
      const newTemplateTable = cloneData(currentTable);
      if (Array.isArray(newTemplateTable.content) && newTemplateTable.content.length > 1) {
        newTemplateTable.content = [newTemplateTable.content[0]];
      }
      newTemplateTable[TABLE_ORDER_FIELD_ACU] = currentTable[TABLE_ORDER_FIELD_ACU];
      templateObj[key] = newTemplateTable;
      templateChanged = true;
      return;
    }

    const templateTable = templateObj[key];
    if (templateTable.name !== currentTable.name) {
      templateTable.name = currentTable.name;
      templateChanged = true;
    }
    for (const field of ['sourceData', 'updateConfig', 'exportConfig']) {
      if (JSON.stringify(templateTable[field]) !== JSON.stringify(currentTable[field])) {
        templateTable[field] = currentTable[field] ? cloneData(currentTable[field]) : {};
        templateChanged = true;
      }
    }
    if (templateTable[TABLE_ORDER_FIELD_ACU] !== currentTable[TABLE_ORDER_FIELD_ACU]) {
      templateTable[TABLE_ORDER_FIELD_ACU] = currentTable[TABLE_ORDER_FIELD_ACU];
      templateChanged = true;
    }
    const currentHeaders = Array.isArray(currentTable.content?.[0]) ? currentTable.content[0] : null;
    if (currentHeaders && JSON.stringify(templateTable.content?.[0]) !== JSON.stringify(currentHeaders)) {
      if (!Array.isArray(templateTable.content)) templateTable.content = [];
      templateTable.content[0] = cloneData(currentHeaders);
      templateChanged = true;
    }
  });

  Object.keys(templateObj).forEach(key => {
    if (key.startsWith('sheet_') && !orderedData?.[key]) {
      delete templateObj[key];
      templateChanged = true;
    }
  });

  ensureSheetOrderNumbers_ACU(templateObj, {
    baseOrderKeys: getSortedSheetKeys_ACU(orderedData, { ignoreChatGuide: true }),
    forceRebuild: false,
  });

  if (!templateChanged) return { status: 'unchanged' };

  const isolationKey = getCurrentIsolationKey_ACU();
  const activePresetName = normalizeTemplatePresetSelectionValue_ACU(
    resolveActiveTemplatePresetName_ACU({ fallbackToGlobal: true, isolationKey }),
  );
  let finalGlobalPresetName = activePresetName;
  if (isDefaultTemplatePresetSelection_ACU(finalGlobalPresetName)) {
    const promptedName = interactions.requestGlobalPresetName
      ? await interactions.requestGlobalPresetName('新模板预设')
      : null;
    if (!promptedName) return { status: 'cancelled' };
    finalGlobalPresetName = normalizeTemplatePresetSelectionValue_ACU(String(promptedName).trim());
  } else {
    const confirmed = interactions.confirmOverwriteGlobalPreset
      ? await interactions.confirmOverwriteGlobalPreset(finalGlobalPresetName)
      : false;
    if (!confirmed) return { status: 'cancelled' };
  }
  if (!finalGlobalPresetName) return { status: 'cancelled' };

  const preparedSnapshot = sanitizeTemplateSnapshotForChat_ACU(templateObj);
  if (!preparedSnapshot?.templateStr) {
    throw new Error('无法生成模板快照。');
  }
  const presetSaved = upsertTemplatePreset_ACU(finalGlobalPresetName, preparedSnapshot.templateStr);
  if (!presetSaved) throw new Error('无法写入全局预设库。');

  const applied = await applyTemplatePresetToCurrent_ACU(finalGlobalPresetName, {
    source: 'visualizer_v2_save_to_global',
    updateGlobal: true,
    save: true,
    persistChatScope: false,
  });
  if (!applied) throw new Error('模板快照应用失败。');
  return { status: 'saved', presetName: finalGlobalPresetName };
}

async function saveCurrentDataToChat(
  sheetKeysToSave: string[],
  deletedSheetKeys: string[],
): Promise<'memory-only' | 'saved'> {
  const chat = getChatArray_ACU();
  if (!chat.length) return 'memory-only';

  const isolationKey = getCurrentIsolationKey_ACU();
  const allSheetKeys = sheetKeysToSave.filter(key => !!currentJsonTableData_ACU?.[key]);
  const latestAiIndex = getLatestAiMessageIndexFromChat_ACU(chat);
  const bucketByIndex: Record<number, string[]> = {};

  allSheetKeys.forEach(key => {
    const table = currentJsonTableData_ACU?.[key];
    const history = resolveTableHistoryStateFromChat_ACU(chat, {
      sheetKey: key,
      isSummaryTable: table ? isSummaryOrOutlineTable_ACU(table.name) : false,
      isolationKey,
      settings: settings_ACU,
    });
    const idx = history.latestDataMessageIndex !== -1
      ? history.latestDataMessageIndex
      : latestAiIndex;
    if (idx === -1) return;
    if (!bucketByIndex[idx]) bucketByIndex[idx] = [];
    bucketByIndex[idx].push(key);
  });

  if (Object.keys(bucketByIndex).length === 0 && latestAiIndex !== -1) {
    bucketByIndex[latestAiIndex] = [...allSheetKeys];
  }
  if (Object.keys(bucketByIndex).length === 0) return 'memory-only';

  for (const [indexStr, keys] of Object.entries(bucketByIndex)) {
    const idx = Number.parseInt(indexStr, 10);
    if (Number.isNaN(idx)) continue;
    await saveIndependentTableToChatHistory_ACU(idx, keys, null, true);
  }

  if (deletedSheetKeys.length > 0) {
    const result = await purgeSheetKeysFromChatHistoryHard_ACU(deletedSheetKeys);
    if (result?.changed && isSqliteMode()) {
      try {
        await reloadStorageProvider();
      } catch (error) {
        logWarn_ACU('[ACU-V2 Visualizer] reloadStorageProvider failed:', error);
      }
    }
  }

  await refreshMergedDataAndNotify_ACU();

  const shouldSyncSummaryVectorIndex = allSheetKeys.some(sheetKey => {
    const table = currentJsonTableData_ACU?.[sheetKey];
    return !!table?.name && isSummaryOrOutlineTable_ACU(String(table.name || ''));
  });
  if (shouldSyncSummaryVectorIndex && getCurrentWorldbookConfig_ACU().summaryVectorIndexModeEnabled === true) {
    try {
      await enqueueSummaryVectorIndexFlush_ACU({
        targetMessageIndex: latestAiIndex !== -1 ? latestAiIndex : undefined,
        mode: 'sync',
        reason: 'visualizer_v2_save',
      });
    } catch (error) {
      logWarn_ACU('[ACU-V2 Visualizer] summary vector index queue failed:', error);
    }
  }

  try {
    (topLevelWindow_ACU as any).AutoCardUpdaterAPI?._notifyTableUpdate?.();
  } catch (error) {
    logDebug_ACU('[ACU-V2 Visualizer] table update notification skipped:', error);
  }

  return 'saved';
}

export function useVisualizerSave(interactions: VisualizerSaveInteractions = {}) {
  const visualizer = useVisualizerStore();
  const toastStore = useToastStore();

  async function save(target: VisualizerSaveTarget): Promise<boolean> {
    if (visualizer.isSaving) return false;
    visualizer.setSaving(true);
    try {
      const orderedData = buildOrderedData(visualizer.tempData, visualizer.sheetOrder, visualizer.tableLockDrafts);

      let globalTemplateResult: GlobalTemplateSaveResult | null = null;
      if (target === 'global') {
        globalTemplateResult = await saveGlobalTemplateSnapshot(orderedData, interactions);
        if (globalTemplateResult.status === 'cancelled') return false;
      }

      _set_currentJsonTableData_ACU(cloneData(orderedData));
      syncChatSheetGuide(target === 'global');

      const chatResult = await saveCurrentDataToChat(
        [...visualizer.sheetOrder],
        [...visualizer.deletedSheetKeys],
      );
      saveLockDrafts(visualizer.tableLockDrafts);
      visualizer.markSaved(target);

      if (target === 'global' && globalTemplateResult?.status === 'saved') {
        toastStore.success(`已保存到全局预设：${globalTemplateResult.presetName}。`, { muteable: false });
      } else if (target === 'global') {
        toastStore.info('全局模板没有结构变化；当前聊天数据已同步。', { muteable: false });
      } else if (chatResult === 'memory-only') {
        toastStore.warning('找不到可写入的 AI 消息，修改已保存在运行内存中。', { muteable: false });
      } else {
        toastStore.success('已保存到当前聊天。', { muteable: false });
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存失败，请查看控制台日志。';
      logWarn_ACU('[ACU-V2 Visualizer] save failed:', error);
      toastStore.error(message, { muteable: false });
      return false;
    } finally {
      visualizer.setSaving(false);
    }
  }

  return {
    saveToChat: () => save('chat'),
    saveToGlobal: () => save('global'),
  };
}
