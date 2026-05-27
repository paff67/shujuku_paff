import { computed, watch } from 'vue';
import { applySheetOrderNumbers_ACU, logWarn_ACU } from '../../../shared/utils';
import { settings_ACU } from '../../../service/runtime/state-manager';
import {
  buildTemplateAssistantFingerprint_ACU,
  createTemplateAssistantSessionGuard_ACU,
  getTemplateAssistantApplyBaselineFingerprint_ACU,
  runTemplateAssistantSession_ACU,
  TemplateAssistantSessionStoppedError_ACU,
  type TemplateAssistantSessionResult_ACU,
  type TemplateAssistantSessionRound_ACU,
} from '../../../service/template-assistant/service';
import { useToastStore } from '../../stores/toast-store';
import {
  useVisualizerStore,
  type VisualizerAssistantTurnState,
} from '../../stores/visualizer-store';

export interface VisualizerAssistantDiffGroup {
  key: string;
  title: string;
  tone: 'normal' | 'warning';
  items: string[];
}

export type VisualizerAssistantTurn =
  | (Extract<VisualizerAssistantTurnState, { type: 'user' }>)
  | (Omit<Extract<VisualizerAssistantTurnState, { type: 'round' }>, 'roundData'> & {
      roundData: TemplateAssistantSessionRound_ACU;
    })
  | (Omit<Extract<VisualizerAssistantTurnState, { type: 'final' }>, 'result'> & {
      result: TemplateAssistantSessionResult_ACU;
    })
  | (Extract<VisualizerAssistantTurnState, { type: 'error' }>);

export interface VisualizerAssistantRiskItem {
  key: string;
  type: string;
  label: string;
}

let guardController = createTemplateAssistantSessionGuard_ACU();

function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function asList(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function createTurnId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function joinKeys(keys: unknown): string {
  return asList(keys).map(item => String(item)).filter(Boolean).join(', ') || '字段已修改';
}

function joinChanges(changes: unknown): string {
  return asList(changes).map(item => String(item)).filter(Boolean).join('；') || '已修改';
}

function resolveEffectiveTableApiPreset(visualizer = useVisualizerStore()): string {
  const currentSheet = visualizer.currentSheet;
  const currentTableName = String(currentSheet?.name || '').trim();
  const overrides = settings_ACU.tableApiPresetOverridesByName;
  if (
    currentTableName
    && overrides
    && typeof overrides === 'object'
    && typeof overrides[currentTableName] === 'string'
    && overrides[currentTableName].trim()
  ) {
    return overrides[currentTableName].trim();
  }
  return String(settings_ACU.tableApiPreset || '').trim();
}

export function buildVisualizerAssistantDiffGroups(
  result: TemplateAssistantSessionResult_ACU | null | undefined,
  currentSheetKey: string | null | undefined,
): VisualizerAssistantDiffGroup[] {
  const diff = result?.compileResult?.diff;
  if (!diff) return [];
  const currentKey = String(currentSheetKey || '').trim();
  const currentItems: string[] = [];
  const otherItems: string[] = [];
  const addedItems: string[] = [];
  const deletedItems: string[] = [];
  const orderItems: string[] = [];
  const globalItems: string[] = [];
  const lockItems: string[] = [];

  const pushSheetPatch = (items: any[], render: (item: any) => string) => {
    asList(items).forEach(item => {
      const target = item?.sheetKey === currentKey ? currentItems : otherItems;
      target.push(render(item));
    });
  };

  pushSheetPatch(diff.patchedContentSheets, item => `${item.name || item.sheetKey}: ${joinChanges(item.changes)}`);
  pushSheetPatch(diff.patchedSourceDataSheets, item => `${item.name || item.sheetKey}: 提示词字段 ${joinKeys(item.keys)}`);
  pushSheetPatch(diff.patchedUpdateConfigSheets, item => `${item.name || item.sheetKey}: 更新参数 ${joinKeys(item.keys)}`);
  pushSheetPatch(diff.patchedExportConfigSheets, item => `${item.name || item.sheetKey}: 世界书配置 ${joinKeys(item.keys)}`);
  pushSheetPatch(diff.patchedSchemaSheets, item => `${item.name || item.sheetKey}: ${joinChanges(item.changes)}`);
  pushSheetPatch(diff.renamedSheets, item => `${item.beforeName || item.sheetKey} -> ${item.afterName || item.sheetKey}`);

  asList(diff.addedSheets).forEach(item => {
    addedItems.push(`${item.name || item.sheetKey} [${item.sheetKey}]`);
  });
  asList(diff.deletedSheets).forEach(item => {
    deletedItems.push(`${item.name || item.sheetKey} [${item.sheetKey}]`);
  });
  asList(diff.movedSheets).forEach(item => {
    orderItems.push(`${item.name || item.sheetKey}: ${item.fromIndex} -> ${item.toIndex}`);
  });
  asList(diff.patchedLockSheets).forEach(item => {
    lockItems.push(`${item.name || item.sheetKey}: ${joinChanges(item.changes)}`);
  });
  if (diff.globalInjectionChanged) {
    globalItems.push('全局注入配置已修改。');
  }

  const groups: VisualizerAssistantDiffGroup[] = [
    { key: 'current', title: '当前锚点表内容 / 结构 / 参数', tone: 'normal', items: currentItems },
    { key: 'other', title: '其他表修改', tone: otherItems.length ? 'warning' : 'normal', items: otherItems },
    { key: 'added', title: '新增表', tone: addedItems.length ? 'warning' : 'normal', items: addedItems },
    { key: 'deleted', title: '删除表', tone: deletedItems.length ? 'warning' : 'normal', items: deletedItems },
    { key: 'order', title: '表排序', tone: orderItems.length ? 'warning' : 'normal', items: orderItems },
    { key: 'global', title: '全局注入配置', tone: globalItems.length ? 'warning' : 'normal', items: globalItems },
    { key: 'locks', title: '锁变化', tone: lockItems.length ? 'warning' : 'normal', items: lockItems },
  ];
  return groups.filter(group => group.items.length > 0);
}

export function buildVisualizerAssistantHighRiskItems(
  result: TemplateAssistantSessionResult_ACU | null | undefined,
  currentSheetKey: string | null | undefined,
): VisualizerAssistantRiskItem[] {
  const compileResult = result?.compileResult;
  const diff = compileResult?.diff;
  if (!compileResult) return [];
  const currentKey = String(currentSheetKey || '').trim();
  const items: VisualizerAssistantRiskItem[] = [];
  const seen = new Set<string>();
  const add = (type: string, label: string, key = `${type}:${label}`) => {
    const normalizedLabel = String(label || '').trim();
    if (!normalizedLabel || seen.has(key)) return;
    seen.add(key);
    items.push({ key, type, label: normalizedLabel });
  };

  asList(compileResult.highRiskItems).forEach((item, index) => {
    add(String(item?.type || 'service_high_risk'), String(item?.label || ''), `service:${index}:${item?.type}:${item?.label}`);
  });

  const addCrossSheetPatch = (patches: any[], kind: string, render: (item: any) => string) => {
    asList(patches).forEach(item => {
      const sheetKey = String(item?.sheetKey || '').trim();
      if (!sheetKey || sheetKey === currentKey) return;
      add('cross_sheet_change', `跨表变更：${render(item)}`, `cross:${kind}:${sheetKey}:${render(item)}`);
    });
  };

  addCrossSheetPatch(diff?.patchedContentSheets, 'content', item => `${item.name || item.sheetKey} 的数据内容`);
  addCrossSheetPatch(diff?.patchedSourceDataSheets, 'source', item => `${item.name || item.sheetKey} 的提示词字段`);
  addCrossSheetPatch(diff?.patchedUpdateConfigSheets, 'update', item => `${item.name || item.sheetKey} 的更新参数`);
  addCrossSheetPatch(diff?.patchedExportConfigSheets, 'export', item => `${item.name || item.sheetKey} 的世界书配置`);
  addCrossSheetPatch(diff?.patchedSchemaSheets, 'schema', item => `${item.name || item.sheetKey} 的结构`);
  addCrossSheetPatch(diff?.patchedLockSheets, 'locks', item => `${item.name || item.sheetKey} 的锁设置`);
  addCrossSheetPatch(diff?.renamedSheets, 'rename', item => `${item.beforeName || item.sheetKey} 重命名为 ${item.afterName || item.sheetKey}`);

  asList(diff?.movedSheets).forEach(item => {
    add('cross_sheet_change', `跨表变更：调整表排序 ${item.name || item.sheetKey}`, `cross:move:${item.sheetKey}:${item.fromIndex}:${item.toIndex}`);
  });

  return items;
}

function buildPriorTurns(turns: VisualizerAssistantTurn[], currentSheetKey: string | null | undefined) {
  const anchorKey = String(currentSheetKey || '').trim();
  return turns
    .filter((turn): turn is Extract<VisualizerAssistantTurn, { type: 'final' }> =>
      turn.type === 'final' && (!anchorKey || getResultAnchorSheetKey(turn.result) === anchorKey),
    )
    .map(turn => ({
      user: turn.userRequest,
      assistant: String(turn.result.aiRawText || '').trim() || undefined,
    }));
}

function getResultAnchorSheetKey(result: TemplateAssistantSessionResult_ACU | null | undefined): string {
  return String(result?.draft?.selectedSheetKey || '').trim();
}

function getRoundAnchorSheetKey(round: TemplateAssistantSessionRound_ACU | null | undefined): string {
  return String(round?.draft?.selectedSheetKey || '').trim();
}

export function useVisualizerAssistant() {
  const visualizer = useVisualizerStore();
  const toastStore = useToastStore();
  if (
    !visualizer.assistantTableApiPreset
    && !visualizer.assistantUserRequest
    && !visualizer.assistantLatestResult
    && !visualizer.assistantTurns.length
  ) {
    visualizer.assistantTableApiPreset = resolveEffectiveTableApiPreset(visualizer);
  }

  const userRequest = computed({
    get: () => visualizer.assistantUserRequest,
    set: value => { visualizer.assistantUserRequest = String(value || ''); },
  });
  const maxRounds = computed({
    get: () => visualizer.assistantMaxRounds,
    set: value => { visualizer.assistantMaxRounds = Math.max(1, Math.floor(Number(value) || 1)); },
  });
  const tableApiPreset = computed({
    get: () => visualizer.assistantTableApiPreset,
    set: value => { visualizer.assistantTableApiPreset = String(value || ''); },
  });
  const isRunning = computed(() => visualizer.assistantIsRunning);
  const errorMessage = computed(() => visualizer.assistantErrorMessage);
  const rounds = computed(() => visualizer.assistantRounds as TemplateAssistantSessionRound_ACU[]);
  const latestResult = computed(() => visualizer.assistantLatestResult as TemplateAssistantSessionResult_ACU | null);
  const turns = computed(() => visualizer.assistantTurns as VisualizerAssistantTurn[]);
  const riskConfirmations = computed(() => visualizer.assistantRiskConfirmations);

  const apiPresetOptions = computed(() => [
    { value: '', label: '当前配置' },
    ...(Array.isArray(settings_ACU.apiPresets) ? settings_ACU.apiPresets : [])
      .map((preset: any) => String(preset?.name || '').trim())
      .filter(Boolean)
      .map((name: string) => ({ value: name, label: name })),
  ]);

  const anchorSheetLabel = computed(() => {
    const key = getResultAnchorSheetKey(latestResult.value) || visualizer.currentSheetKey;
    const sheet = key && visualizer.tempData ? visualizer.tempData[key] : null;
    const name = String(sheet?.name || '').trim();
    if (!key) return '当前未选中表';
    return `${name || key} (${key})`;
  });

  const diffGroups = computed(() =>
    buildVisualizerAssistantDiffGroups(
      latestResult.value,
      getResultAnchorSheetKey(latestResult.value) || visualizer.currentSheetKey,
    ),
  );

  const highRiskItems = computed(() =>
    buildVisualizerAssistantHighRiskItems(
      latestResult.value,
      getResultAnchorSheetKey(latestResult.value) || visualizer.currentSheetKey,
    ),
  );

  const allHighRiskConfirmed = computed(() =>
    highRiskItems.value.every((_, index) => riskConfirmations.value[String(index)] === true),
  );

  const isLatestDraftForCurrentSheet = computed(() => {
    const result = latestResult.value;
    if (!result) return false;
    const anchorKey = getResultAnchorSheetKey(result);
    return !!anchorKey && anchorKey === visualizer.currentSheetKey;
  });

  const canApply = computed(() =>
    !!latestResult.value && !isRunning.value && allHighRiskConfirmed.value && isLatestDraftForCurrentSheet.value,
  );

  const sessionSummary = computed(() => {
    const session = latestResult.value?.session;
    if (!session) return '';
    const stopReasonLabel: Record<string, string> = {
      empty_operations: '空操作停止',
      repeated_working_fingerprint: '重复状态停止',
      repair_retry_capped: '修复重试已达上限',
      max_rounds: '达到轮次上限',
    };
    return `会话${session.roundsExecuted}轮 · ${stopReasonLabel[session.stopReason] || session.stopReason}`;
  });

  function resetRiskConfirmations(): void {
    visualizer.assistantRiskConfirmations = {};
  }

  function appendTurn(turn: VisualizerAssistantTurnState): void {
    visualizer.assistantTurns = [...visualizer.assistantTurns, turn];
  }

  function appendErrorTurn(message: string, anchorSheetKey: string): void {
    appendTurn({
      id: createTurnId('error'),
      type: 'error',
      errorMessage: message,
      anchorSheetKey,
      createdAt: Date.now(),
    });
  }

  async function run(): Promise<boolean> {
    const request = String(userRequest.value || '').trim();
    if (!request) {
      visualizer.assistantErrorMessage = '请输入改表需求。';
      return false;
    }
    if (!visualizer.tempData || !visualizer.currentSheetKey) {
      visualizer.assistantErrorMessage = '请先选中一张表后再使用 AI 改表助手。';
      return false;
    }

    const requestSheetKey = visualizer.currentSheetKey;
    const createdAt = Date.now();
    guardController = createTemplateAssistantSessionGuard_ACU();
    visualizer.assistantIsRunning = true;
    visualizer.assistantErrorMessage = '';
    visualizer.assistantRounds = [];
    visualizer.assistantLatestResult = null;
    resetRiskConfirmations();
    appendTurn({
      id: createTurnId('user'),
      type: 'user',
      userRequest: request,
      anchorSheetKey: requestSheetKey,
      createdAt,
    });

    try {
      const result = await runTemplateAssistantSession_ACU({
        tempData: cloneData(visualizer.tempData),
        currentSheetKey: visualizer.currentSheetKey,
        sheetOrder: [...visualizer.sheetOrder],
        userRequest: request,
        priorTurns: buildPriorTurns(turns.value, requestSheetKey),
        tableApiPreset: tableApiPreset.value,
        maxRounds: maxRounds.value,
        guard: guardController.createRunGuard(),
        onRoundComplete(progress) {
          if (requestSheetKey !== visualizer.currentSheetKey) return;
          visualizer.assistantRounds = [...progress.rounds];
          appendTurn({
            id: createTurnId('round'),
            type: 'round',
            round: progress.round.round,
            maxRounds: progress.maxRounds,
            roundData: progress.round,
            anchorSheetKey: getRoundAnchorSheetKey(progress.round) || requestSheetKey,
            createdAt: Date.now(),
          });
        },
      });
      if (requestSheetKey !== visualizer.currentSheetKey) {
        visualizer.assistantErrorMessage = '当前选中表已变化，请重新生成 AI 草稿。';
        appendErrorTurn(visualizer.assistantErrorMessage, requestSheetKey);
        toastStore.warning(visualizer.assistantErrorMessage, { muteable: false });
        return false;
      }
      visualizer.assistantLatestResult = result;
      visualizer.assistantRounds = [...result.rounds];
      appendTurn({
        id: createTurnId('final'),
        type: 'final',
        userRequest: request,
        result,
        anchorSheetKey: getResultAnchorSheetKey(result) || requestSheetKey,
        createdAt: Date.now(),
      });
      resetRiskConfirmations();
      userRequest.value = '';
      return true;
    } catch (error) {
      if (error instanceof TemplateAssistantSessionStoppedError_ACU) {
        visualizer.assistantErrorMessage = error.message;
        appendErrorTurn(error.message, requestSheetKey);
        toastStore.warning(error.message, { muteable: false });
      } else {
        const message = error instanceof Error ? error.message : 'AI 改表助手执行失败。';
        visualizer.assistantErrorMessage = message;
        appendErrorTurn(message, requestSheetKey);
        logWarn_ACU('[ACU-V2 Visualizer Assistant] run failed:', error);
        toastStore.error(message, { muteable: false });
      }
      return false;
    } finally {
      visualizer.assistantIsRunning = false;
    }
  }

  function cancel(): void {
    guardController.cancel();
  }

  function setRiskConfirmation(index: number, value: boolean): void {
    visualizer.assistantRiskConfirmations[String(index)] = value;
  }

  function applyLatestDraft(): boolean {
    const result = latestResult.value;
    if (!result) return false;
    const anchorKey = getResultAnchorSheetKey(result);
    if (!anchorKey || anchorKey !== visualizer.currentSheetKey) {
      toastStore.warning('这份 AI 草稿属于其他锚点表，请切回原表或重新生成。', { muteable: false });
      return false;
    }
    if (!allHighRiskConfirmed.value) {
      toastStore.warning('请先确认所有高风险项后再应用。', { muteable: false });
      return false;
    }

    const baselineFingerprint = getTemplateAssistantApplyBaselineFingerprint_ACU(result);
    const currentFingerprint = buildTemplateAssistantFingerprint_ACU(visualizer.tempData || {});
    if (!baselineFingerprint || currentFingerprint !== baselineFingerprint) {
      toastStore.warning('当前结构已变化，AI 草稿已失效，请重新生成。', { muteable: false });
      return false;
    }

    visualizer.tempData = cloneData(result.compileResult.candidateData || {});
    visualizer.sheetOrder = Array.isArray(result.compileResult.orderedSheetKeys)
      ? [...result.compileResult.orderedSheetKeys]
      : [];
    applySheetOrderNumbers_ACU(visualizer.tempData, visualizer.sheetOrder);
    const deleted = new Set<string>(visualizer.deletedSheetKeys || []);
    asList(result.compileResult.deletedSheetKeys).forEach(key => deleted.add(String(key)));
    visualizer.deletedSheetKeys = Array.from(deleted);

    visualizer.queueLockChanges(asList(result.compileResult.lockChanges));

    const previousSheetKey = visualizer.currentSheetKey;
    if (previousSheetKey && visualizer.tempData?.[previousSheetKey]) {
      visualizer.currentSheetKey = previousSheetKey;
    } else if (result.compileResult.focusSheetKey && visualizer.tempData?.[result.compileResult.focusSheetKey]) {
      visualizer.currentSheetKey = result.compileResult.focusSheetKey;
    } else {
      visualizer.currentSheetKey = visualizer.sheetOrder[0] || null;
    }
    if (visualizer.currentSheetKey) visualizer.mode = 'data';
    visualizer.setDirty(true);
    toastStore.success('AI 草稿已应用到编辑器，保存前不会写回聊天。', { muteable: false });
    return true;
  }

  function syncApiPresetFromCurrentSheet(): void {
    visualizer.assistantTableApiPreset = resolveEffectiveTableApiPreset(visualizer);
  }

  function getTurnSummary(turn: VisualizerAssistantTurn): string {
    if (turn.type === 'user') return turn.userRequest;
    if (turn.type === 'error') return turn.errorMessage;
    if (turn.type === 'round') return turn.roundData.draft.summary || '无摘要';
    return turn.result.draft.summary || '无摘要';
  }

  function getTurnWarnings(turn: VisualizerAssistantTurn): string[] {
    if (turn.type === 'round') return asList(turn.roundData.draft.warnings).map(item => String(item));
    if (turn.type === 'final') return asList(turn.result.draft.warnings).map(item => String(item));
    return [];
  }

  function getTurnDiffGroups(turn: VisualizerAssistantTurn): VisualizerAssistantDiffGroup[] {
    if (turn.type === 'round') {
      return buildVisualizerAssistantDiffGroups(
        { compileResult: turn.roundData.perRoundCompileResult } as TemplateAssistantSessionResult_ACU,
        getRoundAnchorSheetKey(turn.roundData) || turn.anchorSheetKey,
      );
    }
    if (turn.type === 'final') {
      return buildVisualizerAssistantDiffGroups(
        turn.result,
        getResultAnchorSheetKey(turn.result) || turn.anchorSheetKey,
      );
    }
    return [];
  }

  watch(
    () => [visualizer.currentSheetKey, visualizer.openTick, visualizer.lastLoadedAt],
    () => {
      guardController.invalidate();
      if (isRunning.value) {
        visualizer.assistantIsRunning = false;
        visualizer.assistantErrorMessage = '会话已失效（结构变化或切表）。';
      }
      syncApiPresetFromCurrentSheet();
    },
  );

  return {
    userRequest,
    maxRounds,
    tableApiPreset,
    apiPresetOptions,
    anchorSheetLabel,
    isRunning,
    errorMessage,
    rounds,
    latestResult,
    turns,
    riskConfirmations,
    diffGroups,
    highRiskItems,
    allHighRiskConfirmed,
    canApply,
    sessionSummary,
    run,
    cancel,
    setRiskConfirmation,
    applyLatestDraft,
    syncApiPresetFromCurrentSheet,
    getTurnSummary,
    getTurnWarnings,
    getTurnDiffGroups,
  };
}
