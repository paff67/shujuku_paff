/**
 * presentation/pages/visualizer-main-save.ts
 * 可视化编辑器保存变更
 */
/**
 * presentation/pages/visualizer-main.ts — 可视化编辑器主区域 + 保存
 * 从 visualizer.ts 拆出
 */
import { TABLE_TEMPLATE_ACU } from '../../shared/defaults-json.js';
import { isDefaultTemplatePresetSelection_ACU, normalizeTemplatePresetSelectionValue_ACU } from '../../shared/template-preset-utils';
import { getOrderedSheetKeys_ACU } from './visualizer-sidebar';
import { showToastr_ACU } from '../theme/toast';
import { getChatArray_ACU } from '../../service/chat/chat-service';
import { currentJsonTableData_ACU, getCurrentIsolationKey_ACU, settings_ACU, _set_currentJsonTableData_ACU} from '../../service/runtime/state-manager';
import { buildChatSheetGuideDataFromData_ACU, getChatSheetGuideDataForIsolationKey_ACU, sanitizeTemplateSnapshotForChat_ACU, setChatSheetGuideDataForIsolationKey_ACU } from '../../service/template/chat-scope';
import { updateReadableLorebookEntry_ACU } from '../../service/worldbook/pipeline';
import { refreshMergedDataAndNotifyWithUI_ACU } from '../components/pipeline-ui-helpers';
import { SCRIPT_ID_PREFIX_ACU, TABLE_ORDER_FIELD_ACU } from '../../shared/constants';
import { topLevelWindow_ACU } from '../../shared/env';
import { escapeHtml_ACU } from '../../shared/html-helpers';
import { safeJsonStringify_ACU } from '../../shared/json-helpers';
import { applySheetOrderNumbers_ACU, ensureSheetOrderNumbers_ACU, isSummaryOrOutlineTable_ACU, logDebug_ACU, logError_ACU, logWarn_ACU, parseTableTemplateJson_ACU } from '../../shared/utils';
import { saveIndependentTableToChatHistory_ACU } from '../../service/table/table-service';
import { applyTemplatePresetToCurrent_ACU, resolveActiveTemplatePresetName_ACU, upsertTemplatePreset_ACU } from '../../service/template/template-preset-service';
import { loadTemplatePresetSelect_ACU } from '../components/template-preset-ui';
import { updateCardUpdateStatusDisplay_ACU } from '../components/update-status-display';
import { applySpecialIndexSequenceToSummaryTables_ACU, getSummaryIndexColumnIndex_ACU, getTableLocksForSheet_ACU, isSpecialIndexLockEnabled_ACU, setSpecialIndexLockEnabled_ACU, toggleCellLock_ACU, toggleColLock_ACU, toggleRowLock_ACU } from '../../service/runtime/helpers-remaining';
import { getSortedSheetKeys_ACU, materializeDataFromSheetGuide_ACU } from '../../service/template/chat-scope';
import { DEFAULT_ENTRY_PLACEMENT_ACU, DEFAULT_EXTRA_INDEX_PLACEMENT_ACU, buildDefaultGlobalInjectionConfig_ACU, ensureSheetExportConfigDefaults_ACU, getFixedPlacementDefaultsForTable_ACU, getGlobalInjectionConfigFromData_ACU, isImportantPersonsTableName_ACU, isOutlineTableName_ACU, isSummaryTableName_ACU, normalizeLorebookPosition_ACU, normalizePlacementConfig_ACU, purgeSheetKeysFromChatHistoryHard_ACU } from '../../service/worldbook/injection-engine';
import { jQuery_API_ACU } from '../dom-utils';
import { _acuVisState } from './visualizer';
import { $popupInstance_ACU } from '../state/ui-refs';
import { closeACUWindow } from '../window/window-system';
import { isSqliteMode } from '../../service/table/storage-mode';
import { reloadStorageProvider } from '../../service/table/table-storage-strategy';
import { resolveTableHistoryStateFromChat_ACU, getLatestAiMessageIndexFromChat_ACU } from '../../service/table/table-history';
import { getCurrentWorldbookConfig_ACU } from '../../service/settings/settings-readers';
import { enqueueSummaryVectorIndexFlush_ACU } from '../../service/vector/summary-vector-index-flush-queue';


  export async function saveVisualizerChanges_ACU(saveToTemplate = false) {
      // 1. Check for Inheritance (Structure Mismatch)
      // Compare _acuVisState.tempData with original TABLE_TEMPLATE_ACU
      // But user might have just edited tempData to be different from template.
      // The requirement says: "check mismatch between new current table data and the CURRENTLY USED TEMPLATE".
      // If mismatch, prompt inheritance.
      
      // [新增] 按照用户调整的顺序重新组织数据
      const orderedData: Record<string, any> = {};
      const orderedKeys = getOrderedSheetKeys_ACU();
      
      // 先添加非表格数据（如 mate）
      Object.keys(_acuVisState.tempData).forEach((key: string) => {
          if (!key.startsWith('sheet_')) {
              orderedData[key] = _acuVisState.tempData[key];
          }
      });
      
      // 按顺序添加表格数据
      orderedKeys.forEach((key: string) => {
          if (_acuVisState.tempData[key]) {
              orderedData[key] = _acuVisState.tempData[key];
          }
      });

      // [新机制] 保存前统一重编号：编号随当前顺序变化，并写入当前数据（可随导出/导入迁移）
      applySheetOrderNumbers_ACU(orderedData, orderedKeys);
      
      // [新增] 若开启“编码索引列特殊锁定”，保存时强制按 AM 序列重排
      applySpecialIndexSequenceToSummaryTables_ACU(orderedData);
      
      const beforeDataForSave_ACU = currentJsonTableData_ACU
          ? JSON.parse(JSON.stringify(currentJsonTableData_ACU))
          : null;

      // First, apply changes to local variable (使用排序后的数据)
      _set_currentJsonTableData_ACU(JSON.parse(JSON.stringify(orderedData)));

      // [修复] 可视化编辑器属于"用户显式修改表结构/表名/顺序"的入口：
      // 覆盖式更新聊天第一层的"空白指导表"（仅表头+参数，无数据行），让后续合并/显示/填表参数都以此为准。
      // [Bug Fix] 无论"保存到当前聊天"还是"保存到全局"，都必须更新指导表，
      // 否则"保存到全局"后点击填表时，指导表中的旧表头会覆盖用户的修改。
      try {
          const guideIsolationKey = getCurrentIsolationKey_ACU();
          // 需求4（澄清版）：可视化编辑器触发指导表更新时，只更新表名/表头/表格参数，不修改指导表基础数据（seedRows）。
          // - 若当前聊天/标签已存在指导表：必须继承其 seedRows
          // - 若不存在指导表：从当前模板提取预置数据作为 seedRows（需求1）
          const existingGuide = getChatSheetGuideDataForIsolationKey_ACU(guideIsolationKey);
          const templateObjForSeed = parseTableTemplateJson_ACU({ stripSeedRows: false });
          const guideData = buildChatSheetGuideDataFromData_ACU(currentJsonTableData_ACU, {
              preserveSeedRowsFromGuideData: existingGuide,
              seedRowsFromTemplateObj: templateObjForSeed,
          });
          if (guideData && Object.keys(guideData).some(k => k.startsWith('sheet_'))) {
              const syncTemplateScope = !saveToTemplate; // "保存到全局"时不同步模板作用域（由 applyTemplatePresetToCurrent 处理）
              const templateScopeSource = materializeDataFromSheetGuide_ACU(guideData, { includeSeedRows: true });
              setChatSheetGuideDataForIsolationKey_ACU(guideIsolationKey, guideData, {
                  reason: 'visualizer_save',
                  syncTemplateScope,
                  templateSource: templateScopeSource,
                  presetName: resolveActiveTemplatePresetName_ACU({ fallbackToGlobal: true, isolationKey: guideIsolationKey }),
                  source: 'visualizer_save',
              });
              logDebug_ACU(`[SheetGuide] Overwrote chat sheet guide from visualizer for tag [${guideIsolationKey || '无标签'}] (tables=${Object.keys(guideData).filter(k => k.startsWith('sheet_')).length}, saveToTemplate=${saveToTemplate}).`);
          }
      } catch (e) {
          logWarn_ACU('[SheetGuide] Failed to overwrite sheet guide from visualizer:', e);
      }
      const shouldSyncSummaryVectorIndexAfterSave_ACU = getSortedSheetKeys_ACU(currentJsonTableData_ACU).some((sheetKey) => {
          const table = currentJsonTableData_ACU?.[sheetKey];
          return !!table?.name && isSummaryOrOutlineTable_ACU(String(table.name || ''));
      });

      // [新机制] 不再使用 settings_ACU.tableKeyOrder 强制固定顺序（顺序由每张表的 orderNo 决定）
      // 记录本次需要彻底清理的 key（真正清理会在“写回所有楼层”之后执行，防止后续写回把旧表带回）
      const deletedKeysToPurge_ACU = Array.isArray(_acuVisState.deletedSheetKeys) ? [..._acuVisState.deletedSheetKeys] : [];
      
      // Update template only if saveToTemplate is true
      // “保存到全局”会把当前编辑结果同步进全局模板预设；“保存到当前聊天”只沉淀聊天级预设/数据
      if (saveToTemplate) {
          let templateObj: any = null;
          try {
              templateObj = JSON.parse(TABLE_TEMPLATE_ACU);
              if (!templateObj || typeof templateObj !== 'object') templateObj = {};
              // 同步全局注入配置（存入模板 mate，不走 settings）
              const tempGlobalCfg = getGlobalInjectionConfigFromData_ACU(currentJsonTableData_ACU, { ensureWriteBack: true });
              const prevGlobalCfgStr = safeJsonStringify_ACU(templateObj?.mate?.globalInjectionConfig || {}, '{}');
              const nextGlobalCfgStr = safeJsonStringify_ACU(tempGlobalCfg || {}, '{}');
              if (!templateObj.mate || typeof templateObj.mate !== 'object') templateObj.mate = { type: 'chatSheets', version: 1 };
              if (!templateObj.mate.type) templateObj.mate.type = 'chatSheets';
              if (!Number.isFinite(templateObj.mate.version)) templateObj.mate.version = 1;
              templateObj.mate.globalInjectionConfig = tempGlobalCfg;
              let templateChanged = false;
              if (prevGlobalCfgStr !== nextGlobalCfgStr) templateChanged = true;

              // [优化] 全量同步：不仅更新现有表，也处理新增和删除的表
              // 1. 同步 currentJsonTableData_ACU 中的所有表到 templateObj
              Object.keys(currentJsonTableData_ACU).forEach(key => {
                  if (!key.startsWith('sheet_')) return;

                  const currentTable = currentJsonTableData_ACU[key];

                  // 如果模板中没有这个表，或者有这个key但名字变了(虽然key是唯一标识，但为了保险起见)，则新建/覆盖
                  // 这里的逻辑是：以 currentJsonTableData_ACU 为准

                  if (!templateObj[key]) {
                      // 新增表格：克隆整个结构，但清空数据行（保留表头）
                      const newTemplateTable = JSON.parse(JSON.stringify(currentTable));
                      if (newTemplateTable.content && newTemplateTable.content.length > 1) {
                          newTemplateTable.content = [newTemplateTable.content[0]]; // 只保留表头
                      }
                      // [新机制] 同步顺序编号
                      newTemplateTable[TABLE_ORDER_FIELD_ACU] = currentTable[TABLE_ORDER_FIELD_ACU];
                      templateObj[key] = newTemplateTable;
                      templateChanged = true;
                      logDebug_ACU(`Added new table "${currentTable.name}" to template.`);
                  } else {
                      // 更新现有表格
                      const templateTable = templateObj[key];

                      // 检查是否有实质性变更 (参数、表头、名称)
                      let hasChanges = false;

                      if (templateTable.name !== currentTable.name) {
                          templateTable.name = currentTable.name;
                          hasChanges = true;
                      }

                      // Deep compare and update sourceData
                      if (JSON.stringify(templateTable.sourceData) !== JSON.stringify(currentTable.sourceData)) {
                          templateTable.sourceData = currentTable.sourceData ? JSON.parse(JSON.stringify(currentTable.sourceData)) : {};
                          hasChanges = true;
                      }

                      // Deep compare and update updateConfig
                      if (JSON.stringify(templateTable.updateConfig) !== JSON.stringify(currentTable.updateConfig)) {
                          templateTable.updateConfig = currentTable.updateConfig ? JSON.parse(JSON.stringify(currentTable.updateConfig)) : {};
                          hasChanges = true;
                      }

                      // Deep compare and update exportConfig
                      if (JSON.stringify(templateTable.exportConfig) !== JSON.stringify(currentTable.exportConfig)) {
                          templateTable.exportConfig = currentTable.exportConfig ? JSON.parse(JSON.stringify(currentTable.exportConfig)) : {};
                          hasChanges = true;
                      }

                      // [新机制] 同步顺序编号（顺序变化也属于模板变更）
                      if (templateTable[TABLE_ORDER_FIELD_ACU] !== currentTable[TABLE_ORDER_FIELD_ACU]) {
                          templateTable[TABLE_ORDER_FIELD_ACU] = currentTable[TABLE_ORDER_FIELD_ACU];
                          hasChanges = true;
                      }

                      // Update headers (content[0])
                      if (currentTable.content && Array.isArray(currentTable.content) && currentTable.content.length > 0) {
                          const currentHeaders = currentTable.content[0];
                          const templateHeaders = templateTable.content[0];
                          if (JSON.stringify(currentHeaders) !== JSON.stringify(templateHeaders)) {
                              templateTable.content[0] = JSON.parse(JSON.stringify(currentHeaders));
                              hasChanges = true;
                          }
                      }

                      if (hasChanges) {
                          templateChanged = true;
                      }
                  }
              });

              // 2. 删除模板中存在但在 currentJsonTableData_ACU 中已不存在的表
              Object.keys(templateObj).forEach(key => {
                  if (key.startsWith('sheet_') && !currentJsonTableData_ACU[key]) {
                      delete templateObj[key];
                      templateChanged = true;
                      logDebug_ACU(`Removed table key "${key}" from template.`);
                  }
              });

              // [新机制] 再做一次兜底：按当前顺序补齐/重建模板编号（避免极端情况下编号缺失/重复）
              ensureSheetOrderNumbers_ACU(templateObj, { baseOrderKeys: orderedKeys, forceRebuild: false });

              if (templateChanged) {
                  const isolationKey = getCurrentIsolationKey_ACU();
                  const activePresetName = normalizeTemplatePresetSelectionValue_ACU(
                      resolveActiveTemplatePresetName_ACU({ fallbackToGlobal: true, isolationKey }),
                  );
                  let finalGlobalPresetName = activePresetName;
                  if (isDefaultTemplatePresetSelection_ACU(finalGlobalPresetName)) {
                      const promptedName = prompt('请输入要保存到全局的模板预设名称：', '新模板预设');
                      if (!promptedName) return;
                      finalGlobalPresetName = normalizeTemplatePresetSelectionValue_ACU(String(promptedName).trim());
                  } else if (!confirm(`确定要用当前编辑结果覆盖全局预设 "${finalGlobalPresetName}" 吗？`)) {
                      return;
                  }
                  if (!finalGlobalPresetName) return;

                  const preparedSnapshot = sanitizeTemplateSnapshotForChat_ACU(templateObj);
                  if (!preparedSnapshot?.templateStr) {
                      throw new Error('可视化编辑器保存到全局失败：无法生成模板快照。');
                  }
                  const presetSaved = upsertTemplatePreset_ACU(finalGlobalPresetName, preparedSnapshot.templateStr);
                  if (!presetSaved) {
                      throw new Error('可视化编辑器保存到全局失败：无法写入全局预设库。');
                  }

                  const appliedGlobalTemplate = await applyTemplatePresetToCurrent_ACU(finalGlobalPresetName, {
                      source: 'visualizer_save_to_global',
                      updateGlobal: true,
                      save: true,
                      persistChatScope: false,
                  });
                  if (!appliedGlobalTemplate) {
                      throw new Error('可视化编辑器保存到全局失败：模板快照应用失败。');
                  }
                  logDebug_ACU('Template fully synchronized via Visualizer.');
                  showToastr_ACU('success', `更改已保存到全局预设：${finalGlobalPresetName}；当前聊天的本地预设不会被自动清除。`);
              } else {
                  showToastr_ACU('info', '模板无变化，无需保存。');
              }
          } catch (e) {
              logError_ACU('Error updating template from visualizer:', e);
          }
      }

      // 2. Save to Chat History (per table, back to its original floor)
      const chat = getChatArray_ACU();
      if (!chat.length) {
          showToastr_ACU('warning', '聊天记录为空，更改仅保存在内存，未持久化。');
      } else {
          // 2.1 预先获取当前隔离标签与所有表
          const isolationKey = getCurrentIsolationKey_ACU();
          const allSheetKeys = getSortedSheetKeys_ACU(currentJsonTableData_ACU);
          
          // 2.2 计算最新一条 AI 楼层索引，作为兜底
          const latestAiIndex = getLatestAiMessageIndexFromChat_ACU(chat);
          
          // 2.3 查找每张表当前最新数据所在的原楼层
          const bucketByIndex: Record<number, string[]> = {};
          const resolveTargetIndexForSheet = (sheetKey: string) => {
              const table = currentJsonTableData_ACU[sheetKey];
              const history = resolveTableHistoryStateFromChat_ACU(chat, {
                  sheetKey,
                  isSummaryTable: table ? isSummaryOrOutlineTable_ACU(table.name) : false,
                  isolationKey,
                  settings: settings_ACU,
              });
              return history.latestDataMessageIndex !== -1 ? history.latestDataMessageIndex : latestAiIndex;
          };
          
          allSheetKeys.forEach(key => {
              const idx = resolveTargetIndexForSheet(key);
              if (idx === -1) return; // 没有可保存的AI楼层
              
              if (!bucketByIndex[idx]) bucketByIndex[idx] = [];
              bucketByIndex[idx].push(key);
          });
          
          // 如果一个都没匹配到，但存在AI消息，则全部落在最新楼层以避免数据丢失
          if (Object.keys(bucketByIndex).length === 0 && latestAiIndex !== -1) {
              bucketByIndex[latestAiIndex] = [...allSheetKeys];
          }
          
          if (Object.keys(bucketByIndex).length === 0) {
              showToastr_ACU('warning', '找不到AI消息，更改仅保存到内存，未持久化到聊天记录。');
          } else {
              // 2.4 分楼层保存，每层只保存属于该层的表
              const afterDataForSave_ACU = currentJsonTableData_ACU
                  ? JSON.parse(JSON.stringify(currentJsonTableData_ACU))
                  : null;
              for (const [indexStr, keys] of Object.entries(bucketByIndex)) {
                  const idx = parseInt(indexStr, 10);
                  if (Number.isNaN(idx)) continue;
                  await saveIndependentTableToChatHistory_ACU({
                      targetMessageIndex: idx,
                      targetSheetKeys: keys as string[],
                      updateGroupKeys: null,
                      beforeData: beforeDataForSave_ACU,
                      afterData: afterDataForSave_ACU,
                      trackAsUpdate: true,
                  });
              }

              // 2.4.5 [关键] 如果本次在可视化编辑器删除了表格，则此处追溯整个聊天记录做“硬删除”
              // 说明：saveIndependentTableToChatHistory_ACU 只会覆盖/追加 keys，不会自动移除旧 keys，因此必须额外做一次全局清理。
              if (typeof purgeSheetKeysFromChatHistoryHard_ACU === 'function' && deletedKeysToPurge_ACU.length > 0) {
                  try {
                      const r = await purgeSheetKeysFromChatHistoryHard_ACU(deletedKeysToPurge_ACU);
                    if (r?.changed) {
                            logDebug_ACU(`[VisualizerDelete] Hard-purged ${deletedKeysToPurge_ACU.length} keys from ${r.changedCount} AI messages.`);
                            if ((topLevelWindow_ACU as any)?.AutoCardUpdaterAPI) {
                                (topLevelWindow_ACU as any).AutoCardUpdaterAPI._notifyTableUpdate();
                            }
                            // SQLite 模式下重建运行时数据库实例，确保模板切换时不会残留旧表结构或旧数据
                            if (isSqliteMode()) {
                                try {
                                    await reloadStorageProvider();
                                    logDebug_ACU('[VisualizerDelete] SQLite 运行时数据库已重建');
                                } catch (reloadError) {
                                    logWarn_ACU(`[VisualizerDelete] reloadStorageProvider 失败: ${reloadError?.message}，继续使用当前 provider`);
                                }
                            }
                        }
                        _acuVisState.deletedSheetKeys = [];
                  } catch (e) {
                      logWarn_ACU('[VisualizerDelete] Hard purge failed:', e);
                      // 不清空队列，让用户再次保存时有机会重试
                  }
              }

              // 2.5 所有保存完成后再统一刷新，确保读取最新数据再进行后续操作
              await refreshMergedDataAndNotifyWithUI_ACU();
              if (shouldSyncSummaryVectorIndexAfterSave_ACU && getCurrentWorldbookConfig_ACU().summaryVectorIndexModeEnabled === true) {
                  try {
                      const queueResult = await enqueueSummaryVectorIndexFlush_ACU({
                          targetMessageIndex: latestAiIndex !== -1 ? latestAiIndex : undefined,
                          mode: 'sync',
                          reason: 'visualizer_save',
                      });
                      if (!queueResult.queued && !queueResult.skipped) {
                          logWarn_ACU('[VisualizerVectorIndex] 交火索引防抖归档入队失败:', queueResult.reason);
                          showToastr_ACU('warning', `表格已保存，但交火索引防抖归档入队失败：${queueResult.reason || 'unknown'}`);
                      } else if (queueResult.skipped) {
                          logDebug_ACU(`[VisualizerVectorIndex] 交火索引防抖归档入队跳过: ${queueResult.reason || 'skipped'}`);
                      } else {
                          logDebug_ACU(`[VisualizerVectorIndex] 交火索引防抖归档已入队: scope=${queueResult.scopeKey || ''}`);
                      }
                  } catch (error) {
                      logWarn_ACU('[VisualizerVectorIndex] 交火索引防抖归档入队异常:', error);
                      showToastr_ACU('warning', '表格已保存，但交火索引防抖归档入队异常，请查看控制台日志。');
                  }
              }
              if ($popupInstance_ACU && $popupInstance_ACU.length) {
                  loadTemplatePresetSelect_ACU({ keepGlobalValue: false });
              }
              showToastr_ACU('success', '更改已按原楼层保存到聊天记录！');
          }
      }

      // 3. Trigger UI Update & Worldbook Injection
      await updateReadableLorebookEntry_ACU(true);
      (topLevelWindow_ACU as any).AutoCardUpdaterAPI._notifyTableUpdate();
      if (typeof updateCardUpdateStatusDisplay_ACU === 'function') updateCardUpdateStatusDisplay_ACU();

      // 4. Inheritance Check (已移除旧逻辑)
      // await checkAndPerformInheritance_ACU(templateObj);

      // Close
      closeACUWindow(`${SCRIPT_ID_PREFIX_ACU}-visualizer-window`);
  }

  // --- [Inheritance Logic (Legacy Removed)] ---
