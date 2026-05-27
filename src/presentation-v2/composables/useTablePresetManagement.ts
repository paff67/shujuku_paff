/**
 * useTablePresetManagement — 表格模板预设抽屉的状态机
 *
 * 借鉴 usePlotPresetManagement，但表格模板的编辑器是独立窗口（可视化表格编辑器），
 * 抽屉本身只承载管理列表（star / export / edit=打开可视化编辑器 / delete）以及
 * 顶部的「从默认新建 / 导入」操作。
 *
 * 与 useTableTemplatePresets 的关系：本 composable 通过 service 函数直接执行带名字
 * 的操作（删除、导出、设为全局默认、切换 chat 预设）；页面同时使用 useTableTemplatePresets
 * 维持下拉框的当前选中状态与 message。
 */
import { computed, ref } from 'vue';
import {
  applyTemplatePresetToCurrent_ACU,
  deleteTemplatePreset_ACU,
  ensureUniqueTemplatePresetName_ACU,
  getDefaultTemplateSnapshot_ACU,
  getTemplatePreset_ACU,
  listTemplatePresetNames_ACU,
  resolveActiveTemplatePresetName_ACU,
  resolveTemplateForExport_ACU,
  upsertTemplatePreset_ACU,
} from '../../service/template/template-preset-service';
import { sanitizeChatSheetsObject_ACU } from '../../service/template/chat-scope';
import {
  sanitizeFilenameComponent_ACU,
  normalizeTemplatePresetSelectionValue_ACU,
  getCurrentTemplatePresetName_ACU,
} from '../../shared/template-preset-utils';
import { settings_ACU } from '../../service/runtime/state-manager';
import { useToastStore } from '../stores/toast-store';
import { openVisualizerSurface_ACU } from '../surfaces/visualizer/open-visualizer-surface';

export type TablePresetDrawerView = 'closed' | 'manage';

type MessageKind = 'success' | 'error' | 'info' | 'warning';

interface TablePresetMeta {
  name: string;
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

export function useTablePresetManagement() {
  const toast = useToastStore();
  const drawerView = ref<TablePresetDrawerView>('closed');
  const busy = ref(false);
  const message = ref<{ kind: MessageKind; text: string } | null>(null);
  const presetMeta = ref<TablePresetMeta[]>([]);
  const defaultPresetName = ref('');

  const isDrawerOpen = computed(() => drawerView.value !== 'closed');
  const title = computed(() => (drawerView.value === 'manage' ? '管理表格模板预设' : ''));

  function refresh(): void {
    presetMeta.value = listTemplatePresetNames_ACU().map(name => ({ name }));
    defaultPresetName.value = normalizeTemplatePresetSelectionValue_ACU(
      getCurrentTemplatePresetName_ACU(settings_ACU, { requireExisting: false }),
    );
  }

  function openManage(): void {
    refresh();
    drawerView.value = 'manage';
  }

  function closeDrawer(): void {
    drawerView.value = 'closed';
  }

  async function run<T>(action: () => Promise<T> | T): Promise<T | null> {
    busy.value = true;
    message.value = null;
    try {
      return await action();
    } catch (error: any) {
      toast.error(error?.message || '操作失败。');
      return null;
    } finally {
      busy.value = false;
      refresh();
    }
  }

  /** 打开可视化表格编辑器；编辑当前生效的模板。 */
  async function openVisualizer(): Promise<void> {
    await run(async () => {
      const opened = await openVisualizerSurface_ACU({ source: 'v2-shell' });
      if (!opened) throw new Error('可视化编辑器加载失败。');
      toast.success('已打开可视化表格编辑器。');
    });
  }

  /** 编辑指定全局预设：先把当前聊天切换到该预设，再打开可视化编辑器。 */
  async function editPreset(name: string): Promise<void> {
    const normalized = normalizeTemplatePresetSelectionValue_ACU(name);
    if (!normalized) {
      toast.warning('默认预设不能直接编辑，请从默认新建后修改。');
      return;
    }
    await run(async () => {
      const result = await applyTemplatePresetToCurrent_ACU(normalized, {
        source: 'v2_table_drawer_edit',
        updateGlobal: false,
        save: true,
        persistChatScope: true,
      });
      if (!result) throw new Error('切换到目标预设失败。');
      const opened = await openVisualizerSurface_ACU({ source: 'v2-shell' });
      if (!opened) throw new Error('可视化编辑器加载失败。');
      toast.success(`已切换到「${normalized}」并打开可视化编辑器。`);
    });
  }

  async function setAsDefault(name: string): Promise<void> {
    const normalized = normalizeTemplatePresetSelectionValue_ACU(name);
    await run(async () => {
      const result = await applyTemplatePresetToCurrent_ACU(normalized, {
        source: 'v2_table_drawer_set_default',
        updateGlobal: true,
        save: true,
        persistChatScope: false,
      });
      if (!result) throw new Error('设为全局默认失败。');
      toast.success(`「${normalized || '默认预设'}」已设为全局默认。`);
    });
  }

  async function deletePreset(name: string): Promise<void> {
    if (!name) {
      toast.warning('默认预设不能删除。');
      return;
    }
    if (!window.confirm(`确定要删除全局模板预设「${name}」吗？此操作不可撤销。`)) return;
    await run(async () => {
      const normalized = normalizeTemplatePresetSelectionValue_ACU(name);
      const wasGlobalDefault = defaultPresetName.value === normalized;
      const wasActive = normalizeTemplatePresetSelectionValue_ACU(resolveActiveTemplatePresetName_ACU({ fallbackToGlobal: true })) === normalized;
      if (!deleteTemplatePreset_ACU(name)) throw new Error('删除失败或预设不存在。');
      if (wasGlobalDefault) {
        const globalResult = await applyTemplatePresetToCurrent_ACU('', {
          source: 'v2_table_drawer_delete_default_fallback',
          updateGlobal: true,
          save: true,
          persistChatScope: false,
        });
        if (!globalResult) throw new Error('预设已删除，但全局默认回退失败。');
      }
      if (wasActive) {
        const chatResult = await applyTemplatePresetToCurrent_ACU('', {
          source: 'v2_table_drawer_delete_active_fallback',
          updateGlobal: false,
          save: true,
          persistChatScope: true,
        });
        if (!chatResult) throw new Error('预设已删除，但当前聊天回退失败。');
      }
      toast.success(`已删除全局模板预设「${name}」。`);
    });
  }

  function exportPreset(name: string): void {
    const resolved = resolveTemplateForExport_ACU('global', name);
    if (!resolved) {
      toast.error('无法解析目标模板。');
      return;
    }
    const sanitized = sanitizeChatSheetsObject_ACU(resolved.jsonData, { ensureMate: true });
    const safeName = sanitizeFilenameComponent_ACU(resolved.fromPresetName) || 'template';
    downloadJson(sanitized, `TavernDB_template_${safeName}.json`);
    message.value = null;
    toast.success(`「${resolved.fromPresetName || '默认预设'}」已导出。`);
  }

  async function createBlankPreset(): Promise<void> {
    const raw = window.prompt('新建全局模板预设名称：', '新模板预设');
    if (!raw) return;
    const requested = raw.trim();
    if (!requested) return;
    await run(async () => {
      const finalName = ensureUniqueTemplatePresetName_ACU(requested);
      if (finalName !== requested && !window.confirm(`预设名已存在，将自动另存为「${finalName}」。是否继续？`)) return;
      const snapshot = getDefaultTemplateSnapshot_ACU();
      if (!snapshot?.templateStr) throw new Error('无法解析默认模板。');
      if (!upsertTemplatePreset_ACU(finalName, snapshot.templateStr)) throw new Error('无法写入全局模板预设。');
      toast.success(`已新建全局模板预设「${finalName}」。`);
    });
  }

  /** "重命名当前生效的全局预设"——保留原有能力，从抽屉里发起。 */
  async function renamePreset(name: string): Promise<void> {
    if (!name) {
      toast.warning('默认预设不能重命名。');
      return;
    }
    const preset = getTemplatePreset_ACU(name);
    if (!preset?.templateStr) {
      toast.warning('找不到目标预设。');
      return;
    }
    const raw = window.prompt(`将全局模板预设「${name}」重命名为：`, name);
    if (!raw) return;
    const newName = raw.trim();
    if (!newName || newName === name) return;
    await run(async () => {
      if (!upsertTemplatePreset_ACU(newName, preset.templateStr)) throw new Error('重命名失败。');
      deleteTemplatePreset_ACU(name);
      if (defaultPresetName.value === name) {
        const result = await applyTemplatePresetToCurrent_ACU(newName, {
          source: 'v2_table_drawer_rename',
          updateGlobal: true,
          save: true,
          persistChatScope: false,
        });
        if (!result) throw new Error('重命名后切换全局模板预设失败。');
      }
      toast.success(`预设已重命名为「${newName}」。`);
    });
  }

  refresh();

  return {
    drawerView,
    isDrawerOpen,
    title,
    busy,
    message,
    presetMeta,
    defaultPresetName,
    refresh,
    openManage,
    closeDrawer,
    openVisualizer,
    editPreset,
    setAsDefault,
    deletePreset,
    exportPreset,
    createBlankPreset,
    renamePreset,
  };
}
