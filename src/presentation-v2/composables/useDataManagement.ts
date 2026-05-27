/**
 * useDataManagement — 数据管理页业务流编排
 *
 * v2 页面只依赖本 composable；旧 settings / chat / worldbook / template service
 * 调用集中在这里，避免 Vue 组件跨进旧 presentation 层。
 */
import { computed, reactive, ref } from 'vue';
import {
  DEFAULT_CHAR_CARD_PROMPT_ACU,
  DEFAULT_CHAR_CARD_PROMPT_SQL_ACU,
  DEFAULT_MERGE_SUMMARY_PROMPT_ACU,
  DEFAULT_MERGE_SUMMARY_PROMPT_SQL_ACU,
} from '../../shared/defaults-json.js';
import { normalizeIsolationCode_ACU } from '../../shared/data-constants';
import { ensureSheetOrderNumbers_ACU, logError_ACU, parseTableTemplateJson_ACU } from '../../shared/utils';
import { currentChatFileIdentifier_ACU, currentJsonTableData_ACU, settings_ACU } from '../../service/runtime/state-manager';
import {
  applyTemplateScopeForCurrentChat_ACU,
  applyCombinedSettingsImport_ACU,
  getDataIsolationHistory_ACU,
  removeDataIsolationHistory_ACU,
  saveSettings_ACU,
  switchIsolationProfile_ACU,
} from '../../service/settings/settings-service';
import { isSqliteMode } from '../../service/table/storage-mode';
import { getChatArray_ACU, deleteLocalDataInChatCore_ACU, overrideLatestLayerWithTemplateCore_ACU } from '../../service/chat/chat-service';
import { loadOrCreateJsonTableFromChatHistory_ACU } from '../../service/table/table-service';
import { cleanupWorldbookEntriesAfterDataDeletion_ACU } from '../../service/worldbook/worldbook-cleanup';
import { deleteAllGeneratedEntries_ACU, refreshMergedDataAndNotify_ACU } from '../../service/worldbook/pipeline';
import { applyTemplateSnapshotToScope_ACU, getDefaultTemplateSnapshot_ACU } from '../../service/template/template-preset-service';
import { sanitizeChatSheetsObject_ACU } from '../../service/template/chat-scope';
import { useToastStore } from '../stores/toast-store';

export type DataMgmtMessageKind = 'info' | 'success' | 'warning' | 'error';

export interface DataMgmtMessage {
  kind: DataMgmtMessageKind;
  text: string;
  at: number;
}

function setMessage(target: ReturnType<typeof ref<DataMgmtMessage | null>>, kind: DataMgmtMessageKind, text: string): void {
  target.value = { kind, text, at: Date.now() };
}

function normalizeFloorValue(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function normalizeRetainRecentLayers(value: unknown): number {
  if (value === '' || value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

async function readFileText(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
    reader.readAsText(file, 'UTF-8');
  });
}

function downloadJson(filename: string, data: unknown): void {
  const jsonString = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function getAiMessageCount(): number {
  const chat = getChatArray_ACU();
  return Array.isArray(chat) ? chat.filter((msg: any) => !msg?.is_user).length : 0;
}

function buildCombinedExportPayload(): Record<string, unknown> {
  const templateObj = parseTableTemplateJson_ACU({ stripSeedRows: false });
  if (!templateObj || typeof templateObj !== 'object') {
    throw new Error('无法解析当前模板。');
  }

  const sheetKeys = Object.keys(templateObj).filter(k => k.startsWith('sheet_'));
  ensureSheetOrderNumbers_ACU(templateObj, { baseOrderKeys: sheetKeys, forceRebuild: false });
  const templateData = sanitizeChatSheetsObject_ACU(templateObj, { ensureMate: true });

  return {
    prompt: Array.isArray(settings_ACU.charCardPrompt) ? settings_ACU.charCardPrompt : [],
    template: templateData,
    mergeSummaryPrompt: settings_ACU.mergeSummaryPrompt || (isSqliteMode() ? DEFAULT_MERGE_SUMMARY_PROMPT_SQL_ACU : DEFAULT_MERGE_SUMMARY_PROMPT_ACU),
    mergeTargetCount: settings_ACU.mergeTargetCount || 1,
    mergeBatchSize: settings_ACU.mergeBatchSize || 5,
    mergeStartIndex: settings_ACU.mergeStartIndex || 1,
    mergeEndIndex: settings_ACU.mergeEndIndex || null,
    autoMergeEnabled: settings_ACU.autoMergeEnabled || false,
    autoMergeThreshold: settings_ACU.autoMergeThreshold || 20,
    autoMergeReserve: settings_ACU.autoMergeReserve || 0,
    deleteStartFloor: settings_ACU.deleteStartFloor || null,
    deleteEndFloor: settings_ACU.deleteEndFloor || null,
  };
}

export function useDataManagement() {
  const toast = useToastStore();
  const message = ref<DataMgmtMessage | null>(null);
  const busyAction = ref('');
  const isolationCode = ref('');
  const activeIsolationCode = ref('');
  const isolationHistory = ref<string[]>([]);
  const deleteRange = reactive({
    startFloor: 1 as number | string,
    endFloor: '' as number | string,
  });
  const retainRecentLayers = ref(100);
  const aiMessageCount = ref(0);

  const currentIsolationLabel = computed(() => {
    const code = activeIsolationCode.value;
    return code || '默认数据（未隔离）';
  });
  const isolationModeLabel = computed(() => (activeIsolationCode.value ? '已启用隔离' : '未启用隔离'));
  const isolationHistoryOptions = computed(() =>
    isolationHistory.value.map(code => ({ value: code, label: code })),
  );
  const rangeLabel = computed(() => {
    const start = normalizeFloorValue(deleteRange.startFloor);
    const end = normalizeFloorValue(deleteRange.endFloor);
    if (start && end) return `第 ${start} 到 ${end} 个 AI 楼层`;
    if (start) return `从第 ${start} 个 AI 楼层开始`;
    if (end) return `到第 ${end} 个 AI 楼层结束`;
    return '全部 AI 楼层';
  });
  const tableCount = computed(() =>
    currentJsonTableData_ACU && typeof currentJsonTableData_ACU === 'object'
      ? Object.keys(currentJsonTableData_ACU).filter(key => key.startsWith('sheet_')).length
      : 0,
  );

  function refresh(): void {
    const currentCode = normalizeIsolationCode_ACU(settings_ACU.dataIsolationCode || '');
    activeIsolationCode.value = currentCode;
    isolationCode.value = currentCode;
    isolationHistory.value = getDataIsolationHistory_ACU();
    deleteRange.startFloor = settings_ACU.deleteStartFloor || 1;
    deleteRange.endFloor = settings_ACU.deleteEndFloor || '';
    retainRecentLayers.value = normalizeRetainRecentLayers(settings_ACU.retainRecentLayers ?? 100);
    aiMessageCount.value = getAiMessageCount();
  }

  async function applyIsolation(): Promise<void> {
    const targetCode = normalizeIsolationCode_ACU(isolationCode.value);
    busyAction.value = 'apply-isolation';
    try {
      await switchIsolationProfile_ACU(targetCode);
      refresh();
      activeIsolationCode.value = targetCode;
      isolationCode.value = targetCode;
      isolationHistory.value = getDataIsolationHistory_ACU();
      message.value = null;
      toast.success(`已切换到 ${targetCode || '默认数据（未隔离）'}。`);
    } catch (e: any) {
      logError_ACU('[ACU-V2] applyIsolation failed', e);
      message.value = null;
      toast.error('切换隔离标识失败，详情见运行日志。');
    } finally {
      busyAction.value = '';
    }
  }

  async function removeHistory(code: string): Promise<void> {
    const target = normalizeIsolationCode_ACU(code);
    if (!target) return;
    busyAction.value = 'remove-history';
    try {
      const wasActive = target === activeIsolationCode.value;
      if (wasActive) {
        await switchIsolationProfile_ACU('');
      }
      removeDataIsolationHistory_ACU(target);
      refresh();
      if (wasActive) {
        activeIsolationCode.value = '';
        isolationCode.value = '';
        isolationHistory.value = getDataIsolationHistory_ACU();
        message.value = null;
        toast.success(`已从历史记录移除标识：${target}；当前已切换到默认数据（未隔离）。`);
      } else {
        message.value = null;
        toast.success(`已从历史记录移除标识：${target}`);
      }
    } catch (e: any) {
      logError_ACU('[ACU-V2] removeHistory failed', e);
      message.value = null;
      toast.error('移除历史标识失败，详情见运行日志。');
    } finally {
      busyAction.value = '';
    }
  }

  async function deleteCurrentIsolationEntries(): Promise<void> {
    busyAction.value = 'delete-isolation-entries';
    try {
      await deleteAllGeneratedEntries_ACU();
      message.value = null;
      toast.success('已删除当前标识对应的数据库注入条目。');
    } catch (e: any) {
      logError_ACU('[ACU-V2] deleteCurrentIsolationEntries failed', e);
      message.value = null;
      toast.error('删除注入条目失败，详情见运行日志。');
    } finally {
      busyAction.value = '';
    }
  }

  async function importCombinedSettings(file: File): Promise<void> {
    busyAction.value = 'import-combined';
    try {
      const text = await readFileText(file);
      const combinedData = JSON.parse(text);
      if (!Array.isArray(combinedData?.prompt)) throw new Error('"prompt" 的值必须是数组。');
      if (!combinedData?.template || typeof combinedData.template !== 'object') throw new Error('缺少有效的 "template" 对象。');

      applyCombinedSettingsImport_ACU(combinedData);
      const applied = await applyTemplateSnapshotToScope_ACU(combinedData.template, {
        scope: 'global',
        source: 'v2_import_combined',
        presetName: '',
        save: true,
        persistChatScope: false,
      });
      if (!applied) throw new Error('模板结构无效，无法应用到当前全局模板。');
      refresh();
      message.value = null;
      toast.success('合并配置已导入：提示词、合并设置和全局模板已更新。', { muteable: false });
    } catch (e: any) {
      logError_ACU('[ACU-V2] importCombinedSettings failed', e);
      setMessage(message, 'error', `合并导入失败：${e?.message || '未知错误'}`);
    } finally {
      busyAction.value = '';
    }
  }

  function exportCombinedSettings(): void {
    try {
      const payload = buildCombinedExportPayload();
      downloadJson('TavernDB_Combined_Settings.json', payload);
      message.value = null;
      toast.success('合并配置已导出。');
    } catch (e: any) {
      logError_ACU('[ACU-V2] exportCombinedSettings failed', e);
      message.value = null;
      toast.error('合并配置导出失败，详情见运行日志。');
    }
  }

  function exportJsonData(): void {
    if (!currentJsonTableData_ACU) {
      message.value = null;
      toast.warning('没有可导出的数据库。请先开始一个对话或加载当前聊天数据。');
      return;
    }
    try {
      const sanitized = sanitizeChatSheetsObject_ACU(currentJsonTableData_ACU, { ensureMate: true });
      const chatName = String(currentChatFileIdentifier_ACU || 'current_chat').replace(/[\\/:*?"<>|]+/g, '_');
      downloadJson(`TavernDB_data_${chatName}.json`, sanitized);
      message.value = null;
      toast.success('当前聊天数据库 JSON 已导出。');
    } catch (e: any) {
      logError_ACU('[ACU-V2] exportJsonData failed', e);
      message.value = null;
      toast.error('导出 JSON 失败，详情见运行日志。');
    }
  }

  async function resetAllDefaults(): Promise<void> {
    busyAction.value = 'reset-defaults';
    try {
      settings_ACU.charCardPrompt = isSqliteMode() ? DEFAULT_CHAR_CARD_PROMPT_SQL_ACU : DEFAULT_CHAR_CARD_PROMPT_ACU;
      settings_ACU.mergeSummaryPrompt = isSqliteMode() ? DEFAULT_MERGE_SUMMARY_PROMPT_SQL_ACU : DEFAULT_MERGE_SUMMARY_PROMPT_ACU;
      const snapshot = getDefaultTemplateSnapshot_ACU();
      if (!snapshot?.templateStr) throw new Error('无法解析默认模板。');
      const applied = await applyTemplateSnapshotToScope_ACU(snapshot.templateStr, {
        scope: 'global',
        source: 'v2_reset_all_defaults',
        presetName: '',
        save: true,
        persistChatScope: false,
      });
      if (!applied) throw new Error('默认模板应用失败。');
      saveSettings_ACU();
      message.value = null;
      toast.success('默认模板及提示词已恢复。');
    } catch (e: any) {
      logError_ACU('[ACU-V2] resetAllDefaults failed', e);
      message.value = null;
      toast.error('恢复默认失败，详情见运行日志。');
    } finally {
      busyAction.value = '';
    }
  }

  async function overrideLatestLayerWithTemplate(): Promise<void> {
    busyAction.value = 'override-latest';
    try {
      applyTemplateScopeForCurrentChat_ACU();
      const templateData = parseTableTemplateJson_ACU({ stripSeedRows: true });
      if (!templateData) throw new Error('无法解析当前生效模板。');
      const modifiedCount = await overrideLatestLayerWithTemplateCore_ACU(templateData);
      if (modifiedCount > 0) {
        await loadOrCreateJsonTableFromChatHistory_ACU();
        await refreshMergedDataAndNotify_ACU();
        message.value = null;
        toast.success(`已使用当前生效模板覆盖最新 AI 楼层的 ${modifiedCount} 个表格。`, { muteable: false });
      } else {
        message.value = null;
        toast.info('没有找到可覆盖的最新 AI 楼层表格数据。', { muteable: false });
      }
    } catch (e: any) {
      logError_ACU('[ACU-V2] overrideLatestLayerWithTemplate failed', e);
      message.value = null;
      toast.error('模板覆盖失败，详情见运行日志。');
    } finally {
      busyAction.value = '';
    }
  }

  async function deleteLocalData(mode: 'current' | 'all'): Promise<void> {
    busyAction.value = mode === 'current' ? 'delete-current-local' : 'delete-all-local';
    try {
      const start = normalizeFloorValue(deleteRange.startFloor);
      const end = normalizeFloorValue(deleteRange.endFloor);
      settings_ACU.deleteStartFloor = start;
      settings_ACU.deleteEndFloor = end;
      saveSettings_ACU();

      const deletedCount = await deleteLocalDataInChatCore_ACU(mode, start, end);
      if (deletedCount > 0) {
        await loadOrCreateJsonTableFromChatHistory_ACU();
        await refreshMergedDataAndNotify_ACU();
        const worldbookDeleted = await cleanupWorldbookEntriesAfterDataDeletion_ACU();
        refresh();
        setMessage(
          message,
          'success',
          `已删除 ${deletedCount} 条消息中的本地数据${worldbookDeleted ? `，并清理 ${worldbookDeleted} 个世界书条目` : ''}。`,
        );
        const text = message.value?.text || '';
        message.value = null;
        toast.success(text, { muteable: false });
      } else {
        message.value = null;
        toast.info('没有发现符合当前范围的数据。', { muteable: false });
      }
    } catch (e: any) {
      logError_ACU('[ACU-V2] deleteLocalData failed', e);
      message.value = null;
      toast.error('删除本地数据失败，详情见运行日志。');
    } finally {
      busyAction.value = '';
    }
  }

  function setRetainRecentLayers(value: number | string): void {
    const normalized = normalizeRetainRecentLayers(value);
    retainRecentLayers.value = normalized;
    settings_ACU.retainRecentLayers = normalized;
    saveSettings_ACU();
    message.value = null;
  }

  return {
    message,
    busyAction,
    isolationCode,
    isolationHistory,
    isolationHistoryOptions,
    currentIsolationLabel,
    isolationModeLabel,
    deleteRange,
    retainRecentLayers,
    rangeLabel,
    aiMessageCount,
    tableCount,
    refresh,
    applyIsolation,
    removeHistory,
    deleteCurrentIsolationEntries,
    importCombinedSettings,
    exportCombinedSettings,
    exportJsonData,
    resetAllDefaults,
    overrideLatestLayerWithTemplate,
    deleteLocalData,
    setRetainRecentLayers,
  };
}
