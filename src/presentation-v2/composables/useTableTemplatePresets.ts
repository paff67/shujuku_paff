import { computed, ref } from 'vue';
import {
  applyTemplatePresetToCurrent_ACU,
  deleteTemplatePreset_ACU,
  ensureUniqueTemplatePresetName_ACU,
  getDefaultTemplateSnapshot_ACU,
  getTemplatePreset_ACU,
  listTemplatePresetNames_ACU,
  normalizeTemplateForPresetSave_ACU,
  parseImportedTemplateData_ACU,
  resolveActiveTemplatePresetName_ACU,
  resolveTemplateForExport_ACU,
  upsertTemplatePreset_ACU,
} from '../../service/template/template-preset-service';
import {
  listChatTemplatePresetEntries_ACU,
  sanitizeChatSheetsObject_ACU,
} from '../../service/template/chat-scope';
import { settings_ACU } from '../../service/runtime/state-manager';
import { safeJsonParse_ACU } from '../../shared/json-helpers';
import { getCurrentTemplatePresetName_ACU, normalizeTemplatePresetSelectionValue_ACU, sanitizeFilenameComponent_ACU } from '../../shared/template-preset-utils';
import { deriveTemplatePresetNameForImport_ACU } from '../../shared/template-preset-utils';
import { useToastStore } from '../stores/toast-store';

export type TemplateScope = 'global' | 'chat';

type MessageKind = 'success' | 'error' | 'info' | 'warning';

function defaultPresetItem(label: string, meta?: string) {
  return { value: '', label, meta };
}

function countTemplateSheets(templateSource: unknown): number | null {
  const templateObj = typeof templateSource === 'string'
    ? safeJsonParse_ACU(templateSource, null)
    : templateSource;
  if (!templateObj || typeof templateObj !== 'object' || Array.isArray(templateObj)) return null;
  const count = Object.keys(templateObj).filter(key => key.startsWith('sheet_')).length;
  return count > 0 ? count : null;
}

function formatSheetCountMeta(templateSource: unknown): string | undefined {
  const count = countTemplateSheets(templateSource);
  return count ? `${count} 张表` : undefined;
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => resolve(String(event.target?.result || ''));
    reader.onerror = () => reject(new Error('读取模板文件失败'));
    reader.readAsText(file, 'UTF-8');
  });
}

function downloadJson(jsonData: Record<string, any>, filename: string): void {
  const blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function useTableTemplatePresets() {
  const toast = useToastStore();
  const busy = ref(false);
  const message = ref<{ kind: MessageKind; text: string } | null>(null);
  const globalPresetNames = ref<string[]>([]);
  const chatPresetEntries = ref<any[]>([]);
  const selectedGlobalPreset = ref('');
  const selectedChatPreset = ref('');
  const chatPresetItems = ref<Array<{ value: string; label: string; meta?: string }>>([]);

  const isChatOverridden = computed(() => selectedChatPreset.value !== selectedGlobalPreset.value);

  function buildChatPresetItems(
    globalNames: string[],
    chatEntries: any[],
    currentGlobalPreset: string,
  ): Array<{ value: string; label: string; meta?: string }> {
    const seen = new Set(['']);
    const defaultSnapshot = currentGlobalPreset ? null : getDefaultTemplateSnapshot_ACU();
    const currentGlobalTemplateSource = currentGlobalPreset
      ? getTemplatePreset_ACU(currentGlobalPreset)?.templateStr
      : (defaultSnapshot?.templateObj || defaultSnapshot?.templateStr);
    const items = [defaultPresetItem('默认预设', formatSheetCountMeta(currentGlobalTemplateSource))];
    for (const name of globalNames) {
      const normalized = normalizeTemplatePresetSelectionValue_ACU(name);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      items.push({ value: normalized, label: normalized, meta: formatSheetCountMeta(getTemplatePreset_ACU(normalized)?.templateStr) });
    }
    for (const entry of chatEntries) {
      const normalized = normalizeTemplatePresetSelectionValue_ACU(entry?.presetName || '');
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      items.push({ value: normalized, label: normalized, meta: formatSheetCountMeta(entry?.templateStr) });
    }
    return items;
  }

  function refresh(): void {
    const nextGlobalNames = listTemplatePresetNames_ACU();
    const nextChatEntries = listChatTemplatePresetEntries_ACU();
    const nextSelectedGlobal = normalizeTemplatePresetSelectionValue_ACU(
      getCurrentTemplatePresetName_ACU(settings_ACU, { requireExisting: false }),
    );
    const nextSelectedChat = normalizeTemplatePresetSelectionValue_ACU(
      resolveActiveTemplatePresetName_ACU({ fallbackToGlobal: true }),
    );

    globalPresetNames.value = nextGlobalNames;
    chatPresetEntries.value = nextChatEntries;
    selectedGlobalPreset.value = nextSelectedGlobal;
    selectedChatPreset.value = nextSelectedChat;
    chatPresetItems.value = buildChatPresetItems(
      nextGlobalNames,
      nextChatEntries,
      nextSelectedGlobal,
    );
  }

  async function run<T>(action: () => Promise<T> | T): Promise<T | null> {
    busy.value = true;
    message.value = null;
    try {
      return await action();
    } catch (error: any) {
      const text = error?.message || '操作失败。';
      message.value = { kind: 'error', text };
      toast.error(text);
      return null;
    } finally {
      busy.value = false;
      refresh();
    }
  }

  async function selectGlobalPreset(name: string): Promise<void> {
    const normalized = normalizeTemplatePresetSelectionValue_ACU(name);
    await run(async () => {
      const result = await applyTemplatePresetToCurrent_ACU(normalized, {
        source: 'v2_table_global_select',
        updateGlobal: true,
        save: true,
        persistChatScope: false,
      });
      if (!result) throw new Error('全局模板预设切换失败。');
      message.value = null;
    });
  }

  async function selectChatPreset(name: string): Promise<void> {
    const normalized = normalizeTemplatePresetSelectionValue_ACU(name);
    await run(async () => {
      const result = await applyTemplatePresetToCurrent_ACU(normalized, {
        source: 'v2_table_chat_select',
        updateGlobal: false,
        save: true,
        persistChatScope: true,
      });
      if (!result) throw new Error('当前聊天模板预设切换失败。');
      message.value = null;
    });
  }

  async function saveGlobalAs(): Promise<void> {
    const current = selectedGlobalPreset.value;
    const raw = window.prompt('另存为全局模板预设名称：', current ? `${current}_副本` : '新模板预设');
    if (!raw) return;
    const requested = raw.trim();
    if (!requested) return;
    await run(async () => {
      const normalizedTemplate = normalizeTemplateForPresetSave_ACU();
      if (!normalizedTemplate) throw new Error('无法解析当前模板。');
      const finalName = ensureUniqueTemplatePresetName_ACU(requested);
      if (finalName !== requested && !window.confirm(`预设名已存在，将自动另存为「${finalName}」。是否继续？`)) return;
      if (!upsertTemplatePreset_ACU(finalName, normalizedTemplate.templateStr)) throw new Error('无法写入全局模板预设。');
      const result = await applyTemplatePresetToCurrent_ACU(finalName, {
        source: 'v2_table_global_save_as',
        updateGlobal: true,
        save: true,
        persistChatScope: false,
      });
      if (!result) throw new Error('另存后切换全局模板预设失败。');
      message.value = null;
      toast.success(`已另存为全局模板预设「${finalName}」。`);
    });
  }

  async function renameGlobalPreset(): Promise<void> {
    const oldName = selectedGlobalPreset.value;
    if (!oldName) {
      message.value = { kind: 'warning', text: '默认预设不能重命名。' };
      return;
    }
    const preset = getTemplatePreset_ACU(oldName);
    if (!preset?.templateStr) {
      message.value = { kind: 'warning', text: '找不到当前选中的全局模板预设。' };
      return;
    }
    const raw = window.prompt(`将全局模板预设「${oldName}」重命名为：`, oldName);
    if (!raw) return;
    const newName = raw.trim();
    if (!newName) return;
    await run(async () => {
      if (!upsertTemplatePreset_ACU(newName, preset.templateStr)) throw new Error('重命名全局模板预设失败。');
      if (newName !== oldName) deleteTemplatePreset_ACU(oldName);
      if (selectedGlobalPreset.value === oldName) {
        const result = await applyTemplatePresetToCurrent_ACU(newName, {
          source: 'v2_table_global_rename',
          updateGlobal: true,
          save: true,
          persistChatScope: false,
        });
        if (!result) throw new Error('重命名后切换全局模板预设失败。');
      }
      message.value = null;
    });
  }

  async function deleteGlobalPreset(): Promise<void> {
    const name = selectedGlobalPreset.value;
    if (!name) {
      message.value = { kind: 'warning', text: '默认预设不能删除。' };
      return;
    }
    if (!window.confirm(`确定要删除全局模板预设「${name}」吗？此操作不可撤销。`)) return;
    await run(() => {
      if (!deleteTemplatePreset_ACU(name)) throw new Error('删除失败或全局模板预设不存在。');
      message.value = null;
    });
  }

  async function importPresetForCurrentChat(file: File): Promise<void> {
    await run(async () => {
      const content = await readFileText(file);
      const prepared = parseImportedTemplateData_ACU(content);
      const baseName = deriveTemplatePresetNameForImport_ACU({
        filename: file.name,
        fallbackLabel: `导入模板_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
      });
      if (!baseName) throw new Error('无法确定导入预设名称。');
      const finalName = ensureUniqueTemplatePresetName_ACU(baseName);
      if (!upsertTemplatePreset_ACU(finalName, prepared.templateStr)) throw new Error('模板已解析，但保存到预设库失败。');
      const result = await applyTemplatePresetToCurrent_ACU(finalName, {
        source: 'v2_table_import_current',
        updateGlobal: false,
        save: true,
        persistChatScope: true,
      });
      if (!result) throw new Error('模板已保存，但切换到当前聊天失败。');
      message.value = null;
      toast.success(`模板已保存并切换为「${finalName}」。`, { muteable: false });
    });
  }

  function exportTemplate(scope: TemplateScope): void {
    const selectedPresetName = scope === 'global' ? selectedGlobalPreset.value : selectedChatPreset.value;
    const resolved = resolveTemplateForExport_ACU(scope, selectedPresetName);
    if (!resolved) {
      const text = '无法解析当前模板。';
      message.value = { kind: 'error', text };
      toast.error(text);
      return;
    }
    const sanitized = sanitizeChatSheetsObject_ACU(resolved.jsonData, { ensureMate: true });
    const safeName = sanitizeFilenameComponent_ACU(resolved.fromPresetName) || 'template';
    const filename = scope === 'global'
      ? `TavernDB_template_${safeName}.json`
      : `TavernDB_template_chat_${safeName}.json`;
    downloadJson(sanitized, filename);
    message.value = null;
    toast.success(scope === 'global' ? '全局模板已导出。' : '当前聊天模板已导出。');
  }

  refresh();

  return {
    busy,
    message,
    selectedGlobalPreset,
    selectedChatPreset,
    isChatOverridden,
    chatPresetItems,
    refresh,
    selectGlobalPreset,
    selectChatPreset,
    saveGlobalAs,
    renameGlobalPreset,
    deleteGlobalPreset,
    importPresetForCurrentChat,
    exportTemplate,
  };
}
