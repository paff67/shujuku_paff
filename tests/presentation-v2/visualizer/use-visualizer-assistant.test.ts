/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const {
  mockRunSession,
  mockFingerprint,
  mockGetBaselineFingerprint,
  mockCreateGuard,
} = vi.hoisted(() => ({
  mockRunSession: vi.fn(),
  mockFingerprint: vi.fn((data: any) => `fp:${JSON.stringify(data)}`),
  mockGetBaselineFingerprint: vi.fn((result: any) =>
    String(result?.originalBaseFingerprint || result?.draft?.baseFingerprint || ''),
  ),
  mockCreateGuard: vi.fn(() => ({
    createRunGuard: () => ({
      isCancelled: () => false,
      isStale: () => false,
    }),
    invalidate: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
  })),
}));

vi.mock('../../../src/service/template-assistant/service', () => ({
  buildTemplateAssistantFingerprint_ACU: mockFingerprint,
  createTemplateAssistantSessionGuard_ACU: mockCreateGuard,
  getTemplateAssistantApplyBaselineFingerprint_ACU: mockGetBaselineFingerprint,
  runTemplateAssistantSession_ACU: mockRunSession,
  TemplateAssistantSessionStoppedError_ACU: class TemplateAssistantSessionStoppedError_ACU extends Error {},
}));

function buildResult(input: any, overrides: any = {}) {
  const baseFingerprint = mockFingerprint(input.tempData);
  return {
    draft: {
      protocolVersion: 2,
      mode: 'modify_current_template_incremental',
      requestId: 'req-v2',
      atomic: true,
      baseFingerprint,
      selectedSheetKey: input.currentSheetKey,
      summary: '已生成草稿',
      warnings: [],
      operations: [],
      ...overrides.draft,
    },
    aiRawText: '<templateAssistantDraft>{}</templateAssistantDraft>',
    messages: [],
    originalBaseFingerprint: baseFingerprint,
    rounds: [],
    session: {
      originalBaseFingerprint: baseFingerprint,
      finalWorkingFingerprint: 'next',
      stopReason: 'empty_operations',
      roundsExecuted: 1,
      maxRounds: 3,
      repairRetriesUsed: 0,
      maxRepairRetries: 1,
      lastErrorMessage: '',
    },
    compileResult: {
      candidateData: input.tempData,
      orderedSheetKeys: input.sheetOrder,
      deletedSheetKeys: [],
      focusSheetKey: input.currentSheetKey,
      diff: {
        addedSheets: [],
        deletedSheets: [],
        renamedSheets: [],
        movedSheets: [],
        patchedSourceDataSheets: [],
        patchedUpdateConfigSheets: [],
        patchedExportConfigSheets: [],
        patchedContentSheets: [],
        patchedSchemaSheets: [],
        patchedLockSheets: [],
        globalInjectionChanged: false,
      },
      highRiskItems: [],
      lockChanges: [],
      ...overrides.compileResult,
    },
  };
}

describe('useVisualizerAssistant', () => {
  beforeEach(() => {
    vi.resetModules();
    mockRunSession.mockReset();
    mockFingerprint.mockClear();
    mockGetBaselineFingerprint.mockClear();
    mockCreateGuard.mockClear();
    setActivePinia(createPinia());
  });

  it('按当前锚点表分组展示 diff 范围', async () => {
    const { buildVisualizerAssistantDiffGroups } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerAssistant');
    const groups = buildVisualizerAssistantDiffGroups({
      compileResult: {
        diff: {
          addedSheets: [{ sheetKey: 'sheet_new', name: '战利品表' }],
          deletedSheets: [{ sheetKey: 'sheet_old', name: '旧表' }],
          renamedSheets: [],
          movedSheets: [{ sheetKey: 'sheet_b', name: 'B表', fromIndex: 2, toIndex: 1 }],
          patchedSourceDataSheets: [],
          patchedUpdateConfigSheets: [{ sheetKey: 'sheet_a', name: 'A表', keys: ['contextDepth'] }],
          patchedExportConfigSheets: [],
          patchedContentSheets: [{ sheetKey: 'sheet_b', name: 'B表', changes: ['新增 1 行'] }],
          patchedSchemaSheets: [],
          patchedLockSheets: [{ sheetKey: 'sheet_a', name: 'A表', changes: ['锁定列: 状态'] }],
          globalInjectionChanged: true,
        },
      },
    } as any, 'sheet_a');

    expect(groups.find(group => group.key === 'current')?.items.join('；')).toContain('A表: 更新参数 contextDepth');
    expect(groups.find(group => group.key === 'other')?.items.join('；')).toContain('B表: 新增 1 行');
    expect(groups.find(group => group.key === 'added')?.items.join('；')).toContain('战利品表 [sheet_new]');
    expect(groups.find(group => group.key === 'deleted')?.tone).toBe('warning');
    expect(groups.find(group => group.key === 'global')?.items[0]).toContain('全局注入配置');
    expect(groups.find(group => group.key === 'locks')?.items[0]).toContain('锁定列');
  });

  it('调用 session runner 并把确认后的草稿应用到 visualizer 临时态', async () => {
    const { settings_ACU } = await import('../../../src/service/runtime/state-manager');
    settings_ACU.apiPresets = [{ name: 'preset-beta' }] as any;
    settings_ACU.tableApiPreset = 'preset-alpha';
    settings_ACU.tableApiPresetOverridesByName = { A表: 'preset-beta' };

    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerAssistant } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerAssistant');
    const visualizer = useVisualizerStore();
    visualizer.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_a: {
        uid: 'sheet_a',
        name: 'A表',
        orderNo: 0,
        content: [[null, '姓名'], [null, 'A']],
      },
    }, ['sheet_a']);

    mockRunSession.mockImplementation(async (input: any) => buildResult(input, {
      compileResult: {
        candidateData: {
          mate: { type: 'chatSheets', version: 1 },
          sheet_a: {
            uid: 'sheet_a',
            name: 'A表',
            orderNo: 0,
            content: [[null, '姓名', '状态'], [null, 'A', '警觉']],
          },
          sheet_b: {
            uid: 'sheet_b',
            name: 'B表',
            orderNo: 1,
            content: [[null, '字段']],
          },
        },
        orderedSheetKeys: ['sheet_a', 'sheet_b'],
        deletedSheetKeys: ['sheet_old'],
        diff: {
          addedSheets: [{ sheetKey: 'sheet_b', name: 'B表' }],
          deletedSheets: [],
          renamedSheets: [],
          movedSheets: [],
          patchedSourceDataSheets: [],
          patchedUpdateConfigSheets: [],
          patchedExportConfigSheets: [],
          patchedContentSheets: [{ sheetKey: 'sheet_a', name: 'A表', changes: ['改单元格'] }],
          patchedSchemaSheets: [],
          patchedLockSheets: [],
          globalInjectionChanged: false,
        },
        highRiskItems: [{ type: 'delete_sheet', label: '删除表: 旧表' }],
      },
    }));

    const assistant = useVisualizerAssistant();
    expect(assistant.tableApiPreset.value).toBe('preset-beta');
    assistant.userRequest.value = '新增状态列';
    await assistant.run();

    expect(mockRunSession).toHaveBeenCalledWith(expect.objectContaining({
      currentSheetKey: 'sheet_a',
      sheetOrder: ['sheet_a'],
      userRequest: '新增状态列',
      tableApiPreset: 'preset-beta',
    }));
    expect(assistant.canApply.value).toBe(false);

    assistant.setRiskConfirmation(0, true);
    expect(assistant.canApply.value).toBe(true);
    expect(assistant.applyLatestDraft()).toBe(true);

    expect(visualizer.dirty).toBe(true);
    expect(visualizer.sheetOrder).toEqual(['sheet_a', 'sheet_b']);
    expect(visualizer.deletedSheetKeys).toContain('sheet_old');
    expect(visualizer.currentSheet.content[1][2]).toBe('警觉');
  });

  it('schema/DDL 高风险项必须手动确认后才能应用', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerAssistant } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerAssistant');
    const visualizer = useVisualizerStore();
    visualizer.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_a: { uid: 'sheet_a', name: 'A表', orderNo: 0, content: [[null, '姓名']] },
    }, ['sheet_a']);

    mockRunSession.mockImplementation(async (input: any) => buildResult(input, {
      compileResult: {
        highRiskItems: [{ type: 'patch_sheet_schema', label: '更新 DDL: A表' }],
      },
    }));

    const assistant = useVisualizerAssistant();
    assistant.userRequest.value = '更新 DDL';
    await assistant.run();

    expect(assistant.canApply.value).toBe(false);
    assistant.setRiskConfirmation(0, true);
    expect(assistant.canApply.value).toBe(true);
  });

  it('跨表变更会派生高风险确认，确认前不能应用', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerAssistant } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerAssistant');
    const visualizer = useVisualizerStore();
    visualizer.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_a: { uid: 'sheet_a', name: 'A表', orderNo: 0, content: [[null, '姓名'], [null, 'A']] },
      sheet_b: { uid: 'sheet_b', name: 'B表', orderNo: 1, content: [[null, '状态'], [null, '平静']] },
    }, ['sheet_a', 'sheet_b']);

    mockRunSession.mockImplementation(async (input: any) => buildResult(input, {
      compileResult: {
        diff: {
          addedSheets: [],
          deletedSheets: [],
          renamedSheets: [],
          movedSheets: [],
          patchedSourceDataSheets: [],
          patchedUpdateConfigSheets: [],
          patchedExportConfigSheets: [],
          patchedContentSheets: [{ sheetKey: 'sheet_b', name: 'B表', changes: ['改单元格'] }],
          patchedSchemaSheets: [],
          patchedLockSheets: [],
          globalInjectionChanged: false,
        },
        highRiskItems: [],
      },
    }));

    const assistant = useVisualizerAssistant();
    assistant.userRequest.value = '顺便调整 B 表';
    await assistant.run();

    expect(assistant.highRiskItems.value.map(item => item.label).join('；')).toContain('跨表变更：B表 的数据内容');
    expect(assistant.canApply.value).toBe(false);
    expect(assistant.applyLatestDraft()).toBe(false);

    assistant.setRiskConfirmation(0, true);
    expect(assistant.canApply.value).toBe(true);
  });

  it('AI 草稿和完整 transcript 保存在 visualizer store，重新创建 composable 后仍可继续应用', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerAssistant } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerAssistant');
    const visualizer = useVisualizerStore();
    visualizer.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_a: { uid: 'sheet_a', name: 'A表', orderNo: 0, content: [[null, '姓名'], [null, 'A']] },
    }, ['sheet_a']);

    mockRunSession.mockImplementation(async (input: any) => {
      const result = buildResult(input, {
        compileResult: {
          candidateData: {
            mate: { type: 'chatSheets', version: 1 },
            sheet_a: {
              uid: 'sheet_a',
              name: 'A表',
              orderNo: 0,
              content: [[null, '姓名', '状态'], [null, 'A', '警觉']],
            },
          },
          orderedSheetKeys: ['sheet_a'],
          diff: {
            addedSheets: [],
            deletedSheets: [],
            renamedSheets: [],
            movedSheets: [],
            patchedSourceDataSheets: [],
            patchedUpdateConfigSheets: [],
            patchedExportConfigSheets: [],
            patchedContentSheets: [{ sheetKey: 'sheet_a', name: 'A表', changes: ['改单元格'] }],
            patchedSchemaSheets: [],
            patchedLockSheets: [],
            globalInjectionChanged: false,
          },
          highRiskItems: [],
        },
      });
      const round = {
        round: 1,
        userRequest: input.userRequest,
        draft: {
          ...result.draft,
          summary: '第一轮草稿',
          warnings: ['请检查新增字段是否符合预期'],
        },
        aiRawText: '<templateAssistantDraft>{"round":1}</templateAssistantDraft>',
        messages: [],
        perRoundCompileResult: result.compileResult,
        workingFingerprint: 'round-fp',
      };
      input.onRoundComplete?.({ round, rounds: [round], maxRounds: input.maxRounds });
      return {
        ...result,
        rounds: [round],
      };
    });

    const firstAssistant = useVisualizerAssistant();
    firstAssistant.userRequest.value = '新增状态列';
    await firstAssistant.run();

    const remountedAssistant = useVisualizerAssistant();
    expect(remountedAssistant.latestResult.value?.draft.summary).toBe('已生成草稿');
    expect(remountedAssistant.turns.value.map(turn => turn.type)).toEqual(['user', 'round', 'final']);
    expect(remountedAssistant.getTurnSummary(remountedAssistant.turns.value[0])).toBe('新增状态列');
    expect(remountedAssistant.getTurnWarnings(remountedAssistant.turns.value[1])).toContain('请检查新增字段是否符合预期');
    expect(remountedAssistant.getTurnDiffGroups(remountedAssistant.turns.value[1]).map(group => group.title).join('；')).toContain('当前锚点表内容');
    expect(remountedAssistant.canApply.value).toBe(true);
    expect(remountedAssistant.applyLatestDraft()).toBe(true);
    expect(visualizer.currentSheet.content[1][2]).toBe('警觉');
  });

  it('session runner 失败时把错误写入 transcript', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerAssistant } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerAssistant');
    const visualizer = useVisualizerStore();
    visualizer.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_a: { uid: 'sheet_a', name: 'A表', orderNo: 0, content: [[null, '姓名'], [null, 'A']] },
    }, ['sheet_a']);
    mockRunSession.mockRejectedValue(new Error('模型返回格式错误'));

    const assistant = useVisualizerAssistant();
    assistant.userRequest.value = '生成非法草稿';
    expect(await assistant.run()).toBe(false);

    expect(assistant.turns.value.map(turn => turn.type)).toEqual(['user', 'error']);
    expect(assistant.getTurnSummary(assistant.turns.value[1])).toContain('模型返回格式错误');
    expect(assistant.latestResult.value).toBeNull();
  });

  it('切表后保留草稿原锚点分组，但禁止直接应用旧锚点草稿', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerAssistant } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerAssistant');
    const visualizer = useVisualizerStore();
    visualizer.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_a: { uid: 'sheet_a', name: 'A表', orderNo: 0, content: [[null, '姓名']] },
      sheet_b: { uid: 'sheet_b', name: 'B表', orderNo: 1, content: [[null, '字段']] },
    }, ['sheet_a', 'sheet_b']);

    mockRunSession.mockImplementation(async (input: any) => buildResult(input, {
      compileResult: {
        diff: {
          addedSheets: [],
          deletedSheets: [],
          renamedSheets: [],
          movedSheets: [],
          patchedSourceDataSheets: [],
          patchedUpdateConfigSheets: [{ sheetKey: 'sheet_a', name: 'A表', keys: ['contextDepth'] }],
          patchedExportConfigSheets: [],
          patchedContentSheets: [],
          patchedSchemaSheets: [],
          patchedLockSheets: [],
          globalInjectionChanged: false,
        },
      },
    }));

    const assistant = useVisualizerAssistant();
    assistant.userRequest.value = '调整 A 表参数';
    await assistant.run();

    visualizer.selectSheet('sheet_b');

    expect(assistant.anchorSheetLabel.value).toBe('A表 (sheet_a)');
    expect(assistant.diffGroups.value.find(group => group.key === 'current')?.items.join('；')).toContain('A表: 更新参数 contextDepth');
    expect(assistant.canApply.value).toBe(false);
    expect(assistant.applyLatestDraft()).toBe(false);
  });

  it('应用 AI lockChanges 时只进入 visualizer 草稿，保存前不写入运行时锁设置', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerAssistant } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerAssistant');
    const visualizer = useVisualizerStore();
    visualizer.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_a: { uid: 'sheet_a', name: 'A表', orderNo: 0, content: [[null, '姓名'], [null, 'A']] },
    }, ['sheet_a']);

    mockRunSession.mockImplementation(async (input: any) => buildResult(input, {
      compileResult: {
        lockChanges: [
          {
            sheetKey: 'sheet_a',
            rows: [{ rowIndex: 0, locked: true }],
            columns: [],
            cells: [],
            specialIndexLocked: false,
          },
        ],
      },
    }));

    const assistant = useVisualizerAssistant();
    assistant.userRequest.value = '锁定第一行';
    await assistant.run();

    expect(assistant.applyLatestDraft()).toBe(true);
    expect(visualizer.pendingLockChanges).toHaveLength(1);
    expect(visualizer.pendingLockChanges[0].sheetKey).toBe('sheet_a');
  });
});
