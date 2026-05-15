// ═══════════════════════════════════════════════════════════════
// service/table/table-service.ts — 表格数据操作 service 层
// 从 data/repositories/table-repo.ts 迁入（消除 data 层越权）
// ═══════════════════════════════════════════════════════════════

import { getChatArray_ACU, saveChatToHost_ACU } from '../../data/gateways/chat-gateway';
import { logDebug_ACU, logError_ACU, logWarn_ACU, parseTableTemplateJson_ACU } from '../../shared/utils';
import type { TableDataObject_ACU } from '../../shared/models/table-data';
import { currentJsonTableData_ACU, getCurrentIsolationKey_ACU, settings_ACU, _set_currentJsonTableData_ACU } from '../runtime/state-manager';
import { applyTemplateScopeForCurrentChat_ACU } from '../settings/settings-service';
import {
  attachSeedRowsToCurrentDataFromGuide_ACU,
  buildChatSheetGuideDataFromData_ACU,
  ensureChatSheetGuideSeeded_ACU,
  getChatSheetGuideDataForIsolationKey_ACU,
  getSortedSheetKeys_ACU,
  sanitizeSheetForStorage_ACU,
  setChatSheetGuideDataForIsolationKey_ACU,
} from '../template/chat-scope';
import { deleteAllGeneratedEntries_ACU } from '../worldbook/pipeline';
import { mergeAllIndependentTables_ACU } from '../runtime/helpers-remaining';
import { cloneIsolatedData_ACU, writeIsolatedTagData_ACU, writeMessageIdentity_ACU, readIsolatedTagData_ACU, readLegacyIndependentData_ACU, isLegacyMatchForIsolation_ACU } from '../../data/repositories/chat-message-data-repo';
import { createTableDeltaFromBeforeAfter_ACU } from './table-delta-diff';
import { reconstructTablesFromChatDeltas_ACU } from './table-delta-reconstruct';
import { clearCurrentIsolationLegacyTableSnapshots_ACU, writeTablePersistenceLayerV2_ACU } from './table-delta-repository';
import {
  appendTablePersistenceDeltaToLayerV2_ACU,
  hasTablePersistenceDeltasV2_ACU,
} from '../../shared/models/table-persistence-v2-utils';

export interface TableChatPersistOptions_ACU {
  targetMessageIndex?: number;
  targetSheetKeys?: string[] | null;
  updateGroupKeys?: string[] | null;
  beforeData?: TableDataObject_ACU | null;
  afterData?: TableDataObject_ACU | null;
  /**
   * 显式允许把已有真实数据行的目标表保存为空表/缺失表。
   * 默认 false：自动填表路径不允许把运行时异常导出的空快照落盘成清空 delta。
   */
  allowClearingTargetSheets?: boolean;
  /**
   * 只把这些 sheet 记录为“本轮已更新”。
   * targetSheetKeys 决定保存哪些表；trackingSheetKeys 决定哪些表推进自动更新门禁。
   * 未传时沿用 targetSheetKeys，保持旧调用兼容。
   */
  trackingSheetKeys?: string[] | null;
  trackAsUpdate?: boolean;
}

function cloneTableDataForPersistence_ACU(data: TableDataObject_ACU | null | undefined): TableDataObject_ACU | null {
  return data ? JSON.parse(JSON.stringify(data)) as TableDataObject_ACU : null;
}

function sheetHasRealRowsForPersistence_ACU(sheet: any): boolean {
  return !!sheet && Array.isArray(sheet.content) && sheet.content.length > 1;
}

function sheetIsMissingOrEmptyForPersistence_ACU(sheet: any): boolean {
  return !sheet || !Array.isArray(sheet.content) || sheet.content.length <= 1;
}

function resolveTargetSheetKeysForPersistence_ACU(
  targetSheetKeys: string[] | null,
  beforeData: TableDataObject_ACU | null,
  afterData: TableDataObject_ACU | null,
): string[] {
  if (Array.isArray(targetSheetKeys) && targetSheetKeys.length > 0) {
    return Array.from(new Set(targetSheetKeys.filter(key => typeof key === 'string' && key.startsWith('sheet_'))));
  }

  const keys = new Set<string>();
  [beforeData, afterData].forEach(data => {
    if (!data || typeof data !== 'object') return;
    Object.keys(data).forEach(key => {
      if (key.startsWith('sheet_')) keys.add(key);
    });
  });
  return Array.from(keys);
}

function protectAgainstAccidentalEmptyAfterData_ACU(options: {
  beforeData: TableDataObject_ACU | null;
  afterData: TableDataObject_ACU | null;
  targetSheetKeys: string[] | null;
  allowClearingTargetSheets: boolean;
}): TableDataObject_ACU | null {
  const { beforeData, afterData, targetSheetKeys, allowClearingTargetSheets } = options;
  if (allowClearingTargetSheets) return afterData;
  if (!beforeData || typeof beforeData !== 'object') return afterData;

  const keysToCheck = resolveTargetSheetKeysForPersistence_ACU(targetSheetKeys, beforeData, afterData);
  if (keysToCheck.length === 0) return afterData;

  let protectedAfterData = afterData ? cloneTableDataForPersistence_ACU(afterData)! : cloneTableDataForPersistence_ACU(beforeData)!;
  let protectedCount = 0;

  for (const sheetKey of keysToCheck) {
    const beforeSheet = (beforeData as any)[sheetKey];
    const afterSheet = (protectedAfterData as any)[sheetKey];
    if (!sheetHasRealRowsForPersistence_ACU(beforeSheet)) continue;
    if (!sheetIsMissingOrEmptyForPersistence_ACU(afterSheet)) continue;

    (protectedAfterData as any)[sheetKey] = JSON.parse(JSON.stringify(beforeSheet));
    protectedCount++;
  }

  if (protectedCount > 0) {
    logWarn_ACU(`[TablePersistence] 阻止 ${protectedCount} 张目标表的异常空快照落盘；如需合法清空，请显式传入 allowClearingTargetSheets。`);
  }

  return protectedAfterData;
}

export async function persistTablesToChatMessage_ACU(
  options: TableChatPersistOptions_ACU = {},
): Promise<{ saved: boolean; messageIndex?: number; error?: string }> {
  const {
    targetMessageIndex = -1,
    targetSheetKeys = null,
    updateGroupKeys = null,
    trackingSheetKeys = targetSheetKeys,
    trackAsUpdate = true,
    beforeData = undefined,
    afterData = undefined,
    allowClearingTargetSheets = false,
  } = options;

/**
 * 保存独立表格数据到聊天记录。
 * 返回 { saved: boolean, messageIndex?: number, error?: string }
 * 注意：不再内部调用 refreshMergedDataAndNotify，调用方按需自行刷新。
 */
  const _skipPostRefresh = false;
  if (!currentJsonTableData_ACU) {
    logError_ACU('Save aborted: currentJsonTableData_ACU is null.');
    return { saved: false, error: 'currentJsonTableData is null' };
  }

  const chat = getChatArray_ACU();
  if (!chat || chat.length === 0) {
    logError_ACU('Save failed: Chat history is empty.');
    return { saved: false, error: 'chat history is empty' };
  }

  let targetMessage: any = null;
  let finalIndex = -1;

  if (targetMessageIndex !== -1 && chat[targetMessageIndex] && !chat[targetMessageIndex].is_user) {
    targetMessage = chat[targetMessageIndex];
    finalIndex = targetMessageIndex;
  } else {
    for (let i = chat.length - 1; i >= 0; i--) {
      if (!chat[i].is_user) {
        targetMessage = chat[i];
        finalIndex = i;
        break;
      }
    }
  }

  if (!targetMessage) {
    logWarn_ACU('Save failed: No AI message found.');
    return { saved: false, error: 'no AI message found' };
  }

  const currentIsolationKey = getCurrentIsolationKey_ACU();

  try {
    const existingGuide = getChatSheetGuideDataForIsolationKey_ACU(currentIsolationKey);
    if (!existingGuide || !Object.keys(existingGuide).some(k => k.startsWith('sheet_'))) {
      const templateObjForSeed = parseTableTemplateJson_ACU({ stripSeedRows: false });
      const guideData = buildChatSheetGuideDataFromData_ACU(currentJsonTableData_ACU, {
        preserveSeedRowsFromGuideData: null,
        seedRowsFromTemplateObj: templateObjForSeed,
      });
      if (guideData && Object.keys(guideData).some(k => k.startsWith('sheet_'))) {
        setChatSheetGuideDataForIsolationKey_ACU(currentIsolationKey, guideData, { reason: 'first_fill' });
        logDebug_ACU(`[SheetGuide] Created chat sheet guide for tag [${currentIsolationKey || '无标签'}] (tables=${Object.keys(guideData).filter(k => k.startsWith('sheet_')).length}).`);
      }
    }
  } catch (e) {
    logWarn_ACU('[SheetGuide] Failed to create sheet guide on first fill:', e);
  }

  const isolatedData = cloneIsolatedData_ACU(targetMessage);

  if (!isolatedData[currentIsolationKey]) {
    isolatedData[currentIsolationKey] = {
      independentData: {},
      modifiedKeys: [],
      updateGroupKeys: [],
    };
  }

  const currentTagData = isolatedData[currentIsolationKey];
  currentTagData.independentData = {};

  let keysToSave: string[] = targetSheetKeys as string[];

  if (!keysToSave) {
    keysToSave = getSortedSheetKeys_ACU(currentJsonTableData_ACU);
  }

  const trackingKeySet = new Set(
    Array.isArray(trackingSheetKeys)
      ? trackingSheetKeys.filter((sheetKey): sheetKey is string => typeof sheetKey === 'string' && sheetKey.length > 0)
      : []
  );
  const actuallyModifiedKeys = keysToSave.filter(sheetKey => trackingKeySet.has(sheetKey));

  if (trackAsUpdate && actuallyModifiedKeys.length > 0) {
    const existingModifiedKeys = currentTagData.modifiedKeys || [];
    currentTagData.modifiedKeys = [...new Set([...existingModifiedKeys, ...actuallyModifiedKeys])];
    logDebug_ACU(`[Tracking] Recorded modified keys for tag [${currentIsolationKey || '无标签'}] at index ${finalIndex}: ${currentTagData.modifiedKeys.join(', ')}`);
  }

  if (trackAsUpdate && updateGroupKeys && updateGroupKeys.length > 0 && actuallyModifiedKeys.length > 0) {
    const existingGroupKeys = currentTagData.updateGroupKeys || [];
    currentTagData.updateGroupKeys = [...new Set([...existingGroupKeys, ...updateGroupKeys])];
    logDebug_ACU(`[Merge Update Success] Group keys for tag [${currentIsolationKey || '无标签'}] recorded at index ${finalIndex}: ${currentTagData.updateGroupKeys.join(', ')}`);
  } else if (trackAsUpdate && updateGroupKeys && updateGroupKeys.length > 0 && actuallyModifiedKeys.length === 0) {
    logDebug_ACU(`[Merge Update Failed] No tables were modified for tag [${currentIsolationKey || '无标签'}]. Group keys NOT recorded: ${updateGroupKeys.join(', ')}`);
  }

  const isolationConfig = {
    enabled: settings_ACU.dataIsolationEnabled,
    code: settings_ACU.dataIsolationCode,
  };
  const resolvedBeforeData = beforeData !== undefined
    ? beforeData
    : reconstructTablesFromChatDeltas_ACU(chat, {
      isolationKey: currentIsolationKey,
      isolationConfig,
    }, {
      targetMessageIndexExclusive: finalIndex,
      saveChatAfterMigration: false,
    }).data;
  const resolvedAfterDataRaw = afterData !== undefined
    ? afterData
    : (JSON.parse(JSON.stringify(currentJsonTableData_ACU)) as TableDataObject_ACU);
  const resolvedAfterData = protectAgainstAccidentalEmptyAfterData_ACU({
    beforeData: resolvedBeforeData,
    afterData: resolvedAfterDataRaw,
    targetSheetKeys: Array.isArray(targetSheetKeys) ? targetSheetKeys : null,
    allowClearingTargetSheets,
  });

  const baseCheckpoint = reconstructTablesFromChatDeltas_ACU(chat, {
    isolationKey: currentIsolationKey,
    isolationConfig,
  }, {
    targetMessageIndexExclusive: finalIndex + 1,
    allowLegacyMigration: false,
    saveChatAfterMigration: false,
  }).checkpoint;

  const delta = createTableDeltaFromBeforeAfter_ACU({
    before: resolvedBeforeData,
    after: resolvedAfterData,
    targetSheetKeys: keysToSave,
    modifiedKeys: trackAsUpdate ? actuallyModifiedKeys : [],
    updateGroupKeys: trackAsUpdate && actuallyModifiedKeys.length > 0 ? (updateGroupKeys || []) : [],
    isolationKey: currentIsolationKey,
    targetMessageIndex: finalIndex,
    baseCheckpointId: baseCheckpoint?.checkpointId,
  });

  const existingPersistenceLayer = currentTagData.tablePersistenceV2;
  if (delta) {
    currentTagData.tablePersistenceV2 = appendTablePersistenceDeltaToLayerV2_ACU(
      existingPersistenceLayer,
      delta,
    );
  } else if (!existingPersistenceLayer?.checkpoint && !hasTablePersistenceDeltasV2_ACU(existingPersistenceLayer)) {
    delete currentTagData.tablePersistenceV2;
  }

  writeIsolatedTagData_ACU(targetMessage, currentIsolationKey, currentTagData);

  if (currentTagData.tablePersistenceV2) {
    writeTablePersistenceLayerV2_ACU(targetMessage, currentIsolationKey, currentTagData.tablePersistenceV2!);
  }

  writeMessageIdentity_ACU(targetMessage, isolationConfig);
  clearCurrentIsolationLegacyTableSnapshots_ACU(targetMessage, currentIsolationKey, isolationConfig);

  logDebug_ACU(`Saved ${keysToSave.length} tables for tag [${currentIsolationKey || '无标签'}] to message at index ${finalIndex}. Actually modified: ${actuallyModifiedKeys.length} tables. Delta written: ${!!delta}.`);

  await saveChatToHost_ACU();

  return { saved: true, messageIndex: finalIndex };
}

/**
 * 保存独立表格数据到聊天记录。
 * 返回 { saved: boolean, messageIndex?: number, error?: string }
 * 注意：不再内部调用 refreshMergedDataAndNotify，调用方按需自行刷新。
 */
export async function saveIndependentTableToChatHistory_ACU(
  options: TableChatPersistOptions_ACU,
): Promise<{ saved: boolean; messageIndex?: number; error?: string }>;
export async function saveIndependentTableToChatHistory_ACU(
  targetMessageIndex?: number,
  targetSheetKeys?: string[] | null,
  updateGroupKeys?: string[] | null,
  _skipPostRefresh?: boolean,
  trackingSheetKeys?: string[] | null,
): Promise<{ saved: boolean; messageIndex?: number; error?: string }>;
export async function saveIndependentTableToChatHistory_ACU(
  targetMessageIndexOrOptions: number | TableChatPersistOptions_ACU = -1,
  targetSheetKeys: string[] | null = null,
  updateGroupKeys: string[] | null = null,
  _skipPostRefresh = false,
  trackingSheetKeys: string[] | null = targetSheetKeys,
): Promise<{ saved: boolean; messageIndex?: number; error?: string }> {
  if (typeof targetMessageIndexOrOptions === 'object' && targetMessageIndexOrOptions !== null) {
    return persistTablesToChatMessage_ACU({
      trackAsUpdate: true,
      ...targetMessageIndexOrOptions,
    });
  }

  const targetMessageIndex = typeof targetMessageIndexOrOptions === 'number'
    ? targetMessageIndexOrOptions
    : -1;

  return persistTablesToChatMessage_ACU({
    targetMessageIndex,
    targetSheetKeys,
    updateGroupKeys,
    trackingSheetKeys,
    trackAsUpdate: true,
  });
}

/**
 * 检查当前聊天是否为首次初始化（无任何已有表格数据）。
 */
export async function checkIfFirstTimeInit_ACU(): Promise<boolean> {
  const chat = getChatArray_ACU();
  if (!chat || chat.length === 0) return true;

  const currentIsolationKey = getCurrentIsolationKey_ACU();

  for (let i = chat.length - 1; i >= 0; i--) {
    const message = chat[i];
    if (message.is_user) continue;

    const tagData = readIsolatedTagData_ACU(message, currentIsolationKey);
    if (tagData?.independentData && Object.keys(tagData.independentData).some(k => k.startsWith('sheet_'))) {
      return false;
    }

    const isolationConfig = { enabled: settings_ACU.dataIsolationEnabled, code: settings_ACU.dataIsolationCode };
    if (isLegacyMatchForIsolation_ACU(message, isolationConfig)) {
      const legacyIndep = readLegacyIndependentData_ACU(message);
      if (legacyIndep && Object.keys(legacyIndep).some(k => k.startsWith('sheet_'))) {
        return false;
      }
    }
  }

  return true;
}

/**
 * 从模板初始化数据库到内存（不写聊天记录）。
 * 返回 { initialized: boolean, error?: string }
 */
async function initializeJsonTableInChatHistory_ACU(): Promise<{ initialized: boolean; error?: string }> {
  logDebug_ACU('No database found in chat history. Initializing a new one from template.');

  try {
    _set_currentJsonTableData_ACU(parseTableTemplateJson_ACU({ stripSeedRows: true }));
    logDebug_ACU('Successfully initialized database in memory.');
  } catch (error) {
    logError_ACU('Failed to parse template and initialize database in memory:', error);
    _set_currentJsonTableData_ACU(null);
    return { initialized: false, error: '从模板解析数据库失败，请检查模板格式。' };
  }
  if (!currentJsonTableData_ACU) {
    return { initialized: false, error: '从模板解析数据库失败，请检查模板格式。' };
  }

  logDebug_ACU('Database initialized in memory. It will be saved to chat history on the first update.');

  try {
    const guideData = await ensureChatSheetGuideSeeded_ACU({ reason: 'init_chat_seedrows' });
    if (guideData) {
      attachSeedRowsToCurrentDataFromGuide_ACU(guideData);
    }
  } catch (e) {
    logWarn_ACU('[SheetGuide] Failed to ensure sheet guide during initialization:', e);
  }

  try {
    await deleteAllGeneratedEntries_ACU();
    logDebug_ACU('Deleted all generated lorebook entries during initialization.');
  } catch (deleteError) {
    logWarn_ACU('Failed to delete generated lorebook entries during initialization:', deleteError);
  }

  return { initialized: true };
}

/**
 * 从聊天记录加载或创建表格数据到内存。
 * 返回 { loaded: boolean, source: 'merged'|'initialized'|'empty', error?: string }
 * 注意：不再内部调用 refreshMergedDataAndNotify，调用方按需自行刷新。
 */
export async function loadOrCreateJsonTableFromChatHistory_ACU(): Promise<{
  loaded: boolean;
  source: 'merged' | 'initialized' | 'empty';
  error?: string;
}> {
  _set_currentJsonTableData_ACU(null);
  logDebug_ACU('Attempting to load database from chat history...');

  const chat = getChatArray_ACU();
  applyTemplateScopeForCurrentChat_ACU();
  if (!chat || chat.length === 0) {
    logDebug_ACU('Chat history is empty. Initializing new database.');
    const initResult = await initializeJsonTableInChatHistory_ACU();
    return { loaded: initResult.initialized, source: 'initialized', error: initResult.error };
  }

  const mergedData = await mergeAllIndependentTables_ACU();

  if (mergedData) {
    _set_currentJsonTableData_ACU(mergedData);
    logDebug_ACU('Database content successfully merged (tag-aware) and loaded into memory.');
    return { loaded: true, source: 'merged' };
  }

  logDebug_ACU('No database found for current tag in chat history. Initializing a new one.');
  const initResult = await initializeJsonTableInChatHistory_ACU();
  return { loaded: initResult.initialized, source: 'initialized', error: initResult.error };
}
