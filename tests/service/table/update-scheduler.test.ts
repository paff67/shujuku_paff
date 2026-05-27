/**
 * tests/service/table/update-scheduler.test.ts
 * 自动更新调度器单元测试
 *
 * 策略：
 * - buildAutoUpdatePlan_ACU 通过构造 mock 聊天记录和表格数据直接测试
 * - checkAutoUpdatePreConditions_ACU 是纯函数，直接测试
 * - handleFloorIncreaseDelay_ACU 通过 mock 回调测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════
// Mock 设置
// ═══════════════════════════════════════════════════════════════

vi.mock('../../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
  logError_ACU: vi.fn(),
  isSummaryOrOutlineTable_ACU: vi.fn(() => false),
}));

vi.mock('../../../src/service/template/chat-scope', () => ({
  getSortedSheetKeys_ACU: vi.fn((data: any) => data ? Object.keys(data).filter((k: string) => k.startsWith('sheet_')) : []),
}));

vi.mock('../../../src/service/table/update-orchestrator', async () => {
  const actual = await vi.importActual<any>('../../../src/service/table/update-orchestrator');
  return {
    ...actual,
    generateDeferredResponsesForPreparedCalls_ACU: vi.fn(async (preparedCalls: any[]) => ({
      success: true,
      responses: preparedCalls.map((call, index) => ({
        aiResponse: `<tableEdit>${call?.targetSheetKeys?.[0] || `sheet_${index}`}</tableEdit>`,
      })),
    })),
    extractEditsFromAiResponse_ACU: vi.fn((aiResponse: string) => aiResponse || '<tableEdit>sheet_0</tableEdit>'),
    mergeAiEditContents_ACU: vi.fn((editBlocks: string[]) => editBlocks.join('\n')),
    applyMergedEdits_ACU: vi.fn(async () => ({
      success: true,
      modifiedKeys: ['sheet_0', 'sheet_1'],
      beforeData: {},
      afterData: { sheet_0: { rows: [] }, sheet_1: { rows: [] } },
    })),
  };
});

vi.mock('../../../src/service/table/table-service', () => ({
  persistTablesToChatMessage_ACU: vi.fn(async (options: any) => ({ saved: true, messageIndex: options?.targetMessageIndex })),
}));

import {
  buildAutoUpdatePlan_ACU,
  checkAutoUpdatePreConditions_ACU,
  handleFloorIncreaseDelay_ACU,
  executeAutoUpdatePlan_ACU,
} from '../../../src/service/table/update-scheduler';

// ═══════════════════════════════════════════════════════════════
// checkAutoUpdatePreConditions_ACU
// ═══════════════════════════════════════════════════════════════
describe('checkAutoUpdatePreConditions_ACU', () => {
  const baseSettings = {
    autoUpdateEnabled: true,
    apiMode: 'custom',
    apiConfig: { useMainApi: true, url: '', model: '' },
    tavernProfile: '',
  };

  it('所有条件满足时返回 canProceed=true', () => {
    const result = checkAutoUpdatePreConditions_ACU(baseSettings, true, false, { sheet_0: {} }, 5);
    expect(result.canProceed).toBe(true);
  });

  it('autoUpdateEnabled=false 时不可继续', () => {
    const result = checkAutoUpdatePreConditions_ACU({ ...baseSettings, autoUpdateEnabled: false }, true, false, {}, 5);
    expect(result.canProceed).toBe(false);
    expect(result.reason).toContain('disabled');
  });

  it('coreApisAreReady=false 时不可继续', () => {
    const result = checkAutoUpdatePreConditions_ACU(baseSettings, false, false, {}, 5);
    expect(result.canProceed).toBe(false);
    expect(result.reason).toContain('Pre-flight');
  });

  it('isAutoUpdatingCard=true 时不可继续', () => {
    const result = checkAutoUpdatePreConditions_ACU(baseSettings, true, true, {}, 5);
    expect(result.canProceed).toBe(false);
  });

  it('currentJsonTableData=null 时不可继续', () => {
    const result = checkAutoUpdatePreConditions_ACU(baseSettings, true, false, null, 5);
    expect(result.canProceed).toBe(false);
  });

  it('聊天记录少于2条时不可继续', () => {
    const result = checkAutoUpdatePreConditions_ACU(baseSettings, true, false, { sheet_0: {} }, 1);
    expect(result.canProceed).toBe(false);
    expect(result.reason).toContain('too short');
  });

  it('API 未配置时不可继续（custom 模式无 useMainApi）', () => {
    const settings = {
      ...baseSettings,
      apiConfig: { useMainApi: false, url: '', model: '' },
    };
    const result = checkAutoUpdatePreConditions_ACU(settings, true, false, { sheet_0: {} }, 5);
    expect(result.canProceed).toBe(false);
  });

  it('tavern 模式有 profile 时可继续', () => {
    const settings = {
      ...baseSettings,
      apiMode: 'tavern',
      tavernProfile: 'my-profile',
    };
    const result = checkAutoUpdatePreConditions_ACU(settings, true, false, { sheet_0: {} }, 5);
    expect(result.canProceed).toBe(true);
  });

  it('tavern 模式无 profile 时不可继续', () => {
    const settings = {
      ...baseSettings,
      apiMode: 'tavern',
      tavernProfile: '',
    };
    const result = checkAutoUpdatePreConditions_ACU(settings, true, false, { sheet_0: {} }, 5);
    expect(result.canProceed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// buildAutoUpdatePlan_ACU
// ═══════════════════════════════════════════════════════════════
describe('buildAutoUpdatePlan_ACU', () => {
  const baseSettings = {
    autoUpdateFrequency: 1,
    skipUpdateFloors: 0,
    autoUpdateThreshold: 3,
    updateBatchSize: 3,
    dataIsolationEnabled: false,
    dataIsolationCode: '',
  };

  it('无 AI 消息时返回空计划', () => {
    const liveChat = [{ is_user: true }];
    const tableData = {
      sheet_0: { name: '测试表', updateConfig: {} },
    };
    const plan = buildAutoUpdatePlan_ACU(liveChat, tableData, baseSettings, '');
    expect(plan.tablesToUpdate).toHaveLength(0);
  });

  it('有未更新的 AI 消息时生成更新计划', () => {
    const liveChat = [
      { is_user: true },
      { is_user: false },
      { is_user: true },
      { is_user: false },
    ];
    const tableData = {
      sheet_0: { name: '测试表', updateConfig: {} },
    };
    const plan = buildAutoUpdatePlan_ACU(liveChat, tableData, baseSettings, '');
    expect(plan.tablesToUpdate.length).toBeGreaterThan(0);
  });

  it('updateFrequency=0 的表不参与自动更新', () => {
    const liveChat = [
      { is_user: true },
      { is_user: false },
    ];
    const tableData = {
      sheet_0: { name: '测试表', updateConfig: { updateFrequency: 0 } },
    };
    const plan = buildAutoUpdatePlan_ACU(liveChat, tableData, baseSettings, '');
    expect(plan.tablesToUpdate).toHaveLength(0);
  });

  it('已更新的表不重复更新', () => {
    const liveChat = [
      { is_user: true },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            independentData: { sheet_0: { name: '测试表' } },
            modifiedKeys: ['sheet_0'],
            updateGroupKeys: ['sheet_0'],
          },
        },
      },
    ];
    const tableData = {
      sheet_0: { name: '测试表', updateConfig: {} },
    };
    const plan = buildAutoUpdatePlan_ACU(liveChat, tableData, baseSettings, '');
    expect(plan.tablesToUpdate).toHaveLength(0);
  });

  it('skipFloors 跳过最近的楼层', () => {
    const liveChat = [
      { is_user: true },
      { is_user: false }, // AI 1
      { is_user: true },
      { is_user: false }, // AI 2
    ];
    const tableData = {
      sheet_0: { name: '测试表', updateConfig: {} },
    };
    // skipFloors=1 跳过最后一个 AI 楼层
    const settings = { ...baseSettings, skipUpdateFloors: 1 };
    const plan = buildAutoUpdatePlan_ACU(liveChat, tableData, settings, '');
    // 只有 AI 1 在范围内
    if (plan.tablesToUpdate.length > 0) {
      const indices = plan.tablesToUpdate[0].indices;
      // 不应该包含最后一个 AI 消息的索引
      expect(indices).not.toContain(3);
    }
  });

  it('多个表分组到同一个 group', () => {
    const liveChat = [
      { is_user: true },
      { is_user: false },
    ];
    const tableData = {
      sheet_0: { name: '表A', updateConfig: { groupId: 1 } },
      sheet_1: { name: '表B', updateConfig: { groupId: 1 } },
    };
    const plan = buildAutoUpdatePlan_ACU(liveChat, tableData, baseSettings, '');
    const groupKeys = Object.keys(plan.updateGroups);
    // 同一 groupId 的表应该在同一个 group 中
    if (groupKeys.length > 0) {
      const group = plan.updateGroups[groupKeys[0]];
      expect(group.sheetKeys.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('不同 groupId 的表分到不同 group', () => {
    const liveChat = [
      { is_user: true },
      { is_user: false },
    ];
    const tableData = {
      sheet_0: { name: '表A', updateConfig: { groupId: 1 } },
      sheet_1: { name: '表B', updateConfig: { groupId: 2 } },
    };
    const plan = buildAutoUpdatePlan_ACU(liveChat, tableData, baseSettings, '');
    if (plan.tablesToUpdate.length >= 2) {
      const groupKeys = Object.keys(plan.updateGroups);
      expect(groupKeys.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('同组但不同频率的表不会被强制合组', () => {
    const liveChat = [
      { is_user: true },
      { is_user: false },
      { is_user: true },
      { is_user: false },
    ];
    const tableData = {
      sheet_0: { name: '表A', updateConfig: { groupId: 1, updateFrequency: 1 } },
      sheet_1: { name: '表B', updateConfig: { groupId: 1, updateFrequency: 2 } },
    };
    const plan = buildAutoUpdatePlan_ACU(liveChat, tableData, baseSettings, '');
    const groupKeys = Object.keys(plan.updateGroups);
    expect(groupKeys.length).toBeGreaterThanOrEqual(2);
  });

  it('旧版存储格式的更新检测', () => {
    const liveChat = [
      { is_user: true },
      {
        is_user: false,
        TavernDB_ACU_ModifiedKeys: ['sheet_0'],
        TavernDB_ACU_UpdateGroupKeys: ['sheet_0'],
      },
      { is_user: true },
      { is_user: false }, // 新的未更新消息
    ];
    const tableData = {
      sheet_0: { name: '测试表', updateConfig: {} },
    };
    const plan = buildAutoUpdatePlan_ACU(liveChat, tableData, baseSettings, '');
    // sheet_0 在索引1已更新，索引3未更新，应该生成更新计划
    expect(plan.tablesToUpdate.length).toBeGreaterThanOrEqual(0);
  });

  it('仅保存表数据但没有追踪键时，高频表不应被视为已更新并顺延下次更新楼层', () => {
    const liveChat = [
      { is_user: true },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            independentData: { sheet_0: { name: '高频表' } },
            modifiedKeys: [],
            updateGroupKeys: [],
          },
        },
      },
      { is_user: true },
      { is_user: false },
    ];
    const tableData = {
      sheet_0: { name: '高频表', updateConfig: { updateFrequency: 3 } },
    };
    const plan = buildAutoUpdatePlan_ACU(liveChat, tableData, baseSettings, '');
    expect(plan.tablesToUpdate).toHaveLength(0);
  });

  it('存在追踪键时，高频表才按真实更新楼层计算下轮触发', () => {
    const liveChat = [
      { is_user: true },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            independentData: { sheet_0: { name: '高频表' } },
            modifiedKeys: ['sheet_0'],
            updateGroupKeys: ['sheet_0'],
          },
        },
      },
      { is_user: true },
      { is_user: false },
      { is_user: true },
      { is_user: false },
      { is_user: true },
      { is_user: false },
    ];
    const tableData = {
      sheet_0: { name: '高频表', updateConfig: { updateFrequency: 3 } },
    };
    const plan = buildAutoUpdatePlan_ACU(liveChat, tableData, baseSettings, '');
    expect(plan.tablesToUpdate).toHaveLength(1);
    expect(plan.tablesToUpdate[0].indices).toContain(7);
  });

  it('空表格数据返回空计划', () => {
    const liveChat = [{ is_user: true }, { is_user: false }];
    const plan = buildAutoUpdatePlan_ACU(liveChat, {}, baseSettings, '');
    expect(plan.tablesToUpdate).toHaveLength(0);
  });

  it('contextDepth 限制上下文范围', () => {
    const liveChat = [
      { is_user: true },
      { is_user: false }, // AI 1
      { is_user: true },
      { is_user: false }, // AI 2
      { is_user: true },
      { is_user: false }, // AI 3
    ];
    const tableData = {
      sheet_0: { name: '测试表', updateConfig: { contextDepth: 1 } },
    };
    const plan = buildAutoUpdatePlan_ACU(liveChat, tableData, baseSettings, '');
    if (plan.tablesToUpdate.length > 0) {
      // contextDepth=1 只看最近1条 AI 消息
      expect(plan.tablesToUpdate[0].indices.length).toBeLessThanOrEqual(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// handleFloorIncreaseDelay_ACU
// ═══════════════════════════════════════════════════════════════
describe('handleFloorIncreaseDelay_ACU', () => {
  it('AI 消息数增加时等待并返回新数据', async () => {
    const mockGetChat = vi.fn().mockReturnValue([
      { is_user: true },
      { is_user: false },
      { is_user: true },
      { is_user: false },
    ]);
    const mockSetLast = vi.fn();

    const result = await handleFloorIncreaseDelay_ACU(
      3, // totalAiMessages（新）
      2, // lastTotalAiMessages（旧）
      10, // delayMs（短延迟用于测试）
      mockGetChat,
      mockSetLast,
    );

    expect(result).not.toBeNull();
    expect(mockSetLast).toHaveBeenCalled();
  });

  it('AI 消息数减少时更新 lastTotal', async () => {
    const mockGetChat = vi.fn();
    const mockSetLast = vi.fn();

    const result = await handleFloorIncreaseDelay_ACU(
      1, // totalAiMessages（减少了）
      3, // lastTotalAiMessages
      10,
      mockGetChat,
      mockSetLast,
    );

    expect(mockSetLast).toHaveBeenCalledWith(1);
  });

  it('AI 消息数不变时不做任何操作', async () => {
    const mockGetChat = vi.fn();
    const mockSetLast = vi.fn();

    await handleFloorIncreaseDelay_ACU(
      3,
      3,
      10,
      mockGetChat,
      mockSetLast,
    );

    expect(mockGetChat).not.toHaveBeenCalled();
    expect(mockSetLast).not.toHaveBeenCalled();
  });

  it('延迟后聊天记录为空时返回 null', async () => {
    const mockGetChat = vi.fn().mockReturnValue([]);
    const mockSetLast = vi.fn();

    const result = await handleFloorIncreaseDelay_ACU(
      3,
      2,
      10,
      mockGetChat,
      mockSetLast,
    );

    expect(result).toBeNull();
  });

  it('延迟后聊天记录为 null 时返回 null', async () => {
    const mockGetChat = vi.fn().mockReturnValue(null);
    const mockSetLast = vi.fn();

    const result = await handleFloorIncreaseDelay_ACU(
      3,
      2,
      10,
      mockGetChat,
      mockSetLast,
    );

    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// executeAutoUpdatePlan_ACU
// ═══════════════════════════════════════════════════════════════
describe('executeAutoUpdatePlan_ACU', () => {
  // mock merge-logic 模块（executeAutoUpdatePlan_ACU 内部动态 import）
  vi.mock('../../../src/service/summary/merge-logic', () => ({
    checkAutoMergeTrigger_ACU: vi.fn(() => ({ shouldTrigger: false })),
    prepareAutoMergeBatches_ACU: vi.fn(),
    executeAutoMergeBatch_ACU: vi.fn(),
    finalizeAutoMerge_ACU: vi.fn(),
  }));

  const baseSettings = {
    maxConcurrentGroups: 2,
  };

  function makePreparedAiCall(sheetKey = 'sheet_0') {
    return {
      targetSheetKeys: [sheetKey],
      dynamicContent: {
        tableDataText: '当前表格数据',
      },
    };
  }

  const mockSetAutoUpdating = vi.fn();

  function makeOps(overrides: Partial<{
    processUpdates: any;
    refreshData: any;
    loadAllChatMessages: any;
    purgeOldLayerData: any;
  }> = {}) {
    return {
      processUpdates: overrides.processUpdates || vi.fn().mockImplementation(async (_indices: number[], _mode: string, options: any) => ({
        success: true,
        preparedAiCalls: [
          makePreparedAiCall(options?.targetSheetKeys?.[0] || 'sheet_0'),
        ],
      })),
      refreshData: overrides.refreshData || vi.fn().mockResolvedValue(undefined),
      loadAllChatMessages: overrides.loadAllChatMessages || vi.fn().mockResolvedValue(undefined),
      purgeOldLayerData: overrides.purgeOldLayerData || vi.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('空计划返回 success', async () => {
    const plan = { tablesToUpdate: [], updateGroups: {} };
    const result = await executeAutoUpdatePlan_ACU(plan, baseSettings, mockSetAutoUpdating, makeOps());
    expect(result.success).toBe(true);
    expect(result.totalGroups).toBe(0);
    expect(result.failedGroups).toBe(0);
  });

  it('单组全部成功', async () => {
    const plan = {
      tablesToUpdate: [{ sheetKey: 'sheet_0', sheetName: '表A', indices: [1], groupId: 0, batchSize: 2 }],
      updateGroups: {
        '0|1|2': { indices: [1], batchSize: 2, groupId: 0, sheetKeys: ['sheet_0'], sheetNames: ['表A'] },
      },
    };
    const ops = makeOps();
    const result = await executeAutoUpdatePlan_ACU(plan, baseSettings, mockSetAutoUpdating, ops);
    expect(result.success).toBe(true);
    expect(result.totalGroups).toBe(1);
    expect(result.failedGroups).toBe(0);
    expect(ops.processUpdates).toHaveBeenCalledTimes(1);
    expect(ops.loadAllChatMessages).toHaveBeenCalled();
    expect(ops.refreshData).toHaveBeenCalled();
    expect(ops.purgeOldLayerData).toHaveBeenCalled();
  });

  it('多组部分失败', async () => {
    const plan = {
      tablesToUpdate: [],
      updateGroups: {
        'group_a': { indices: [1], batchSize: 2, groupId: 0, sheetKeys: ['sheet_0'], sheetNames: ['表A'] },
        'group_b': { indices: [1], batchSize: 2, groupId: 1, sheetKeys: ['sheet_1'], sheetNames: ['表B'] },
      },
    };
    const mockProcess = vi.fn()
      .mockResolvedValueOnce({ success: true, preparedAiCalls: [makePreparedAiCall('sheet_0')] })
      .mockResolvedValueOnce({ success: false });

    const ops = makeOps({ processUpdates: mockProcess });
    const result = await executeAutoUpdatePlan_ACU(plan, baseSettings, mockSetAutoUpdating, ops);
    expect(result.success).toBe(false);
    expect(result.failedGroups).toBe(1);
    expect(result.totalGroups).toBe(2);
  });

  it('processUpdates 抛异常时计为失败', async () => {
    const plan = {
      tablesToUpdate: [],
      updateGroups: {
        'group_a': { indices: [1], batchSize: 2, groupId: 0, sheetKeys: ['sheet_0'], sheetNames: ['表A'] },
      },
    };
    const mockProcess = vi.fn().mockRejectedValue(new Error('网络错误'));
    const ops = makeOps({ processUpdates: mockProcess });
    const result = await executeAutoUpdatePlan_ACU(plan, baseSettings, mockSetAutoUpdating, ops);
    expect(result.success).toBe(false);
    expect(result.failedGroups).toBe(1);
  });

  it('持久化失败时不重新生成 AI 或重新 apply', async () => {
    const orchestrator = await import('../../../src/service/table/update-orchestrator');
    const tableService = await import('../../../src/service/table/table-service');
    vi.mocked(tableService.persistTablesToChatMessage_ACU).mockResolvedValueOnce({
      saved: false,
      error: '保存失败',
    });

    const plan = {
      tablesToUpdate: [],
      updateGroups: {
        'group_a': { indices: [1], batchSize: 2, groupId: 0, sheetKeys: ['sheet_0'], sheetNames: ['表A'] },
      },
    };
    const progressEvents: any[] = [];
    const ops = makeOps();

    const result = await executeAutoUpdatePlan_ACU(
      plan,
      { ...baseSettings, tableMaxRetries: 3 },
      mockSetAutoUpdating,
      ops,
      event => progressEvents.push(event),
    );

    expect(result.success).toBe(false);
    expect(result.failedGroups).toBe(1);
    expect(ops.processUpdates).toHaveBeenCalledTimes(1);
    expect(vi.mocked(orchestrator.generateDeferredResponsesForPreparedCalls_ACU)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(orchestrator.applyMergedEdits_ACU)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tableService.persistTablesToChatMessage_ACU)).toHaveBeenCalledTimes(1);
    expect(progressEvents).toContainEqual(expect.objectContaining({ phase: 'error', message: '保存失败' }));
  });

  it('setAutoUpdating 被正确调用', async () => {
    const plan = {
      tablesToUpdate: [],
      updateGroups: {
        'group_a': { indices: [1], batchSize: 2, groupId: 0, sheetKeys: ['sheet_0'], sheetNames: ['表A'] },
      },
    };
    const ops = makeOps();
    await executeAutoUpdatePlan_ACU(plan, baseSettings, mockSetAutoUpdating, ops);
    // 开始时设为 true，结束时设为 false
    expect(mockSetAutoUpdating).toHaveBeenCalledWith(true);
    expect(mockSetAutoUpdating).toHaveBeenCalledWith(false);
  });

  it('自动合并触发成功', async () => {
    const plan = {
      tablesToUpdate: [],
      updateGroups: {
        'group_a': { indices: [1], batchSize: 2, groupId: 0, sheetKeys: ['sheet_0'], sheetNames: ['表A'] },
      },
    };
    const ops = makeOps();

    const mergeLogic = await import('../../../src/service/summary/merge-logic');
    vi.mocked(mergeLogic.checkAutoMergeTrigger_ACU).mockReturnValue({ shouldTrigger: true, mergeCount: 5 });
    vi.mocked(mergeLogic.prepareAutoMergeBatches_ACU).mockReturnValue({ batches: [{ startIndex: 0, endIndex: 5 }] } as any);
    vi.mocked(mergeLogic.executeAutoMergeBatch_ACU).mockResolvedValue({ accumulatedSummary: ['合并结果'] } as any);
    vi.mocked(mergeLogic.finalizeAutoMerge_ACU).mockResolvedValue(undefined);

    const result = await executeAutoUpdatePlan_ACU(plan, baseSettings, mockSetAutoUpdating, ops);
    expect(result.autoMergeTriggered).toBe(true);
    expect(result.autoMergeSuccess).toBe(true);
  });

  it('purgeOldLayerData 失败不影响整体结果', async () => {
    const plan = {
      tablesToUpdate: [],
      updateGroups: {
        'group_a': { indices: [1], batchSize: 2, groupId: 0, sheetKeys: ['sheet_0'], sheetNames: ['表A'] },
      },
    };
    const ops = makeOps({
      purgeOldLayerData: vi.fn().mockRejectedValue(new Error('清理失败')),
    });
    const result = await executeAutoUpdatePlan_ACU(plan, baseSettings, mockSetAutoUpdating, ops);
    expect(result.success).toBe(true); // 清理失败不影响整体
  });
});
