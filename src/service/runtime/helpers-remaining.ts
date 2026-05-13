/**
 * service/runtime/helpers-remaining.ts — 辅助函数集入口文件
 * 原 4,263 行代码已按职责拆分为以下子模块：
 *   - helpers-context-tags.ts    — 上下文标签提取/过滤
 *   - helpers-table-lock.ts      — 表格锁定与索引
 *   - helpers-data-merge.ts      — 数据合并/格式化/首楼初始化/阈值
 *   - helpers-template-vars.ts   — 模板变量系统（random/calc/max/min/seed/cell/cond/if）
 *   - helpers-plot-runtime.ts    — 剧情推进运行时（task执行/历史/规划/世界书内容）
 *
 * 本文件保留 handleChatCompletionReady_ACU（依赖多个子模块，不适合放入任何单一子模块），
 * 并 re-export 所有子模块的公开 API。
 */
import { currentJsonTableData_ACU, settings_ACU } from './state-manager';
import { logDebug_ACU } from '../../shared/utils';
import { parseRandomTags_ACU, replaceRandomVariables_ACU, parseCalcTags_ACU, parseMaxTags_ACU, parseMinTags_ACU, replaceCalcVariables_ACU, replaceMaxVariables_ACU, replaceMinVariables_ACU, parseIfBlockRecursive_ACU, getLatestAIMessageContent_ACU, replaceDbSqlVariables } from './template-vars';
import { getPlotFromHistory_ACU } from './plot-runtime';

// ═══ 上下文标签提取/过滤 ═══
export {
    getDefaultPlotContextExtractRules_ACU,
    getDefaultPlotContextExcludeRules_ACU,
    applyExcludeRulesToText_ACU,
    applyContextTagFilters_ACU,
} from './helpers-context-tags';

// ═══ 表格锁定与索引 ═══
export {
    getTableLocksForSheet_ACU,
    saveTableLocksForSheet_ACU,
    toggleRowLock_ACU,
    toggleColLock_ACU,
    toggleCellLock_ACU,
    isSpecialIndexLockEnabled_ACU,
    setSpecialIndexLockEnabled_ACU,
    getSummaryIndexColumnIndex_ACU,
    formatSummaryIndexCode_ACU,
    applySummaryIndexSequenceToTable_ACU,
    applySpecialIndexSequenceToSummaryTables_ACU,
} from './helpers-table-lock';

// ═══ 数据合并/格式化/首楼初始化/阈值 ═══
export {
    mergeAllIndependentTables_ACU,
    formatJsonToReadable_ACU,
    getReadableContentStartColumn_ACU,
    hasReadableRowCellData_ACU,
    shouldSuppressWorldbookInjection_ACU,
    maybeLiftWorldbookSuppression_ACU,
    fillFirstLayerWithTemplateData_ACU,
    getEffectiveAutoUpdateThreshold_ACU,
    isNewChatGreetingStage_ACU,
    isSingleAiNoUserChat_ACU,
    buildTemplateBaseStateDataForLocalStorage_ACU,
    seedGreetingLocalDataFromTemplate_ACU,
    parseReadableToJson_ACU,
    GREETING_LOCAL_BASE_STATE_MARKER_ACU,
} from './helpers-data-merge';

// ═══ 模板变量系统 ═══
export {
    parseRandomTags_ACU,
    replaceRandomVariables_ACU,
    parseCalcTags_ACU,
    parseMaxTags_ACU,
    parseMinTags_ACU,
    replaceCalcVariables_ACU,
    replaceMaxVariables_ACU,
    replaceMinVariables_ACU,
    parseIfBlockRecursive_ACU,
    parseIfBlocksInContent_ACU,
    getLatestAIMessageContent_ACU,
} from './template-vars';

// ═══ 剧情推进运行时 ═══
export {
    formatOutlineTableForPlot_ACU,
    formatSummaryIndexForPlot_ACU,
    loadPresetAndCleanCharacterData_ACU,
    getPlotFromHistory_ACU,
    runOptimizationLogic_ACU,
    getWorldbookContentForPlot_ACU,
} from './plot-runtime';

// ═══ 保留在入口文件中的函数（依赖多个子模块） ═══

  function getTableDataForPrompt_ACU() {
    return currentJsonTableData_ACU || {};
  }

  export async function handleChatCompletionReady_ACU(data: any) {
    logDebug_ACU('[提示词模板] handleChatCompletionReady_ACU 被调用');
    logDebug_ACU('[提示词模板] settings_ACU?.promptTemplateSettings:', settings_ACU?.promptTemplateSettings);
    if (!settings_ACU?.promptTemplateSettings?.enabled) {
      logDebug_ACU('[提示词模板] 功能未启用，跳过处理');
      return;
    }
    if (!data || !data.messages || !Array.isArray(data.messages)) {
      return;
    }
    const startTime = Date.now();
    logDebug_ACU('[提示词模板] 开始处理酒馆提示词...');
    const lastPlotContent = getPlotFromHistory_ACU();
    logDebug_ACU('[提示词模板] $6 最新一层推进数据:', lastPlotContent ? `长度=${lastPlotContent.length}` : '(空)');
    const context = {
      seedContent: getLatestAIMessageContent_ACU(),
      allTablesJson: getTableDataForPrompt_ACU(),
      plotContent: lastPlotContent
    };
    const processPromptTemplateContent_ACU = (content: any) => {
      if (typeof content !== 'string' || !content) {
        return typeof content === 'string' ? content : '';
      }
      let processedContent = content;
      processedContent = parseRandomTags_ACU(processedContent);
      processedContent = replaceRandomVariables_ACU(processedContent);
      const contextForCalc = { allTablesJson: context.allTablesJson };
      processedContent = parseCalcTags_ACU(processedContent, contextForCalc);
      processedContent = parseMaxTags_ACU(processedContent, contextForCalc);
      processedContent = parseMinTags_ACU(processedContent, contextForCalc);
      processedContent = replaceCalcVariables_ACU(processedContent);
      processedContent = replaceMaxVariables_ACU(processedContent);
      processedContent = replaceMinVariables_ACU(processedContent);
      // [P4] {[db...]}/{[sql...]} 值替换（SQLite 模式下，在 <if> 之前执行）
      processedContent = replaceDbSqlVariables(processedContent);
      processedContent = parseIfBlockRecursive_ACU(processedContent, context, 0);
      return processedContent;
    };
    let processedCount = 0;
    for (const message of data.messages) {
      if (typeof message.content === 'string') {
        const originalContent = message.content;
        message.content = processPromptTemplateContent_ACU(message.content);
        if (message.content !== originalContent) processedCount++;
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === 'text' && part.text) {
            const originalText = part.text;
            part.text = processPromptTemplateContent_ACU(part.text);
            if (part.text !== originalText) processedCount++;
          }
        }
      }
    }
    const endTime = Date.now();
    logDebug_ACU(`[提示词模板] 处理完成，共处理 ${processedCount} 个消息块，耗时 ${endTime - startTime}ms`);
  }
