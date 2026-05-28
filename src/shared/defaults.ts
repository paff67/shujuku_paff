// ═══════════════════════════════════════════════════════════════
// data/models/defaults.ts — 默认常量（纯数据，无 DOM 依赖）
// 从 02_storage_and_profile.js 迁入
//
// 注意：含中文引号的巨型 JSON 字符串（DEFAULT_CHAR_CARD_PROMPT_ACU、
// DEFAULT_TABLE_TEMPLATE_ACU 等）不能迁移到 .ts 文件——TypeScript 编译器
// 会把中文引号 "" 当作字符串定界符，破坏产物。这些留在旧文件中。
// ═══════════════════════════════════════════════════════════════

// [剧情推进] 默认世界书选择


export function buildDefaultPlotWorldbookConfig_ACU() {
  return {
    source: 'character' as const,
    manualSelection: [] as string[],
    enabledEntries: {} as Record<string, string[]>,
  };
}

// --- [填表功能] 自动更新阈值默认常量 ---
export const DEFAULT_AUTO_UPDATE_THRESHOLD_ACU = 3;
export const DEFAULT_AUTO_UPDATE_FREQUENCY_ACU = 1;
export const DEFAULT_AUTO_UPDATE_TOKEN_THRESHOLD_ACU = 500;
export const AUTO_UPDATE_FLOOR_INCREASE_DELAY_ACU = 2000;

// --- 一次性默认值刷新版本标记 ---
export const VECTOR_MEMORY_DEFAULTS_REFRESH_VERSION_ACU = 'spv3.6.3-keyword-prompt-content-based-refresh';
export const TABLE_TEMPLATE_DEFAULTS_REFRESH_VERSION_ACU = 'spv2.1.2-table-template-defaults';

// --- 交火模式纪要索引全局默认配置（独立于世界书配置，跟随数据库全局设置） ---
export const defaultVectorMemoryConfig_ACU = {
  enabled: false,
  threshold: 50,
  archiveTriggerCount: 9,
  archiveBatchSize: 3,
  archiveMaxConcurrency: 3,
  summaryIndexArchiveMaxConcurrency: 30,
  topK: 200,
  minScore: 0.45,
  embeddingEndpoint: '',
  embeddingApiKey: '',
  embeddingModel: '',
  rerankEndpoint: '',
  rerankApiKey: '',
  rerankModel: '',
  rerankInstruction: '请根据当前用户输入及关键词，判断每个候选纪要条目的相关性，并将最相关的条目按相关性从高到低降序排列。优先选择能够直接回答、延续或补全当前用户输入意图的条目。',
  vectorNamespace: 'chat',
  entryComment: 'TavernDB-ACU-VectorMemory',
  entryKey: 'TavernDB-ACU-VectorMemory-Key',
  summaryIndexKeywordMinRows: 200,
  summaryChunkSentenceCount: 2,
  summaryPromptGroupId: 'remote-memory-archive-default',
  archiveWithoutSummary: false,
  recentFixedInjectCount: 50,
  summaryPromptGroup: [
    {
      role: 'system',
      content: '你负责将一批较早的纪要条目整理为可供长期召回的远记忆大总结。\n'
        + '目标：生成一条可被向量召回使用的高密度长期记忆。\n'
        + '硬性长度约束：最终输出最高 500TK；如果信息过多，优先压缩表达，不要扩写。\n'
        + '内容优先级：人物关系、关键事件、目标变化、冲突、重要道具、地点、时间线、未解决伏笔。\n'
        + '输出要求：只输出最终远记忆大总结正文；不要写解释、前言、编号说明、标题、Markdown 列表，也不要复述你的任务。',
      deletable: false,
    },
    {
      role: 'user',
      content: '以下是需要归档成远记忆大总结的一批较早纪要条目：\n<纪要批次>\n$SUMMARY_SOURCE_ROWS\n</纪要批次>\n\n请在 500TK 以内输出一条信息密度高、可检索、可长期保存的远记忆大总结正文。只输出正文。',
      deletable: true,
    },
  ],
  keywordApiPreset: '',
  keywordContextPairCount: 1,
  keywordGenerationMaxAttempts: 3,
  keywordPromptGroup: [
    {
      role: 'system',
      content: '你负责为交火模式纪要索引召回生成检索关键词。\n'
        + '你会看到最近对话上下文和当前用户输入。\n'
        + '目标：输出最相关的 12 个简洁关键词或短语，用于纪要索引召回与重排序。\n'
        + '优先级：人物、地点、时间、事件、目标、冲突、道具、组织、关系变化、未解决问题。\n'
        + '\n'
        + '【输出格式 — 必须严格遵守】\n'
        + '你的回复必须且只能包含以下两部分，不得使用其他任何格式：\n'
        + '\n'
        + '<thinking>\n'
        + '逐步分析最近上下文、当前用户输入、涉及人物、地点、时间、事件、目标、冲突、道具、组织、关系变化和未解决问题。\n'
        + '</thinking>\n'
        + '<keywords>关键词1，关键词2，关键词3</keywords>\n'
        + '\n'
        + '【硬性规则】\n'
        + '- 关键词必须且只能放在 <keywords></keywords> 标签之间。\n'
        + '- 禁止使用"关键词："前缀输出，禁止使用编号或列表格式。\n'
        + '- <keywords> 标签内只放关键词或短语，不要放解释句、编号、前后缀说明。\n'
        + '- 多个关键词必须使用中文逗号分隔。\n'
        + '- 尽量输出 12 个，最多 24 个。\n'
        + '- <keywords> 标签外的任何内容都不会被用于检索匹配。',
      deletable: false,
    },
    {
      role: 'user',
      content: '最近上下文：\n$RECENT_CONTEXT\n\n当前用户输入：\n$USER_INPUT\n\n请根据以上内容生成交火模式纪要索引召回关键词。先在 <thinking> 中分析，然后在 <keywords></keywords> 标签中输出关键词。',
      deletable: true,
    },
    {
      role: 'assistant',
      content: '<thinking>\n',
      deletable: true,
    },
  ],
  recallCandidateLimit: 1000,
};

// --- 全局世界书默认配置 ---
export const defaultWorldbookConfig_ACU = {
  source: 'character',
  manualSelection: [] as string[],
  enabledEntries: {} as Record<string, string[]>,
  injectionTarget: 'character',
  outlineEntryEnabled: true,
  zeroTkOccupyMode: false,
  summaryVectorIndexModeEnabled: false,
  // vectorMemory 保留引用以兼容旧数据迁移读取，但新数据写入 settings_ACU.vectorMemoryConfig
  vectorMemory: defaultVectorMemoryConfig_ACU,
};

import { DEFAULT_CONTENT_OPTIMIZATION_PROMPT_GROUP_ACU } from './defaults-json.js';

/** 构建默认正文优化提示词组（纯数据构造，无运行时依赖） */
export function buildDefaultContentOptimizationPromptGroup_ACU({ mainContent = '' } = {}) {
    const src = DEFAULT_CONTENT_OPTIMIZATION_PROMPT_GROUP_ACU;
    const base = Array.isArray(src) ? JSON.parse(JSON.stringify(src)) : [];

    // 如果提供了主内容，替换 $CONTENT 占位符
    if (mainContent) {
        base.forEach((item: any) => {
            if (item.content && typeof item.content === 'string') {
                item.content = item.content.replace(/\$CONTENT/g, mainContent);
            }
        });
    }

    return base;
}
