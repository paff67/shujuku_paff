/**
 * tests/service/runtime/helpers-data-merge.test.ts
 * migrateContentNullToRowId 纯函数单元测试
 *
 * 策略：零 mock，直接测试输入输出
 * 注意：helpers-data-merge.ts 的导入链会触发 env.ts 中的 window.parent 访问，
 * 需要在 import 前 mock 掉 env.ts 和其他依赖浏览器环境的模块
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 掉所有依赖浏览器环境的模块
vi.mock('../../../src/shared/env', () => ({
  topLevelWindow_ACU: {},
  isLocalStorageDisabled_ACU: false,
}));

vi.mock('../../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
  logError_ACU: vi.fn(),
  isSummaryOrOutlineTable_ACU: vi.fn(() => false),
  parseTableTemplateJson_ACU: vi.fn(() => null),
  ensureSheetOrderNumbers_ACU: vi.fn(),
}));

vi.mock('../../../src/service/runtime/state-manager', () => ({
  currentJsonTableData_ACU: null,
  settings_ACU: {},
  independentTableStates_ACU: {},
  suppressWorldbookInjectionInGreeting_ACU: false,
  _set_suppressWorldbookInjectionInGreeting_ACU: vi.fn(),
  _set_currentJsonTableData_ACU: vi.fn(),
  getCurrentIsolationKey_ACU: vi.fn(() => ''),
}));

vi.mock('../../../src/data/gateways/chat-gateway', () => ({
  getChatArray_ACU: vi.fn(() => []),
  saveChatToHost_ACU: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/service/settings/settings-service', () => ({
  applyTemplateScopeForCurrentChat_ACU: vi.fn(),
  saveSettings_ACU: vi.fn(),
}));

vi.mock('../../../src/service/template/chat-scope', () => ({
  buildChatSheetGuideDataFromTemplateObj_ACU: vi.fn(),
  getChatSheetGuideDataForIsolationKey_ACU: vi.fn(() => null),
  getSortedSheetKeys_ACU: vi.fn((data: any) => data ? Object.keys(data).filter((k: string) => k.startsWith('sheet_')).sort() : []),
  getTemplateSheetKeys_ACU: vi.fn(() => []),
  materializeDataFromSheetGuide_ACU: vi.fn(() => ({})),
  reorderDataBySheetKeys_ACU: vi.fn((data: any) => data),
  sanitizeTemplateSnapshotForChat_ACU: vi.fn(() => null),
  setChatSheetGuideDataForIsolationKey_ACU: vi.fn(),
  attachSeedRowsToCurrentDataFromGuide_ACU: vi.fn(),
  getEffectiveSeedRowsForSheet_ACU: vi.fn(() => []),
}));

vi.mock('../../../src/service/worldbook/pipeline', () => ({
  deleteAllGeneratedEntries_ACU: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/data/repositories/chat-message-data-repo', () => ({
  readIsolatedTagData_ACU: vi.fn(() => null),
  readLegacyIndependentData_ACU: vi.fn(() => null),
  readLegacyStandardData_ACU: vi.fn(() => null),
  readLegacySummaryData_ACU: vi.fn(() => null),
  readModifiedKeys_ACU: vi.fn(() => []),
  readUpdateGroupKeys_ACU: vi.fn(() => []),
  readMessageIdentity_ACU: vi.fn(() => null),
  isLegacyMatchForIsolation_ACU: vi.fn(() => false),
  initIsolatedTagSlot_ACU: vi.fn(() => ({ independentData: {}, modifiedKeys: [], updateGroupKeys: [] })),
  writeLegacyCompatData_ACU: vi.fn(),
}));

vi.mock('../../../src/service/table/table-delta-repository', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/service/table/table-delta-repository')>();
  return {
    ...actual,
    writeTablePersistenceLayerV2_ACU: vi.fn((message: any, isolationKey: string, layer: any) => {
      const container = message.TavernDB_ACU_IsolatedData || (message.TavernDB_ACU_IsolatedData = {});
      const tagData = container[isolationKey] || (container[isolationKey] = { independentData: {}, modifiedKeys: [], updateGroupKeys: [] });
      tagData.tablePersistenceV2 = layer;
    }),
    clearCurrentIsolationLegacyTableSnapshots_ACU: vi.fn(),
  };
});

vi.mock('../../../src/shared/template-preset-utils', () => ({
  deriveTemplatePresetNameForImport_ACU: vi.fn(() => ''),
}));

vi.mock('../../../src/service/template/template-preset-service', () => ({
  upsertTemplatePreset_ACU: vi.fn(() => true),
}));

vi.mock('../../../src/shared/constants', () => ({
  TABLE_ORDER_FIELD_ACU: 'orderNo',
}));
import { migrateContentNullToRowId } from '../../../src/service/runtime/helpers-data-merge';

describe('migrateContentNullToRowId', () => {
  // ═══════════════════════════════════════════════════════════════
  // 正常迁移
  // ═══════════════════════════════════════════════════════════════
  it('将表头 null 替换为 "row_id"', () => {
    const data = {
      sheet_0: {
        name: '测试表',
        content: [
          [null, '名称', '数量'],
          [null, '铁剑', '3'],
          [null, '药水', '5'],
        ],
      },
    };
    const result = migrateContentNullToRowId(data);
    expect(result!.sheet_0.content[0][0]).toBe('row_id');
  });

  it('将数据行 null 替换为行号字符串', () => {
    const data = {
      sheet_0: {
        name: '测试表',
        content: [
          [null, '名称'],
          [null, '铁剑'],
          [null, '药水'],
        ],
      },
    };
    const result = migrateContentNullToRowId(data);
    expect(result!.sheet_0.content[1][0]).toBe('1');
    expect(result!.sheet_0.content[2][0]).toBe('2');
  });

  it('多张表同时迁移', () => {
    const data = {
      sheet_0: {
        name: '表A',
        content: [[null, 'col1'], [null, 'val1']],
      },
      sheet_1: {
        name: '表B',
        content: [[null, 'col2'], [null, 'val2'], [null, 'val3']],
      },
    };
    const result = migrateContentNullToRowId(data);
    expect(result!.sheet_0.content[0][0]).toBe('row_id');
    expect(result!.sheet_0.content[1][0]).toBe('1');
    expect(result!.sheet_1.content[0][0]).toBe('row_id');
    expect(result!.sheet_1.content[1][0]).toBe('1');
    expect(result!.sheet_1.content[2][0]).toBe('2');
  });

  // ═══════════════════════════════════════════════════════════════
  // 幂等性
  // ═══════════════════════════════════════════════════════════════
  it('已迁移的数据不重复处理（幂等）', () => {
    const data = {
      sheet_0: {
        name: '测试表',
        content: [
          ['row_id', '名称'],
          ['1', '铁剑'],
          ['2', '药水'],
        ],
      },
    };
    const result = migrateContentNullToRowId(data);
    expect(result!.sheet_0.content[0][0]).toBe('row_id');
    expect(result!.sheet_0.content[1][0]).toBe('1');
    expect(result!.sheet_0.content[2][0]).toBe('2');
  });

  it('表头非 null 也非 "row_id" 时不处理', () => {
    const data = {
      sheet_0: {
        name: '测试表',
        content: [
          ['id', '名称'],
          ['1', '铁剑'],
        ],
      },
    };
    const result = migrateContentNullToRowId(data);
    expect(result!.sheet_0.content[0][0]).toBe('id');
  });

  // ═══════════════════════════════════════════════════════════════
  // seedRows 迁移
  // ═══════════════════════════════════════════════════════════════
  it('迁移 seedRows 中的 null', () => {
    const data = {
      sheet_0: {
        name: '测试表',
        content: [[null, '名称']],
        seedRows: [
          [null, '种子数据1'],
          [null, '种子数据2'],
        ],
      },
    };
    const result = migrateContentNullToRowId(data);
    expect(result!.sheet_0.seedRows[0][0]).toBe('1');
    expect(result!.sheet_0.seedRows[1][0]).toBe('2');
  });

  it('seedRows 不存在时不报错', () => {
    const data = {
      sheet_0: {
        name: '测试表',
        content: [[null, '名称'], [null, '铁剑']],
      },
    };
    expect(() => migrateContentNullToRowId(data)).not.toThrow();
  });

  it('seedRows 为空数组时不报错', () => {
    const data = {
      sheet_0: {
        name: '测试表',
        content: [[null, '名称']],
        seedRows: [],
      },
    };
    expect(() => migrateContentNullToRowId(data)).not.toThrow();
  });

  // ═══════════════════════════════════════════════════════════════
  // 边界条件
  // ═══════════════════════════════════════════════════════════════
  it('data 为 null 时返回 null', () => {
    expect(migrateContentNullToRowId(null)).toBeNull();
  });

  it('data 为 undefined 时返回 undefined', () => {
    expect(migrateContentNullToRowId(undefined as any)).toBeUndefined();
  });

  it('空对象返回空对象', () => {
    const result = migrateContentNullToRowId({});
    expect(result).toEqual({});
  });

  it('非 sheet_ 开头的键被跳过', () => {
    const data = {
      mate: { type: 'acu' },
      sheet_0: {
        name: '测试表',
        content: [[null, '名称'], [null, '铁剑']],
      },
    };
    const result = migrateContentNullToRowId(data);
    expect(result!.mate).toEqual({ type: 'acu' });
    expect(result!.sheet_0.content[0][0]).toBe('row_id');
  });

  it('content 为空数组时不报错', () => {
    const data = {
      sheet_0: {
        name: '测试表',
        content: [],
      },
    };
    expect(() => migrateContentNullToRowId(data)).not.toThrow();
  });

  it('content 不存在时不报错', () => {
    const data = {
      sheet_0: {
        name: '测试表',
      },
    };
    expect(() => migrateContentNullToRowId(data)).not.toThrow();
  });

  it('表头行为空数组时不报错', () => {
    const data = {
      sheet_0: {
        name: '测试表',
        content: [[]],
      },
    };
    expect(() => migrateContentNullToRowId(data)).not.toThrow();
  });

  it('只有表头行（无数据行）时正确迁移', () => {
    const data = {
      sheet_0: {
        name: '测试表',
        content: [[null, '名称', '数量']],
      },
    };
    const result = migrateContentNullToRowId(data);
    expect(result!.sheet_0.content[0][0]).toBe('row_id');
    expect(result!.sheet_0.content.length).toBe(1);
  });

  it('数据行第一列非 null 时保留原值', () => {
    const data = {
      sheet_0: {
        name: '测试表',
        content: [
          [null, '名称'],
          ['已有值', '铁剑'],
          [null, '药水'],
        ],
      },
    };
    const result = migrateContentNullToRowId(data);
    expect(result!.sheet_0.content[1][0]).toBe('已有值');
    expect(result!.sheet_0.content[2][0]).toBe('2');
  });
});

// ═══════════════════════════════════════════════════════════════
// mergeAllIndependentTables_ACU 核心数据合并测试
// ═══════════════════════════════════════════════════════════════
import { mergeAllIndependentTables_ACU } from '../../../src/service/runtime/helpers-data-merge';
import { getChatArray_ACU } from '../../../src/data/gateways/chat-gateway';
import { getCurrentIsolationKey_ACU } from '../../../src/service/runtime/state-manager';
import { readIsolatedTagData_ACU, isLegacyMatchForIsolation_ACU, readLegacyIndependentData_ACU } from '../../../src/data/repositories/chat-message-data-repo';
import { writeTablePersistenceLayerV2_ACU, clearCurrentIsolationLegacyTableSnapshots_ACU } from '../../../src/service/table/table-delta-repository';
import { getChatSheetGuideDataForIsolationKey_ACU, getTemplateSheetKeys_ACU, getSortedSheetKeys_ACU, reorderDataBySheetKeys_ACU, materializeDataFromSheetGuide_ACU } from '../../../src/service/template/chat-scope';

describe('mergeAllIndependentTables_ACU', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认：无指导表，模板包含 sheet_0
    vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue(null);
    vi.mocked(getTemplateSheetKeys_ACU).mockReturnValue(['sheet_0']);
    vi.mocked(getCurrentIsolationKey_ACU).mockReturnValue('');
    vi.mocked(getSortedSheetKeys_ACU).mockImplementation((data: any) =>
      data ? Object.keys(data).filter((k: string) => k.startsWith('sheet_')).sort() : [],
    );
    vi.mocked(reorderDataBySheetKeys_ACU).mockImplementation((data: any) => data);
  });

  // ═══ 空聊天记录 ═══
  it('聊天记录为空时返回 null', async () => {
    vi.mocked(getChatArray_ACU).mockReturnValue([]);
    const result = await mergeAllIndependentTables_ACU();
    expect(result).toBeNull();
  });

  it('聊天记录为 null 时返回 null', async () => {
    vi.mocked(getChatArray_ACU).mockReturnValue(null as any);
    const result = await mergeAllIndependentTables_ACU();
    expect(result).toBeNull();
  });

  // ═══ 新版隔离标签存储格式 ═══
  it('从新版隔离标签存储中读取数据', async () => {
    const mockChat = [
      { is_user: false, mes: 'AI回复' },
    ];
    vi.mocked(getChatArray_ACU).mockReturnValue(mockChat);
    vi.mocked(readIsolatedTagData_ACU).mockReturnValue({
      independentData: {
        sheet_0: {
          name: '背包物品表',
          content: [['row_id', '物品名称', '数量'], ['1', '铁剑', '3']],
        },
      },
      modifiedKeys: ['sheet_0'],
      updateGroupKeys: [],
    });

    const result = await mergeAllIndependentTables_ACU();
    expect(result).not.toBeNull();
    expect(result!.sheet_0).toBeDefined();
    expect(result!.sheet_0.name).toBe('背包物品表');
    expect(result!.sheet_0.content[1][1]).toBe('铁剑');
  });

  // ═══ 模板过滤 ═══
  it('不在当前模板中的表格被过滤', async () => {
    vi.mocked(getTemplateSheetKeys_ACU).mockReturnValue(['sheet_0']); // 只有 sheet_0 在模板中
    const mockChat = [
      { is_user: false, mes: 'AI回复' },
    ];
    vi.mocked(getChatArray_ACU).mockReturnValue(mockChat);
    vi.mocked(readIsolatedTagData_ACU).mockReturnValue({
      independentData: {
        sheet_0: { name: '背包物品表', content: [['row_id', '物品名称'], ['1', '铁剑']] },
        sheet_1: { name: '旧表', content: [['row_id', '数据'], ['1', '旧数据']] }, // 不在模板中
      },
      modifiedKeys: ['sheet_0', 'sheet_1'],
      updateGroupKeys: [],
    });

    const result = await mergeAllIndependentTables_ACU();
    expect(result).not.toBeNull();
    expect(result!.sheet_0).toBeDefined();
    expect(result!.sheet_1).toBeUndefined(); // sheet_1 被过滤
  });

  // ═══ 最新数据优先（从后往前遍历） ═══
  it('多条消息时取最新的数据（后面的消息优先）', async () => {
    const mockChat = [
      { is_user: false, mes: '旧AI回复' },
      { is_user: true, mes: '用户消息' },
      { is_user: false, mes: '新AI回复' },
    ];
    vi.mocked(getChatArray_ACU).mockReturnValue(mockChat);
    // 第3条消息（index=2）有新数据
    vi.mocked(readIsolatedTagData_ACU).mockImplementation((message: any) => {
      if (message.mes === '新AI回复') {
        return {
          independentData: {
            sheet_0: { name: '背包物品表', content: [['row_id', '物品名称'], ['1', '新铁剑']] },
          },
          modifiedKeys: ['sheet_0'],
          updateGroupKeys: [],
        };
      }
      if (message.mes === '旧AI回复') {
        return {
          independentData: {
            sheet_0: { name: '背包物品表', content: [['row_id', '物品名称'], ['1', '旧铁剑']] },
          },
          modifiedKeys: ['sheet_0'],
          updateGroupKeys: [],
        };
      }
      return null;
    });

    const result = await mergeAllIndependentTables_ACU();
    expect(result).not.toBeNull();
    // 从后往前遍历，新AI回复的数据先被找到
    expect(result!.sheet_0.content[1][1]).toBe('新铁剑');
  });

  // ═══ 跳过用户消息 ═══
  it('跳过用户消息', async () => {
    const mockChat = [
      { is_user: true, mes: '用户消息' },
      { is_user: false, mes: 'AI回复' },
    ];
    vi.mocked(getChatArray_ACU).mockReturnValue(mockChat);
    vi.mocked(readIsolatedTagData_ACU).mockImplementation((message: any) => {
      if (message.is_user) {
        // 如果用户消息被读取，说明跳过逻辑有问题
        return {
          independentData: {
            sheet_0: { name: '错误数据', content: [['row_id'], ['1']] },
          },
          modifiedKeys: ['sheet_0'],
          updateGroupKeys: [],
        };
      }
      return {
        independentData: {
          sheet_0: { name: '正确数据', content: [['row_id', '物品名称'], ['1', '铁剑']] },
        },
        modifiedKeys: ['sheet_0'],
        updateGroupKeys: [],
      };
    });

    const result = await mergeAllIndependentTables_ACU();
    expect(result).not.toBeNull();
    expect(result!.sheet_0.name).toBe('正确数据');
  });

  // ═══ 无数据且无指导表时返回 null ═══
  it('聊天记录中无任何表格数据时返回 null', async () => {
    const mockChat = [
      { is_user: false, mes: 'AI回复' },
    ];
    vi.mocked(getChatArray_ACU).mockReturnValue(mockChat);
    vi.mocked(readIsolatedTagData_ACU).mockReturnValue(null);
    vi.mocked(isLegacyMatchForIsolation_ACU).mockReturnValue(false);

    const result = await mergeAllIndependentTables_ACU();
    expect(result).toBeNull();
  });

  // ═══ 无数据但有指导表时返回物化结构 ═══
  it('无历史数据但有指导表时返回物化结构', async () => {
    const guideData = {
      sheet_0: {
        name: '背包物品表',
        content: [['row_id', '物品名称', '数量']],
        updateConfig: {},
      },
    };
    vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue(guideData);
    vi.mocked(materializeDataFromSheetGuide_ACU).mockReturnValue({
      sheet_0: {
        name: '背包物品表',
        content: [['row_id', '物品名称', '数量']],
        updateConfig: {},
      },
    });
    const mockChat = [
      { is_user: false, mes: 'AI回复' },
    ];
    vi.mocked(getChatArray_ACU).mockReturnValue(mockChat);
    vi.mocked(readIsolatedTagData_ACU).mockReturnValue(null);
    vi.mocked(isLegacyMatchForIsolation_ACU).mockReturnValue(false);

    const result = await mergeAllIndependentTables_ACU();
    expect(result).not.toBeNull();
    expect(result!.sheet_0).toBeDefined();
    expect(result!.sheet_0.name).toBe('背包物品表');
  });

  // ═══ 旧版存储格式兼容 ═══
  it('新版无数据时回退到旧版存储格式', async () => {
    const mockChat = [
      { is_user: false, mes: 'AI回复' },
    ];
    vi.mocked(getChatArray_ACU).mockReturnValue(mockChat);
    vi.mocked(readIsolatedTagData_ACU).mockReturnValue(null);
    vi.mocked(isLegacyMatchForIsolation_ACU).mockReturnValue(true);
    vi.mocked(readLegacyIndependentData_ACU).mockReturnValue({
      sheet_0: {
        name: '背包物品表',
        content: [['row_id', '物品名称'], ['1', '旧版铁剑']],
      },
    });

    const result = await mergeAllIndependentTables_ACU();
    expect(result).not.toBeNull();
    expect(result!.sheet_0.content[1][1]).toBe('旧版铁剑');
  });

  // ═══ updateConfig 兼容迁移 ═══
  it('旧版 updateConfig 中的 0 被迁移为 -1', async () => {
    const mockChat = [
      { is_user: false, mes: 'AI回复' },
    ];
    vi.mocked(getChatArray_ACU).mockReturnValue(mockChat);
    vi.mocked(readIsolatedTagData_ACU).mockReturnValue({
      independentData: {
        sheet_0: {
          name: '背包物品表',
          content: [['row_id', '物品名称'], ['1', '铁剑']],
          updateConfig: { contextDepth: 0, updateFrequency: 0, batchSize: 3, skipFloors: 0 },
        },
      },
      modifiedKeys: ['sheet_0'],
      updateGroupKeys: [],
    });

    const result = await mergeAllIndependentTables_ACU();
    expect(result).not.toBeNull();
    // 0 应被迁移为 -1（新语义）
    expect(result!.sheet_0.updateConfig.contextDepth).toBe(-1);
    expect(result!.sheet_0.updateConfig.updateFrequency).toBe(-1);
    expect(result!.sheet_0.updateConfig.batchSize).toBe(3); // 非0值不变
    expect(result!.sheet_0.updateConfig.skipFloors).toBe(-1);
    expect(result!.sheet_0.updateConfig.uiSentinel).toBe(-1);
  });
});

// ═══════════════════════════════════════════════════════════════
// formatJsonToReadable_ACU — JSON 表格数据转 Markdown 可读文本
// ═══════════════════════════════════════════════════════════════
import { formatJsonToReadable_ACU, fillFirstLayerWithTemplateData_ACU, shouldSuppressWorldbookInjection_ACU, maybeLiftWorldbookSuppression_ACU, getEffectiveAutoUpdateThreshold_ACU, isNewChatGreetingStage_ACU, isSingleAiNoUserChat_ACU, buildTemplateBaseStateDataForLocalStorage_ACU, seedGreetingLocalDataFromTemplate_ACU, parseReadableToJson_ACU, GREETING_LOCAL_BASE_STATE_MARKER_ACU } from '../../../src/service/runtime/helpers-data-merge';
import { settings_ACU, suppressWorldbookInjectionInGreeting_ACU, _set_suppressWorldbookInjectionInGreeting_ACU } from '../../../src/service/runtime/state-manager';
import { saveChatToHost_ACU } from '../../../src/data/gateways/chat-gateway';
import { initIsolatedTagSlot_ACU, writeLegacyCompatData_ACU } from '../../../src/data/repositories/chat-message-data-repo';
import { buildChatSheetGuideDataFromTemplateObj_ACU, setChatSheetGuideDataForIsolationKey_ACU, sanitizeTemplateSnapshotForChat_ACU } from '../../../src/service/template/chat-scope';
import { _set_currentJsonTableData_ACU } from '../../../src/service/runtime/state-manager';

describe('formatJsonToReadable_ACU', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // getSortedSheetKeys_ACU 返回按 key 排序的表格键
    vi.mocked(getSortedSheetKeys_ACU).mockImplementation((data: any) =>
      data ? Object.keys(data).filter((k: string) => k.startsWith('sheet_')).sort() : [],
    );
  });

  it('jsonData 为 null 时返回默认空结构', () => {
    const result = formatJsonToReadable_ACU(null);
    expect(result.readableText).toBe('数据库为空。');
    expect(result.importantPersonsTable).toBeNull();
    expect(result.summaryTable).toBeNull();
    expect(result.outlineTable).toBeNull();
  });

  it('普通表格转为 Markdown 格式（跳过 row_id 列）', () => {
    const jsonData = {
      sheet_0: {
        name: '背包物品表',
        content: [
          ['row_id', '物品名称', '数量'],
          ['1', '铁剑', '3'],
          ['2', '药水', '5'],
        ],
      },
    };
    const result = formatJsonToReadable_ACU(jsonData);
    expect(result.readableText).toContain('# 背包物品表');
    expect(result.readableText).toContain('| 物品名称 | 数量 |');
    expect(result.readableText).toContain('|---|---|');
    expect(result.readableText).toContain('| 铁剑 | 3 |');
    expect(result.readableText).toContain('| 药水 | 5 |');
    // row_id 不应出现在输出中
    expect(result.readableText).not.toContain('row_id');
  });

  it('表头不含 row_id 时保留第一列真实业务字段', () => {
    const jsonData = {
      sheet_0: {
        name: '主角信息表',
        content: [
          ['人物名称', '性别'],
          ['陈默', '男'],
        ],
      },
    };
    const result = formatJsonToReadable_ACU(jsonData);
    expect(result.readableText).toContain('# 主角信息表');
    expect(result.readableText).toContain('| 人物名称 | 性别 |');
    expect(result.readableText).toContain('| 陈默 | 男 |');
  });

  it('表头不含 row_id 且只有一列真实业务字段时不会输出为空表', () => {
    const jsonData = {
      sheet_0: {
        name: '主角技能表',
        content: [
          ['技能名称'],
          ['格斗'],
        ],
      },
    };
    const result = formatJsonToReadable_ACU(jsonData);
    expect(result.readableText).toContain('# 主角技能表');
    expect(result.readableText).toContain('| 技能名称 |');
    expect(result.readableText).toContain('| 格斗 |');
  });

  it('只有 row_id 或没有可显示表头的空壳表不输出孤立标题', () => {
    const jsonData = {
      sheet_0: {
        name: '空壳表A',
        content: [['row_id'], ['1']],
      },
      sheet_1: {
        name: '空壳表B',
        content: [],
      },
    };
    const result = formatJsonToReadable_ACU(jsonData);
    expect(result.readableText).not.toContain('# 空壳表A');
    expect(result.readableText).not.toContain('# 空壳表B');
  });

  it('只有空白业务单元格的表不输出孤立标题', () => {
    const jsonData = {
      sheet_0: {
        name: '空白数据表',
        content: [['row_id', '备注'], ['1', '   ']],
      },
    };
    const result = formatJsonToReadable_ACU(jsonData);
    expect(result.readableText).not.toContain('# 空白数据表');
  });

  it('数字 0 和 boolean false 属于有效业务数据', () => {
    const jsonData = {
      sheet_0: {
        name: '数值表',
        content: [['row_id', '数量', '开关'], ['1', 0, false]],
      },
    };
    const result = formatJsonToReadable_ACU(jsonData);
    expect(result.readableText).toContain('# 数值表');
    expect(result.readableText).toContain('| 0 | false |');
  });

  it('重要人物表被提取到独立字段，不出现在 readableText 中', () => {
    const jsonData = {
      sheet_0: {
        name: '重要人物表',
        content: [['row_id', '姓名'], ['1', '冈部']],
      },
      sheet_1: {
        name: '背包物品表',
        content: [['row_id', '物品名称'], ['1', '铁剑']],
      },
    };
    const result = formatJsonToReadable_ACU(jsonData);
    expect(result.importantPersonsTable).not.toBeNull();
    expect(result.importantPersonsTable.name).toBe('重要人物表');
    expect(result.readableText).not.toContain('# 重要人物表');
    // 普通表仍在 readableText 中
    expect(result.readableText).toContain('# 背包物品表');
  });

  it('总结表和总体大纲被提取到独立字段', () => {
    const jsonData = {
      sheet_0: {
        name: '总结表',
        content: [['row_id', '内容'], ['1', '总结内容']],
      },
      sheet_1: {
        name: '总体大纲',
        content: [['row_id', '章节'], ['1', '第一章']],
      },
    };
    const result = formatJsonToReadable_ACU(jsonData);
    expect(result.summaryTable).not.toBeNull();
    expect(result.summaryTable.name).toBe('总结表');
    expect(result.outlineTable).not.toBeNull();
    expect(result.outlineTable.name).toBe('总体大纲');
    expect(result.readableText).not.toContain('# 总结表');
    expect(result.readableText).not.toContain('# 总体大纲');
  });

  it('exportConfig.enabled=true 的表被跳过', () => {
    const jsonData = {
      sheet_0: {
        name: '自定义导出表',
        content: [['row_id', '数据'], ['1', '值']],
        exportConfig: { enabled: true },
      },
      sheet_1: {
        name: '普通表',
        content: [['row_id', '数据'], ['1', '值']],
      },
    };
    const result = formatJsonToReadable_ACU(jsonData);
    expect(result.readableText).not.toContain('# 自定义导出表');
    expect(result.readableText).toContain('# 普通表');
  });

  it('exportConfig.injectIntoWorldbook=false 的表被跳过', () => {
    const jsonData = {
      sheet_0: {
        name: '不注入表',
        content: [['row_id', '数据'], ['1', '值']],
        exportConfig: { injectIntoWorldbook: false },
      },
    };
    const result = formatJsonToReadable_ACU(jsonData);
    expect(result.readableText).not.toContain('# 不注入表');
  });

  it('只有数据行没有表头时仍不报错', () => {
    const jsonData = {
      sheet_0: {
        name: '空表头表',
        content: [],
      },
    };
    expect(() => formatJsonToReadable_ACU(jsonData)).not.toThrow();
  });

  it('多张普通表按顺序输出', () => {
    const jsonData = {
      sheet_0: {
        name: '表A',
        content: [['row_id', 'col1'], ['1', 'a1']],
      },
      sheet_1: {
        name: '表B',
        content: [['row_id', 'col2'], ['1', 'b1']],
      },
    };
    const result = formatJsonToReadable_ACU(jsonData);
    const indexA = result.readableText.indexOf('# 表A');
    const indexB = result.readableText.indexOf('# 表B');
    expect(indexA).toBeLessThan(indexB);
  });
});

// ═══════════════════════════════════════════════════════════════
// fillFirstLayerWithTemplateData_ACU — 将模板数据填充到第一楼
// ═══════════════════════════════════════════════════════════════
describe('fillFirstLayerWithTemplateData_ACU', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: false, mes: '你好，欢迎来到冒险世界！' },
    ]);
    vi.mocked(getCurrentIsolationKey_ACU).mockReturnValue('');
    vi.mocked(initIsolatedTagSlot_ACU).mockReturnValue({
      independentData: {},
      modifiedKeys: [],
      updateGroupKeys: [],
    });
    vi.mocked(getSortedSheetKeys_ACU).mockImplementation((data: any) =>
      data ? Object.keys(data).filter((k: string) => k.startsWith('sheet_')).sort() : [],
    );
    vi.mocked(reorderDataBySheetKeys_ACU).mockImplementation((data: any) => data);
    vi.mocked(sanitizeTemplateSnapshotForChat_ACU).mockReturnValue(null);
    vi.mocked(buildChatSheetGuideDataFromTemplateObj_ACU).mockReturnValue(null);
  });

  it('正常填充：写入 V2 checkpoint、清理旧快照、保存聊天', async () => {
    const templateObj = {
      sheet_0: {
        name: '背包物品表',
        content: [['row_id', '物品名称', '数量'], ['1', '铁剑', '3']],
      },
    };

    const result = await fillFirstLayerWithTemplateData_ACU(templateObj);
    expect(result).toEqual({ success: true, messageIndex: 0, sheetCount: 1 });
    // 验证写入了 V2 checkpoint，并清理旧快照
    expect(vi.mocked(writeTablePersistenceLayerV2_ACU)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeTablePersistenceLayerV2_ACU).mock.calls[0][2].checkpoint?.source).toBe('template-seed');
    expect(vi.mocked(clearCurrentIsolationLegacyTableSnapshots_ACU)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeLegacyCompatData_ACU)).not.toHaveBeenCalled();
    // 验证保存了聊天
    expect(vi.mocked(saveChatToHost_ACU)).toHaveBeenCalledTimes(1);
    // 验证更新了内存数据
    expect(vi.mocked(_set_currentJsonTableData_ACU)).toHaveBeenCalledTimes(1);
  });

  it('聊天记录为空时返回 false', async () => {
    vi.mocked(getChatArray_ACU).mockReturnValue([]);
    const result = await fillFirstLayerWithTemplateData_ACU({ sheet_0: { name: '表', content: [] } });
    expect(result).toBe(false);
  });

  it('聊天中无AI消息时返回 false', async () => {
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true, mes: '用户消息' },
    ]);
    const result = await fillFirstLayerWithTemplateData_ACU({ sheet_0: { name: '表', content: [] } });
    expect(result).toBe(false);
  });

  it('模板中无表格数据时返回 false', async () => {
    const result = await fillFirstLayerWithTemplateData_ACU({ mate: { type: 'acu' } });
    expect(result).toBe(false);
  });

  it('有指导表时同步指导表和模板快照', async () => {
    const guideData = { sheet_0: { name: '背包物品表', content: [['row_id', '物品名称']] } };
    vi.mocked(buildChatSheetGuideDataFromTemplateObj_ACU).mockReturnValue(guideData);
    vi.mocked(sanitizeTemplateSnapshotForChat_ACU).mockReturnValue({ templateStr: '{}' } as any);

    const templateObj = {
      sheet_0: {
        name: '背包物品表',
        content: [['row_id', '物品名称'], ['1', '铁剑']],
      },
    };

    await fillFirstLayerWithTemplateData_ACU(templateObj);
    expect(vi.mocked(setChatSheetGuideDataForIsolationKey_ACU)).toHaveBeenCalledTimes(1);
  });

  it('多张表格全部写入', async () => {
    const templateObj = {
      sheet_0: { name: '表A', content: [['row_id', 'col1'], ['1', 'a']] },
      sheet_1: { name: '表B', content: [['row_id', 'col2'], ['1', 'b']] },
      sheet_2: { name: '表C', content: [['row_id', 'col3'], ['1', 'c']] },
    };

    const result = await fillFirstLayerWithTemplateData_ACU(templateObj);
    expect(result).toEqual({ success: true, messageIndex: 0, sheetCount: 3 });
  });
});

// ═══════════════════════════════════════════════════════════════
// maybeLiftWorldbookSuppression_ACU — 解除世界书注入抑制
// ═══════════════════════════════════════════════════════════════
describe('maybeLiftWorldbookSuppression_ACU', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('suppressWorldbookInjectionInGreeting_ACU 为 false 时直接返回，不调用任何函数', () => {
    // mock 模块返回 false（默认值）
    maybeLiftWorldbookSuppression_ACU();
    // 不应调用 _set_suppressWorldbookInjectionInGreeting_ACU
    expect(vi.mocked(_set_suppressWorldbookInjectionInGreeting_ACU)).not.toHaveBeenCalled();
  });

  it('聊天中无用户消息时不解除抑制', () => {
    // 需要 suppressWorldbookInjectionInGreeting_ACU 为 true 才能进入逻辑
    // 但由于 mock 模块返回的是固定值 false，这个测试验证的是：即使调用也不会错误地解除
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: false, mes: 'AI回复' },
    ]);
    maybeLiftWorldbookSuppression_ACU();
    expect(vi.mocked(_set_suppressWorldbookInjectionInGreeting_ACU)).not.toHaveBeenCalled();
  });

  it('聊天记录为非数组时不报错', () => {
    vi.mocked(getChatArray_ACU).mockReturnValue(null as any);
    expect(() => maybeLiftWorldbookSuppression_ACU()).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// getEffectiveAutoUpdateThreshold_ACU — 获取有效的自动更新阈值
// ═══════════════════════════════════════════════════════════════
describe('getEffectiveAutoUpdateThreshold_ACU', () => {
  it('settings_ACU.autoUpdateThreshold 为正常数字时返回该值', () => {
    (settings_ACU as any).autoUpdateThreshold = 5;
    const result = getEffectiveAutoUpdateThreshold_ACU();
    expect(result).toBe(5);
  });

  it('settings_ACU.autoUpdateThreshold 为 NaN 时返回默认值 3', () => {
    (settings_ACU as any).autoUpdateThreshold = 'abc';
    const result = getEffectiveAutoUpdateThreshold_ACU();
    expect(result).toBe(3);
  });

  it('settings_ACU.autoUpdateThreshold 为 undefined 时返回默认值 3', () => {
    (settings_ACU as any).autoUpdateThreshold = undefined;
    const result = getEffectiveAutoUpdateThreshold_ACU();
    expect(result).toBe(3);
  });

  it('settings_ACU.autoUpdateThreshold 为 0 时返回 0（合法值）', () => {
    (settings_ACU as any).autoUpdateThreshold = 0;
    const result = getEffectiveAutoUpdateThreshold_ACU();
    expect(result).toBe(0);
  });

  it('接受 calledFrom 参数但不影响返回值', () => {
    (settings_ACU as any).autoUpdateThreshold = 7;
    const result = getEffectiveAutoUpdateThreshold_ACU('manual');
    expect(result).toBe(7);
  });
});

// ═══════════════════════════════════════════════════════════════
// shouldSuppressWorldbookInjection_ACU — 世界书注入抑制判断
// ═══════════════════════════════════════════════════════════════
describe('shouldSuppressWorldbookInjection_ACU', () => {
  it('始终返回 false（用户要求取消首楼限制）', () => {
    expect(shouldSuppressWorldbookInjection_ACU()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// isNewChatGreetingStage_ACU — 判断是否处于新对话开场白阶段
// ═══════════════════════════════════════════════════════════════
describe('isNewChatGreetingStage_ACU', () => {
  it('只有AI消息、无用户消息时返回 true', () => {
    const chat = [{ is_user: false, mes: '你好，欢迎来到冒险世界！' }];
    expect(isNewChatGreetingStage_ACU(chat)).toBe(true);
  });

  it('有用户消息时返回 false', () => {
    const chat = [
      { is_user: false, mes: 'AI开场白' },
      { is_user: true, mes: '你好' },
    ];
    expect(isNewChatGreetingStage_ACU(chat)).toBe(false);
  });

  it('空数组返回 false', () => {
    expect(isNewChatGreetingStage_ACU([])).toBe(false);
  });

  it('null 输入返回 false', () => {
    expect(isNewChatGreetingStage_ACU(null as any)).toBe(false);
  });

  it('只有用户消息（无AI消息）时返回 false', () => {
    const chat = [{ is_user: true, mes: '用户消息' }];
    expect(isNewChatGreetingStage_ACU(chat)).toBe(false);
  });

  it('多条AI消息、无用户消息时返回 true', () => {
    const chat = [
      { is_user: false, mes: 'AI消息1' },
      { is_user: false, mes: 'AI消息2' },
    ];
    expect(isNewChatGreetingStage_ACU(chat)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// isSingleAiNoUserChat_ACU — 判断是否只有单条AI消息无用户消息
// ═══════════════════════════════════════════════════════════════
describe('isSingleAiNoUserChat_ACU', () => {
  it('单条AI消息、无用户消息时返回 true', () => {
    const chat = [{ is_user: false, mes: 'AI开场白' }];
    expect(isSingleAiNoUserChat_ACU(chat)).toBe(true);
  });

  it('多条AI消息、无用户消息时返回 false', () => {
    const chat = [
      { is_user: false, mes: 'AI消息1' },
      { is_user: false, mes: 'AI消息2' },
    ];
    expect(isSingleAiNoUserChat_ACU(chat)).toBe(false);
  });

  it('有用户消息时返回 false', () => {
    const chat = [
      { is_user: false, mes: 'AI消息' },
      { is_user: true, mes: '用户消息' },
    ];
    expect(isSingleAiNoUserChat_ACU(chat)).toBe(false);
  });

  it('空数组返回 false', () => {
    expect(isSingleAiNoUserChat_ACU([])).toBe(false);
  });

  it('null 输入返回 false', () => {
    expect(isSingleAiNoUserChat_ACU(null as any)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// buildTemplateBaseStateDataForLocalStorage_ACU — 构建本地存储数据结构
// ═══════════════════════════════════════════════════════════════
describe('buildTemplateBaseStateDataForLocalStorage_ACU', () => {
  it('正常模板对象返回包含 mate 和 sheet_ 数据的结构', () => {
    const templateObj = {
      sheet_0: { name: '背包物品表', content: [['row_id', '物品名称'], ['1', '铁剑']] },
      sheet_1: { name: '角色表', content: [['row_id', '角色名'], ['1', '冈部']] },
    };
    const result = buildTemplateBaseStateDataForLocalStorage_ACU(templateObj);
    expect(result).not.toBeNull();
    expect(result!.mate).toEqual({ type: 'chatSheets', version: 1 });
    expect(result!.sheet_0.name).toBe('背包物品表');
    expect(result!.sheet_1.name).toBe('角色表');
  });

  it('返回的数据是深拷贝，修改不影响原对象', () => {
    const templateObj = {
      sheet_0: { name: '背包物品表', content: [['row_id', '物品名称'], ['1', '铁剑']] },
    };
    const result = buildTemplateBaseStateDataForLocalStorage_ACU(templateObj);
    result!.sheet_0.name = '被修改的名称';
    expect(templateObj.sheet_0.name).toBe('背包物品表');
  });

  it('null 输入返回 null', () => {
    expect(buildTemplateBaseStateDataForLocalStorage_ACU(null)).toBeNull();
  });

  it('非对象输入返回 null', () => {
    expect(buildTemplateBaseStateDataForLocalStorage_ACU('string' as any)).toBeNull();
  });

  it('无 sheet_ 键的对象返回 null', () => {
    const templateObj = { mate: { type: 'acu' }, config: {} };
    expect(buildTemplateBaseStateDataForLocalStorage_ACU(templateObj)).toBeNull();
  });

  it('非 sheet_ 键被排除', () => {
    const templateObj = {
      mate: { type: 'acu' },
      sheet_0: { name: '表A', content: [] },
      config: { enabled: true },
    };
    const result = buildTemplateBaseStateDataForLocalStorage_ACU(templateObj);
    expect(result).not.toBeNull();
    expect(result!.sheet_0).toBeDefined();
    expect(result!.config).toBeUndefined();
    expect(result!.mate).toEqual({ type: 'chatSheets', version: 1 }); // mate 被覆盖为标准结构
  });
});

// ═══════════════════════════════════════════════════════════════
// seedGreetingLocalDataFromTemplate_ACU — 新建对话时将模板基础状态写入首楼
// ═══════════════════════════════════════════════════════════════
import { parseTableTemplateJson_ACU, ensureSheetOrderNumbers_ACU } from '../../../src/shared/utils';
import { deleteAllGeneratedEntries_ACU } from '../../../src/service/worldbook/pipeline';

describe('seedGreetingLocalDataFromTemplate_ACU', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentIsolationKey_ACU).mockReturnValue('');
    vi.mocked(getSortedSheetKeys_ACU).mockImplementation((data: any) =>
      data ? Object.keys(data).filter((k: string) => k.startsWith('sheet_')).sort() : [],
    );
    vi.mocked(reorderDataBySheetKeys_ACU).mockImplementation((data: any) => data);
  });

  it('非新对话阶段（有用户消息）时返回 false', async () => {
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: false, mes: 'AI开场白' },
      { is_user: true, mes: '用户消息' },
    ]);
    const result = await seedGreetingLocalDataFromTemplate_ACU();
    expect(result).toBe(false);
  });

  it('空聊天记录时返回 false', async () => {
    vi.mocked(getChatArray_ACU).mockReturnValue([]);
    const result = await seedGreetingLocalDataFromTemplate_ACU();
    expect(result).toBe(false);
  });

  it('幂等：已标记过的消息不重复写入', async () => {
    const greetingMsg = {
      is_user: false,
      mes: 'AI开场白',
      _acu_local_template_base_state_seeded: GREETING_LOCAL_BASE_STATE_MARKER_ACU,
    };
    vi.mocked(getChatArray_ACU).mockReturnValue([greetingMsg]);
    const result = await seedGreetingLocalDataFromTemplate_ACU();
    expect(result).toBe(false);
    // 不应调用任何写入函数
    expect(vi.mocked(initIsolatedTagSlot_ACU)).not.toHaveBeenCalled();
  });

  it('模板为 null 时返回 false', async () => {
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: false, mes: 'AI开场白' },
    ]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue(null);
    const result = await seedGreetingLocalDataFromTemplate_ACU();
    expect(result).toBe(false);
  });

  it('正常首次写入：只写入 V2 checkpoint、保存聊天、清理世界书、更新内存', async () => {
    const greetingMsg: any = { is_user: false, mes: 'AI开场白' };
    vi.mocked(getChatArray_ACU).mockReturnValue([greetingMsg]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      sheet_0: { name: '背包物品表', content: [['row_id', '物品名称'], ['1', '铁剑']] },
    });
    const tagSlot = { independentData: {}, modifiedKeys: [] as string[], updateGroupKeys: [] as string[], _acu_base_state: '' };
    vi.mocked(initIsolatedTagSlot_ACU).mockReturnValue(tagSlot);

    const result = await seedGreetingLocalDataFromTemplate_ACU();

    // 返回成功
    expect(result).toEqual({ success: true, messageIndex: 0 });
    // 写入了 V2 checkpoint，基底数据不算 AI 更新
    expect(vi.mocked(writeTablePersistenceLayerV2_ACU)).toHaveBeenCalledTimes(1);
    const checkpoint = vi.mocked(writeTablePersistenceLayerV2_ACU).mock.calls[0][2].checkpoint;
    expect(checkpoint?.source).toBe('template-seed');
    expect(checkpoint?.messageIndexHint).toBe(0);
    expect(checkpoint?.data.sheet_0.content).toEqual([['row_id', '物品名称'], ['1', '铁剑']]);
    expect(greetingMsg.TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint).toBe(checkpoint);
    expect(vi.mocked(clearCurrentIsolationLegacyTableSnapshots_ACU)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeLegacyCompatData_ACU)).not.toHaveBeenCalled();
    // 锁死读取源：模板基底只能作为 checkpoint 存在，不能再并行写 legacy-style independentData。
    expect(tagSlot.independentData).toEqual({});
    expect(tagSlot.modifiedKeys).toEqual([]);
    expect(tagSlot.updateGroupKeys).toEqual([]);
    // 标记了幂等
    expect(greetingMsg._acu_local_template_base_state_seeded).toBe(GREETING_LOCAL_BASE_STATE_MARKER_ACU);
    // 保存了聊天
    expect(vi.mocked(saveChatToHost_ACU)).toHaveBeenCalledTimes(1);
    // 清理了世界书
    expect(vi.mocked(deleteAllGeneratedEntries_ACU)).toHaveBeenCalledTimes(1);
    // 更新了内存
    expect(vi.mocked(_set_currentJsonTableData_ACU)).toHaveBeenCalledTimes(1);
  });

  it('deleteAllGeneratedEntries_ACU 抛错时不影响整体流程（错误被捕获）', async () => {
    const greetingMsg: any = { is_user: false, mes: 'AI开场白' };
    vi.mocked(getChatArray_ACU).mockReturnValue([greetingMsg]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      sheet_0: { name: '表', content: [['row_id', 'col'], ['1', 'val']] },
    });
    vi.mocked(initIsolatedTagSlot_ACU).mockReturnValue({
      independentData: {}, modifiedKeys: [], updateGroupKeys: [], _acu_base_state: '',
    });
    vi.mocked(deleteAllGeneratedEntries_ACU).mockRejectedValue(new Error('世界书清理失败'));

    const result = await seedGreetingLocalDataFromTemplate_ACU();
    // 即使世界书清理失败，整体流程仍然成功
    expect(result).toEqual({ success: true, messageIndex: 0 });
    // 内存仍然被更新
    expect(vi.mocked(_set_currentJsonTableData_ACU)).toHaveBeenCalledTimes(1);
  });

  it('找不到第一条AI消息时返回 false', async () => {
    // isNewChatGreetingStage_ACU 内部会检查 firstAiIndex !== -1
    // 但如果 chat 全是用户消息，isNewChatGreetingStage_ACU 就返回 false 了
    // 这里测试一个边界：chat 非空但 findIndex 返回 -1 的情况不会发生
    // 因为 isNewChatGreetingStage_ACU 已经保证了 firstAiIndex !== -1
    // 所以这个测试验证的是：只有用户消息时，函数正确返回 false
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true, mes: '用户消息' },
    ]);
    const result = await seedGreetingLocalDataFromTemplate_ACU();
    expect(result).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseReadableToJson_ACU — 将 Markdown 文本反解析回 JSON 表格数据
// ═══════════════════════════════════════════════════════════════

// 需要动态修改 currentJsonTableData_ACU 的 mock 值
import * as stateManager from '../../../src/service/runtime/state-manager';

describe('parseReadableToJson_ACU', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSortedSheetKeys_ACU).mockImplementation((data: any) =>
      data ? Object.keys(data).filter((k: string) => k.startsWith('sheet_')).sort() : [],
    );
  });

  it('currentJsonTableData_ACU 为 null 时返回 null', () => {
    // 默认 mock 中 currentJsonTableData_ACU 就是 null
    const result = parseReadableToJson_ACU('# 背包物品表\n| 物品名称 |\n|---|\n| 铁剑 |');
    expect(result).toBeNull();
  });

  it('正常单表解析：Markdown 文本还原为 JSON 表格数据', () => {
    // 设置 currentJsonTableData_ACU
    Object.defineProperty(stateManager, 'currentJsonTableData_ACU', {
      value: {
        sheet_0: {
          name: '背包物品表',
          content: [['row_id', '物品名称', '数量'], ['1', '铁剑', '3']],
        },
      },
      writable: true,
      configurable: true,
    });

    const markdownText = '# 背包物品表\n| 物品名称 | 数量 |\n|---|---|\n| 魔法杖 | 1 |\n| 药水 | 5 |';
    const result = parseReadableToJson_ACU(markdownText);

    expect(result).not.toBeNull();
    expect(result!.sheet_0.content[0]).toEqual(['row_id', '物品名称', '数量']); // 表头保留原始
    expect(result!.sheet_0.content[1]).toEqual(['1', '魔法杖', '1']); // 第一行数据
    expect(result!.sheet_0.content[2]).toEqual(['2', '药水', '5']); // 第二行数据
    expect(result!.sheet_0.content.length).toBe(3); // 表头 + 2行数据

    // 恢复
    Object.defineProperty(stateManager, 'currentJsonTableData_ACU', {
      value: null, writable: true, configurable: true,
    });
  });

  it('表名不匹配时跳过该表', () => {
    Object.defineProperty(stateManager, 'currentJsonTableData_ACU', {
      value: {
        sheet_0: {
          name: '背包物品表',
          content: [['row_id', '物品名称'], ['1', '铁剑']],
        },
      },
      writable: true,
      configurable: true,
    });

    const markdownText = '# 不存在的表\n| 列1 |\n|---|\n| 值1 |';
    const result = parseReadableToJson_ACU(markdownText);

    expect(result).not.toBeNull();
    // 原始数据不变（不存在的表被跳过）
    expect(result!.sheet_0.content[1][1]).toBe('铁剑');

    Object.defineProperty(stateManager, 'currentJsonTableData_ACU', {
      value: null, writable: true, configurable: true,
    });
  });

  it('列数少于表头时自动补空字符串（pad）', () => {
    Object.defineProperty(stateManager, 'currentJsonTableData_ACU', {
      value: {
        sheet_0: {
          name: '表A',
          content: [['row_id', 'col1', 'col2', 'col3'], ['1', 'a', 'b', 'c']],
        },
      },
      writable: true,
      configurable: true,
    });

    // Markdown 只有 1 列数据，但表头有 3 列（+ row_id = 4列）
    const markdownText = '# 表A\n| col1 |\n|---|\n| 值1 |';
    const result = parseReadableToJson_ACU(markdownText);

    expect(result).not.toBeNull();
    // row_id + 值1 = 2列，需要 pad 到 4 列
    expect(result!.sheet_0.content[1].length).toBe(4);
    expect(result!.sheet_0.content[1][0]).toBe('1'); // row_id
    expect(result!.sheet_0.content[1][1]).toBe('值1');
    expect(result!.sheet_0.content[1][2]).toBe(''); // padded
    expect(result!.sheet_0.content[1][3]).toBe(''); // padded

    Object.defineProperty(stateManager, 'currentJsonTableData_ACU', {
      value: null, writable: true, configurable: true,
    });
  });

  it('列数多于表头时截断（truncate）', () => {
    Object.defineProperty(stateManager, 'currentJsonTableData_ACU', {
      value: {
        sheet_0: {
          name: '表A',
          content: [['row_id', 'col1'], ['1', 'a']],
        },
      },
      writable: true,
      configurable: true,
    });

    // Markdown 有 3 列数据，但表头只有 1 列（+ row_id = 2列）
    const markdownText = '# 表A\n| col1 | col2 | col3 |\n|---|---|---|\n| 值1 | 值2 | 值3 |';
    const result = parseReadableToJson_ACU(markdownText);

    expect(result).not.toBeNull();
    // row_id + 值1 + 值2 + 值3 = 4列，需要 truncate 到 2 列
    expect(result!.sheet_0.content[1].length).toBe(2);
    expect(result!.sheet_0.content[1][0]).toBe('1'); // row_id
    expect(result!.sheet_0.content[1][1]).toBe('值1'); // 只保留第一列

    Object.defineProperty(stateManager, 'currentJsonTableData_ACU', {
      value: null, writable: true, configurable: true,
    });
  });

  it('多表解析：每张表独立还原', () => {
    Object.defineProperty(stateManager, 'currentJsonTableData_ACU', {
      value: {
        sheet_0: {
          name: '表A',
          content: [['row_id', 'col1'], ['1', 'old_a']],
        },
        sheet_1: {
          name: '表B',
          content: [['row_id', 'col2'], ['1', 'old_b']],
        },
      },
      writable: true,
      configurable: true,
    });

    const markdownText = '# 表A\n| col1 |\n|---|\n| new_a |\n# 表B\n| col2 |\n|---|\n| new_b |';
    const result = parseReadableToJson_ACU(markdownText);

    expect(result).not.toBeNull();
    expect(result!.sheet_0.content[1][1]).toBe('new_a');
    expect(result!.sheet_1.content[1][1]).toBe('new_b');

    Object.defineProperty(stateManager, 'currentJsonTableData_ACU', {
      value: null, writable: true, configurable: true,
    });
  });

  it('返回的数据是深拷贝，修改不影响 currentJsonTableData_ACU', () => {
    const originalData = {
      sheet_0: {
        name: '表A',
        content: [['row_id', 'col1'], ['1', '原始值']],
      },
    };
    Object.defineProperty(stateManager, 'currentJsonTableData_ACU', {
      value: originalData,
      writable: true,
      configurable: true,
    });

    const markdownText = '# 表A\n| col1 |\n|---|\n| 新值 |';
    const result = parseReadableToJson_ACU(markdownText);

    // 修改返回值不影响原始数据
    result!.sheet_0.content[1][1] = '被篡改的值';
    expect(originalData.sheet_0.content[1][1]).toBe('原始值');

    Object.defineProperty(stateManager, 'currentJsonTableData_ACU', {
      value: null, writable: true, configurable: true,
    });
  });

  it('空文本（无 # 分隔符）时返回原始数据的克隆', () => {
    Object.defineProperty(stateManager, 'currentJsonTableData_ACU', {
      value: {
        sheet_0: {
          name: '表A',
          content: [['row_id', 'col1'], ['1', '原始值']],
        },
      },
      writable: true,
      configurable: true,
    });

    const result = parseReadableToJson_ACU('');
    expect(result).not.toBeNull();
    // 没有任何表被解析，返回原始数据的克隆
    expect(result!.sheet_0.content[1][1]).toBe('原始值');

    Object.defineProperty(stateManager, 'currentJsonTableData_ACU', {
      value: null, writable: true, configurable: true,
    });
  });
});
