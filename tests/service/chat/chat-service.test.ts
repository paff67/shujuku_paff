/**
 * tests/service/chat/chat-service.test.ts
 * 聊天数据服务 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSettings, mockCurrentJsonTableData, mockGetChatArray, mockSaveChatToHost, mockSetChatMessages, mockEmitMessageUpdated, mockGetCurrentIsolationKey, mockGetLastOptimizationBase, mockSetLastOptimizationBase, mockSanitizeSheet, mockPersistTablesToChatMessage, mockDeleteSummaryVectorIndexExternal } = vi.hoisted(() => ({
  mockSettings: {
    retainRecentLayers: 3,
    dataIsolationEnabled: false,
    dataIsolationCode: '',
  } as any,
  mockCurrentJsonTableData: {
    sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '剑']] },
    sheet_1: { name: '纪要表', content: [['row_id', '事件'], ['1', '开始']] },
  } as any,
  mockGetChatArray: vi.fn(),
  mockSaveChatToHost: vi.fn(),
  mockSetChatMessages: vi.fn(),
  mockEmitMessageUpdated: vi.fn(),
  mockGetCurrentIsolationKey: vi.fn(() => ''),
  mockGetLastOptimizationBase: vi.fn((): any => null),
  mockSetLastOptimizationBase: vi.fn(),
  mockSanitizeSheet: vi.fn((sheet: any) => sheet),
  mockPersistTablesToChatMessage: vi.fn().mockResolvedValue({ saved: true }),
  mockDeleteSummaryVectorIndexExternal: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../src/data/gateways/chat-gateway', () => ({
  getChatArray_ACU: mockGetChatArray,
  getChatLength_ACU: vi.fn(() => 0),
  getLastMessageIndex_ACU: vi.fn(() => -1),
  saveChatToHost_ACU: mockSaveChatToHost,
  stopGeneration_ACU: vi.fn(),
  deleteLastMessage_ACU: vi.fn(),
  setChatMessages_ACU: mockSetChatMessages,
  emitMessageUpdated_ACU: mockEmitMessageUpdated,
}));

vi.mock('../../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
  logError_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
  isSummaryOrOutlineTable_ACU: vi.fn((name: string) => name.includes('纪要') || name.includes('总结')),
}));

vi.mock('../../../src/service/optimization/content-optimization', () => ({
  getLastOptimizationBase_ACU: mockGetLastOptimizationBase,
  setLastOptimizationBase_ACU: mockSetLastOptimizationBase,
}));

vi.mock('../../../src/service/vector/summary-vector-index-storage-service', () => ({
  deleteSummaryVectorIndexExternal_ACU: (...args: any[]) => mockDeleteSummaryVectorIndexExternal(...args),
}));

vi.mock('../../../src/service/vector/summary-vector-index-state-service', () => ({
  assignSummaryVectorIndexStateToTagData_ACU: vi.fn(),
}));

vi.mock('../../../src/service/table/table-service', () => ({
  persistTablesToChatMessage_ACU: (...args: any[]) => mockPersistTablesToChatMessage(...args),
}));

vi.mock('../../../src/service/runtime/state-manager', () => ({
  settings_ACU: mockSettings,
  currentJsonTableData_ACU: mockCurrentJsonTableData,
  getCurrentIsolationKey_ACU: mockGetCurrentIsolationKey,
}));

vi.mock('../../../src/service/template/chat-scope', () => ({
  sanitizeSheetForStorage_ACU: mockSanitizeSheet,
}));

import {
  replaceChatMessage_ACU,
  getOriginalContent_ACU,
  purgeOldLayerData_ACU,
  deleteLocalDataInChatCore_ACU,
  overrideLatestLayerWithTemplateCore_ACU,
  saveCurrentDataForTable_ACU,
  clearTableDataAtFloors_ACU,
} from '../../../src/service/chat/chat-service';

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings.retainRecentLayers = 3;
  mockSettings.dataIsolationEnabled = false;
  mockSettings.dataIsolationCode = '';
  mockGetCurrentIsolationKey.mockReturnValue('');
  mockSaveChatToHost.mockResolvedValue(undefined);
});

// ═══ replaceChatMessage_ACU ═══
describe('replaceChatMessage_ACU', () => {
  it('成功替换消息内容', async () => {
    const chat = [
      { is_user: true, mes: '你好' },
      { is_user: false, mes: '原始内容', message_id: 'msg1', extra: {} },
    ];
    mockGetChatArray.mockReturnValue(chat);
    mockSetChatMessages.mockResolvedValue(true);
    const result = await replaceChatMessage_ACU(1, '新内容');
    expect(result).toBe(true);
    expect(mockSetChatMessages).toHaveBeenCalledWith(
      [expect.objectContaining({ message_id: 'msg1', mes: '新内容' })],
      { refresh: 'affected' },
    );
  });

  it('消息不存在返回 false', async () => {
    mockGetChatArray.mockReturnValue([]);
    const result = await replaceChatMessage_ACU(5, '新内容');
    expect(result).toBe(false);
  });

  it('setChatMessages 不可用时使用降级方案', async () => {
    const chat = [
      { is_user: false, mes: '原始内容', message_id: 'msg1', extra: {} },
    ];
    mockGetChatArray.mockReturnValue(chat);
    mockSetChatMessages.mockResolvedValue(false);
    const result = await replaceChatMessage_ACU(0, '新内容');
    expect(result).toBe(true);
    expect(chat[0].mes).toBe('新内容');
    expect(mockSaveChatToHost).toHaveBeenCalled();
  });

  it('保存原始内容到 extra._acu_original_content', async () => {
    const chat = [
      { is_user: false, mes: '原始内容', message_id: 'msg1', extra: {} },
    ];
    mockGetChatArray.mockReturnValue(chat);
    mockSetChatMessages.mockResolvedValue(true);
    await replaceChatMessage_ACU(0, '新内容');
    expect(mockSetChatMessages).toHaveBeenCalledWith(
      [expect.objectContaining({
        extra: expect.objectContaining({ _acu_original_content: '原始内容' }),
      })],
      expect.anything(),
    );
  });
});

// ═══ getOriginalContent_ACU ═══
describe('getOriginalContent_ACU', () => {
  it('从缓存获取原始内容', () => {
    mockGetLastOptimizationBase.mockReturnValue({
      messageIndex: 1,
      messageId: 'msg1',
      baseContent: '原始内容',
    });
    mockGetChatArray.mockReturnValue([
      { is_user: true },
      { is_user: false, message_id: 'msg1' },
    ]);
    expect(getOriginalContent_ACU(1)).toBe('原始内容');
  });

  it('从 extra 获取原始内容', () => {
    mockGetLastOptimizationBase.mockReturnValue(null);
    mockGetChatArray.mockReturnValue([
      { is_user: false, extra: { _acu_original_content: '从extra获取' } },
    ]);
    expect(getOriginalContent_ACU(0)).toBe('从extra获取');
  });

  it('消息不存在返回 null', () => {
    mockGetLastOptimizationBase.mockReturnValue(null);
    mockGetChatArray.mockReturnValue([]);
    expect(getOriginalContent_ACU(5)).toBeNull();
  });
});

// ═══ purgeOldLayerData_ACU ═══
describe('purgeOldLayerData_ACU', () => {
  function makeV2Layer(rows: string[][]) {
    return {
      version: 2,
      checkpoint: {
        kind: 'checkpoint',
        version: 2,
        checkpointId: 'checkpoint-test',
        createdAt: '2026-05-08T00:00:00.000Z',
        source: 'template-seed',
        isolationKey: '',
        data: {
          mate: { type: 'chatSheets', version: 1 },
          sheet_0: { name: '物品表', content: [['row_id', '物品名'], ...rows] },
        },
      },
    };
  }

  it('清理超出保留层数的旧表格数据前写入 boundary checkpoint，并只清理剧情字段', async () => {
    mockSettings.retainRecentLayers = 1;
    const chat: any[] = [
      { is_user: false },
      { is_user: false, TavernDB_ACU_IsolatedData: { '': { tablePersistenceV2: makeV2Layer([['1', '剑']]) } }, qrf_plot: { step: 1 } },
      { is_user: false, TavernDB_ACU_IsolatedData: { '': { tablePersistenceV2: makeV2Layer([['2', '盾']]) } }, qrf_plot_tasks: ['old'] },
    ];
    mockGetChatArray.mockReturnValue(chat);

    await purgeOldLayerData_ACU();

    expect(chat[1].TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(chat[1].qrf_plot).toBeUndefined();
    expect(chat[2].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.source).toBe('retention-rollup');
    expect(chat[2].qrf_plot_tasks).toEqual(['old']);
    expect(mockSaveChatToHost).toHaveBeenCalled();
  });

  it('retention 清理表格层时不删除 summary vector manifest 外置引用', async () => {
    mockSettings.retainRecentLayers = 1;
    const manifest = { file: 'summary-index.json' };
    const chat: any[] = [
      { is_user: false },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            tablePersistenceV2: makeV2Layer([['1', '剑']]),
            summaryVectorIndexManifest: manifest,
            summaryVectorIndexState: { manifest },
          },
        },
      },
      { is_user: false, TavernDB_ACU_IsolatedData: { '': { tablePersistenceV2: makeV2Layer([['2', '盾']]) } } },
    ];
    mockGetChatArray.mockReturnValue(chat);

    await purgeOldLayerData_ACU();

    expect(chat[1].TavernDB_ACU_IsolatedData[''].summaryVectorIndexManifest).toEqual(manifest);
    expect(chat[1].TavernDB_ACU_IsolatedData[''].summaryVectorIndexState).toEqual({ manifest });
    expect(mockDeleteSummaryVectorIndexExternal).not.toHaveBeenCalled();
  });

  it('retainRecentLayers=0 时跳过', async () => {
    mockSettings.retainRecentLayers = 0;
    mockGetChatArray.mockReturnValue([]);
    await purgeOldLayerData_ACU();
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
  });

  it('数据层数不超过保留数时不清理', async () => {
    mockSettings.retainRecentLayers = 10;
    const chat = [
      { is_user: false },
      { is_user: false, TavernDB_ACU_Data: {} },
    ];
    mockGetChatArray.mockReturnValue(chat);
    await purgeOldLayerData_ACU();
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
  });
});

// ═══ deleteLocalDataInChatCore_ACU ═══
describe('deleteLocalDataInChatCore_ACU', () => {
  it('mode=all 删除所有数据', async () => {
    const chat = [
      { is_user: true },
      { is_user: false, TavernDB_ACU_Data: { sheet_0: {} }, TavernDB_ACU_SummaryData: {} },
      { is_user: false, TavernDB_ACU_Data: { sheet_0: {} } },
    ];
    mockGetChatArray.mockReturnValue(chat);
    const count = await deleteLocalDataInChatCore_ACU('all');
    expect(count).toBe(2);
    expect(chat[1].TavernDB_ACU_Data).toBeUndefined();
    expect(chat[2].TavernDB_ACU_Data).toBeUndefined();
  });

  it('空聊天记录返回 0', async () => {
    mockGetChatArray.mockReturnValue([]);
    const count = await deleteLocalDataInChatCore_ACU('all');
    expect(count).toBe(0);
  });

  it('mode=current 只删除当前隔离标签的数据', async () => {
    mockSettings.dataIsolationEnabled = true;
    mockSettings.dataIsolationCode = 'tag_A';
    mockGetCurrentIsolationKey.mockReturnValue('tag_A');
    const chat = [
      { is_user: false, TavernDB_ACU_Data: {}, TavernDB_ACU_Identity: 'tag_A', TavernDB_ACU_IsolatedData: { tag_A: { independentData: {} } } },
      { is_user: false, TavernDB_ACU_Data: {}, TavernDB_ACU_Identity: 'tag_B' },
    ];
    mockGetChatArray.mockReturnValue(chat);
    const count = await deleteLocalDataInChatCore_ACU('current');
    expect(count).toBe(1);
  });

  it('指定楼层范围', async () => {
    const chat = [
      { is_user: false, TavernDB_ACU_Data: {} }, // AI楼层1
      { is_user: false, TavernDB_ACU_Data: {} }, // AI楼层2
      { is_user: false, TavernDB_ACU_Data: {} }, // AI楼层3
    ];
    mockGetChatArray.mockReturnValue(chat);
    const count = await deleteLocalDataInChatCore_ACU('all', 1, 2);
    expect(count).toBe(2);
    expect(chat[2].TavernDB_ACU_Data).toBeDefined(); // 第3层不在范围内
  });
});

// ═══ overrideLatestLayerWithTemplateCore_ACU ═══
describe('overrideLatestLayerWithTemplateCore_ACU', () => {
  it('用模板覆盖最新层', async () => {
    const chat = [
      { is_user: true },
      { is_user: false, TavernDB_ACU_IsolatedData: {} },
    ];
    mockGetChatArray.mockReturnValue(chat);
    const templateData = {
      sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '剑'], ['2', '盾']] },
    };
    const count = await overrideLatestLayerWithTemplateCore_ACU(templateData);
    expect(count).toBe(1);
    expect(mockSaveChatToHost).toHaveBeenCalled();
  });

  it('空聊天记录返回 0', async () => {
    mockGetChatArray.mockReturnValue([]);
    const count = await overrideLatestLayerWithTemplateCore_ACU({ sheet_0: { name: '表' } });
    expect(count).toBe(0);
  });

  it('无 AI 消息返回 0', async () => {
    mockGetChatArray.mockReturnValue([{ is_user: true }]);
    const count = await overrideLatestLayerWithTemplateCore_ACU({ sheet_0: { name: '表' } });
    expect(count).toBe(0);
  });

  it('覆盖后只保留表头', async () => {
    const chat: any[] = [{ is_user: false }];
    mockGetChatArray.mockReturnValue(chat);
    const templateData = {
      sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '剑'], ['2', '盾']] },
    };
    await overrideLatestLayerWithTemplateCore_ACU(templateData);
    const isolatedData = chat[0].TavernDB_ACU_IsolatedData?.[''];
    expect(isolatedData.independentData.sheet_0.content.length).toBe(1); // 只有表头
  });
});

// ═══ saveCurrentDataForTable_ACU ═══
describe('saveCurrentDataForTable_ACU', () => {
  it('无数据时不报错', async () => {
    mockCurrentJsonTableData.sheet_0 = undefined;
    await expect(saveCurrentDataForTable_ACU('sheet_0')).resolves.not.toThrow();
  });
  it('无聊天记录时不报错', async () => {
    mockGetChatArray.mockReturnValue([]);
    await expect(saveCurrentDataForTable_ACU('sheet_0')).resolves.not.toThrow();
  });
  it('标准表通过 V2 保存入口持久化到目标 AI 楼层', async () => {
    const chat: any[] = [{ is_user: false, mes: 'AI回复' }];
    mockGetChatArray.mockReturnValue(chat);
    mockCurrentJsonTableData.sheet_0 = { name: '物品表', content: [['row_id', '物品名'], ['1', '剑']] };

    await saveCurrentDataForTable_ACU('sheet_0');

    expect(mockPersistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetMessageIndex: 0,
      targetSheetKeys: ['sheet_0'],
      updateGroupKeys: null,
      trackAsUpdate: true,
    }));
    expect(chat[0].TavernDB_ACU_Data).toBeUndefined();
  });
  it('纪要表通过 V2 保存入口持久化，不再直接写 legacy SummaryData', async () => {
    const chat: any[] = [{ is_user: false, mes: 'AI回复' }];
    mockGetChatArray.mockReturnValue(chat);
    mockCurrentJsonTableData.sheet_1 = { name: '纪要表', content: [['row_id', '事件'], ['1', '开始']] };

    await saveCurrentDataForTable_ACU('sheet_1');

    expect(mockPersistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetMessageIndex: 0,
      targetSheetKeys: ['sheet_1'],
      updateGroupKeys: null,
      trackAsUpdate: true,
    }));
    expect(chat[0].TavernDB_ACU_SummaryData).toBeUndefined();
  });
});

// ═══ clearTableDataAtFloors_ACU ═══
describe('clearTableDataAtFloors_ACU', () => {
  function makeV2Message(): any {
    return {
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          independentData: {
            sheet_0: { name: '物品表', content: [['row_id'], ['legacy-0']] },
            sheet_1: { name: '纪要表', content: [['row_id'], ['legacy-1']] },
          },
          modifiedKeys: ['sheet_0', 'sheet_1'],
          updateGroupKeys: ['sheet_0', 'sheet_1'],
          tablePersistenceV2: {
            version: 2,
            checkpoint: {
              kind: 'checkpoint',
              version: 2,
              checkpointId: 'checkpoint-1',
              createdAt: '2026-05-08T00:00:00.000Z',
              source: 'legacy-migration',
              isolationKey: '',
              data: {
                mate: { type: 'chatSheets' },
                sheet_0: { name: '物品表', content: [['row_id'], ['base-0']] },
                sheet_1: { name: '纪要表', content: [['row_id'], ['base-1']] },
              },
            },
            delta: {
              kind: 'delta',
              version: 2,
              deltaId: 'delta-2',
              createdAt: '2026-05-08T00:00:02.000Z',
              isolationKey: '',
              changedSheets: ['sheet_1'],
              modifiedKeys: ['sheet_1'],
              updateGroupKeys: ['sheet_1'],
              changesBySheet: {
                sheet_1: { sheetKey: 'sheet_1', rowChanges: [{ op: 'upsert', rowId: '3', row: ['3'] }] },
              },
              sequence: 1,
            },
            deltas: [
              {
                kind: 'delta',
                version: 2,
                deltaId: 'delta-1',
                createdAt: '2026-05-08T00:00:01.000Z',
                isolationKey: '',
                changedSheets: ['sheet_0'],
                modifiedKeys: ['sheet_0'],
                updateGroupKeys: ['sheet_0'],
                changesBySheet: {
                  sheet_0: { sheetKey: 'sheet_0', rowChanges: [{ op: 'upsert', rowId: '2', row: ['2'] }] },
                },
                sequence: 0,
              },
              {
                kind: 'delta',
                version: 2,
                deltaId: 'delta-2',
                createdAt: '2026-05-08T00:00:02.000Z',
                isolationKey: '',
                changedSheets: ['sheet_1'],
                modifiedKeys: ['sheet_1'],
                updateGroupKeys: ['sheet_1'],
                changesBySheet: {
                  sheet_1: { sheetKey: 'sheet_1', rowChanges: [{ op: 'upsert', rowId: '3', row: ['3'] }] },
                },
                sequence: 1,
              },
            ],
          },
        },
      },
      TavernDB_ACU_Data: {
        sheet_0: { name: '物品表', content: [['row_id'], ['legacy-root-0']] },
      },
      TavernDB_ACU_SummaryData: {
        sheet_1: { name: '纪要表', content: [['row_id'], ['legacy-root-1']] },
      },
      TavernDB_ACU_ModifiedKeys: ['sheet_0', 'sheet_1'],
      TavernDB_ACU_UpdateGroupKeys: ['sheet_0', 'sheet_1'],
    };
  }

  it('指定目标表时只删除目标 sheet 的 V2 delta contribution，并保留 checkpoint 与其他 sheet delta', async () => {
    const msg = makeV2Message();
    mockGetChatArray.mockReturnValue([msg]);

    const count = await clearTableDataAtFloors_ACU([0], ['sheet_0']);

    const tagData = msg.TavernDB_ACU_IsolatedData[''];
    expect(count).toBe(1);
    expect(tagData.tablePersistenceV2.checkpoint).toBeDefined();
    expect(tagData.tablePersistenceV2.deltas).toHaveLength(1);
    expect(tagData.tablePersistenceV2.deltas[0].deltaId).toBe('delta-2');
    expect(tagData.tablePersistenceV2.deltas[0].changesBySheet.sheet_1).toBeDefined();
    expect(tagData.tablePersistenceV2.delta.changesBySheet.sheet_1).toBeDefined();
    expect(tagData.tablePersistenceV2.delta.changedSheets).toEqual(['sheet_1']);
    expect(tagData.tablePersistenceV2.delta.modifiedKeys).toEqual(['sheet_1']);
    expect(tagData.tablePersistenceV2.delta.updateGroupKeys).toEqual(['sheet_1']);
    expect(tagData.independentData.sheet_0).toBeUndefined();
    expect(tagData.independentData.sheet_1).toBeDefined();
    expect(mockSaveChatToHost).toHaveBeenCalled();
  });

  it('目标表清理后 delta 为空时删除 delta 但保留 checkpoint', async () => {
    const msg = makeV2Message();
    const tagData = msg.TavernDB_ACU_IsolatedData[''];
    tagData.tablePersistenceV2.deltas = [tagData.tablePersistenceV2.deltas[0]];
    tagData.tablePersistenceV2.delta = tagData.tablePersistenceV2.deltas[0];
    tagData.tablePersistenceV2.delta.changedSheets = ['sheet_0'];
    tagData.tablePersistenceV2.delta.modifiedKeys = ['sheet_0'];
    tagData.tablePersistenceV2.delta.updateGroupKeys = ['sheet_0'];
    mockGetChatArray.mockReturnValue([msg]);

    const count = await clearTableDataAtFloors_ACU([0], ['sheet_0']);

    expect(count).toBe(1);
    expect(tagData.tablePersistenceV2.checkpoint).toBeDefined();
    expect(tagData.tablePersistenceV2.delta).toBeUndefined();
    expect(tagData.tablePersistenceV2.deltas).toBeUndefined();
    expect(mockSaveChatToHost).toHaveBeenCalled();
  });

  it('未指定目标表时只删除当前楼层 delta，不删除 checkpoint', async () => {
    const msg = makeV2Message();
    mockGetChatArray.mockReturnValue([msg]);

    const count = await clearTableDataAtFloors_ACU([0], null);

    const tagData = msg.TavernDB_ACU_IsolatedData[''];
    expect(count).toBe(1);
    expect(tagData.tablePersistenceV2.checkpoint).toBeDefined();
    expect(tagData.tablePersistenceV2.delta).toBeUndefined();
    expect(tagData.tablePersistenceV2.deltas).toBeUndefined();
    expect(tagData.independentData).toEqual({});
    expect(tagData.modifiedKeys).toEqual([]);
    expect(tagData.updateGroupKeys).toEqual([]);
    expect(mockSaveChatToHost).toHaveBeenCalled();
  });

  it('只有 tracking keys 被清理时也会保存聊天', async () => {
    const msg: any = {
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          independentData: {},
          modifiedKeys: ['sheet_0'],
          updateGroupKeys: ['sheet_0'],
        },
      },
    };
    mockGetChatArray.mockReturnValue([msg]);

    const count = await clearTableDataAtFloors_ACU([0], ['sheet_0']);

    expect(count).toBe(1);
    expect(msg.TavernDB_ACU_IsolatedData[''].modifiedKeys).toEqual([]);
    expect(msg.TavernDB_ACU_IsolatedData[''].updateGroupKeys).toEqual([]);
    expect(mockSaveChatToHost).toHaveBeenCalled();
  });
});
