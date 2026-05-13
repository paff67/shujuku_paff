import { getCurrentWorldbookConfig_ACU } from '../settings/settings-readers';
import { allChatMessages_ACU, coreApisAreReady_ACU, currentChatFileIdentifier_ACU, currentJsonTableData_ACU, getCurrentIsolationKey_ACU, settings_ACU, _set_currentJsonTableData_ACU, _set_allChatMessages_ACU} from '../runtime/state-manager';
import { getLorebookEntries_ACU as gwGetLorebookEntries_ACU, setLorebookEntries_ACU as gwSetLorebookEntries_ACU, createLorebookEntries_ACU as gwCreateLorebookEntries_ACU, deleteLorebookEntries_ACU as gwDeleteLorebookEntries_ACU, listLorebooks_ACU, getWorldBooks_ACU as gwGetWorldBooks_ACU, isWorldbookApiAvailable_ACU } from '../../data/gateways/worldbook-gateway';
import { getCharLorebooks_ACU, getChatMessages_ACU } from '../../data/gateways/character-gateway';
import { getChatLength_ACU } from '../../data/gateways/chat-gateway';
import { saveSettings_ACU } from '../settings/settings-service';
import { getChatSheetGuideDataForIsolationKey_ACU, getSortedSheetKeys_ACU, materializeDataFromSheetGuide_ACU, reorderDataBySheetKeys_ACU } from '../template/chat-scope';
import { getImportBatchPrefix_ACU, getImportStablePrefix_ACU } from '../../shared/constants';
import { logDebug_ACU, logError_ACU, logWarn_ACU, parseTableTemplateJson_ACU } from '../../shared/utils';
import { isEntryBlocked_ACU } from '../../shared/utils';
import { formatJsonToReadable_ACU, getReadableContentStartColumn_ACU, hasReadableRowCellData_ACU, maybeLiftWorldbookSuppression_ACU, mergeAllIndependentTables_ACU, shouldSuppressWorldbookInjection_ACU } from '../runtime/helpers-remaining';
import { isSqliteMode } from '../table/storage-mode';
import { reloadStorageProvider, getStorageProvider } from '../table/table-storage-strategy';
import { allocConsecutiveOrderBlock_ACU, applyPlacementToEntry_ACU, buildDefaultGlobalInjectionConfig_ACU, buildUsedOrderSet_ACU, ensureExportConfigDefaults_ACU, ensureGlobalInjectionConfigDefaults_ACU, getEntryOrderNumber_ACU, getFixedPlacementDefaultsForTable_ACU, getInjectionTargetLorebook_ACU, getIsolationPrefix_ACU, isEntryPlacementMatched_ACU, normalizeLorebookPosition_ACU, normalizePlacementConfig_ACU, updateCustomTableExports_ACU, updateImportantPersonsRelatedEntries_ACU, updateOutlineTableEntry_ACU, updateSummaryTableEntries_ACU } from './injection-engine';
// pipeline.ts
// 从 05_core_tail.js 迁入

export   async function updateReadableLorebookEntry_ACU(createIfNeeded = false, isImport = false, targetLorebookOverride: string | null = null) { // [外部导入] 添加 targetLorebookOverride 参数，避免临时修改 worldbookConfig 被兜底补齐逻辑覆盖
    // [健全性] 新对话开场白阶段：禁止自动创建/更新世界书条目
    // - 仅影响非导入流程（isImport=false）
    // - 仅在“无任何用户消息”的开场白阶段生效
    // - 用户一旦开始对话，会自动解除抑制
    if (!isImport) {
        maybeLiftWorldbookSuppression_ACU();
        if (shouldSuppressWorldbookInjection_ACU()) {
            // 注意：这里必须“只抑制注入/创建”，但不能抑制“清理旧条目/回退导致的删除”。
            // 因此在抑制期间，我们仍然执行一次清理，以确保新开对话会清除旧世界书条目。
            try {
                await deleteAllGeneratedEntries_ACU();
                logDebug_ACU('[Worldbook] Greeting-stage suppression: cleanup-only (no create/update).');
            } catch (e) {
                logWarn_ACU('[Worldbook] Greeting-stage cleanup-only failed:', e);
            }
            return;
        }
    }

    // [新增] 分别从最新的标准表和总结表数据源中拉取数据并合并
    let mergedData = null;
    
    if (isImport) {
        // 外部导入时，直接使用 currentJsonTableData_ACU
        mergedData = currentJsonTableData_ACU;
    } else {
        // 正常更新时，SQL 模式必须从 provider 取当前数据，避免世界书刷新反向覆盖 SQLite 视图。
        await loadAllChatMessages_ACU();
        if (isSqliteMode()) {
            try {
                mergedData = getStorageProvider().getCurrentData();
            } catch (e: any) {
                logWarn_ACU(`[Worldbook] SQLite provider getCurrentData failed, fallback to current JSON view: ${e?.message}`);
                mergedData = currentJsonTableData_ACU;
            }
        } else {
            const mergedFromHistory = await mergeAllIndependentTables_ACU();
            if (mergedFromHistory) {
                mergedData = mergedFromHistory;
                // 同步内存中的全局数据，确保后续调用保持一致
                _set_currentJsonTableData_ACU(mergedFromHistory);
            } else {
                // 如果合并失败，退回到当前内存数据避免中断
                mergedData = currentJsonTableData_ACU;
            }
        }
    }

    if (!mergedData) {
        logWarn_ACU('Update readable lorebook aborted: no data available.');
        return;
    }
    
    const { readableText, importantPersonsTable, summaryTable, outlineTable } = formatJsonToReadable_ACU(mergedData);
    const hasAnyNonEmptyCell_ACU = (data: Record<string, any> | null) => {
        if (!data) return false;
        const sheetKeys = Object.keys(data).filter(k => k.startsWith('sheet_'));
        for (const sheetKey of sheetKeys) {
            const table = data[sheetKey];
            const content = table?.content;
            if (!Array.isArray(content) || content.length <= 1) continue;
            const headerRow = Array.isArray(content[0]) ? content[0] : [];
            const startColumn = getReadableContentStartColumn_ACU(headerRow);
            for (let r = 1; r < content.length; r++) {
                if (hasReadableRowCellData_ACU(content[r], startColumn)) return true;
            }
        }
        return false;
    };

    const hasNonEmptyCellData_ACU = hasAnyNonEmptyCell_ACU(mergedData);
    const hasReadableContent_ACU = !!(readableText && readableText.trim() !== '' && !readableText.includes('数据库为空。'));
    let isDatabaseEmpty = false;
    if (isImport) {
        // [修复] 该判空放宽逻辑仅对“外部导入”生效：
        // - 外部导入可能只选择“单独导出到世界书”的表格，此时 readableText 会故意为空；
        // - 重要人物表 / 总结表 / 总体大纲也会被 formatJsonToReadable_ACU 排除在 readableText 之外。
        // 只要 mergedData 里仍有非空单元格，就必须继续走世界书条目创建链路。
        isDatabaseEmpty = !hasNonEmptyCellData_ACU;
        if (!hasReadableContent_ACU && hasNonEmptyCellData_ACU) {
            logDebug_ACU('[Worldbook][Import] readableText 为空，但 mergedData 仍有有效单元格；按“数据库非空”继续创建世界书条目。');
        }
    } else {
        if (!readableText || readableText.trim() === '' || readableText.includes('数据库为空。')) {
            isDatabaseEmpty = true;
        } else if (!hasNonEmptyCellData_ACU) {
            isDatabaseEmpty = true;
        }
    }

    // Call all the individual entry updaters
    await updateImportantPersonsRelatedEntries_ACU(importantPersonsTable, isImport);
    await updateSummaryTableEntries_ACU(summaryTable, isImport);
    await updateOutlineTableEntry_ACU(outlineTable, isImport);

    // [修复] 自定义导出/按行拆分条目是否需要注入，应以 mergedData 中是否存在真实单元格数据为准，
    // 不能再依赖 readableText 判空。
    // 否则当所有表格都开启“按行拆分”后，readableText 会为空，进而误判为“数据库为空”，
    // 导致本应创建的拆分世界书条目被整体跳过。
    if (hasNonEmptyCellData_ACU) {
        await updateCustomTableExports_ACU(mergedData, isImport);
    } else {
        await updateCustomTableExports_ACU(null, isImport); // 仅清理旧自定义导出条目，不创建新条目
    }

    // [修复] 外部导入时优先使用 targetLorebookOverride 参数，避免临时修改 worldbookConfig 被兜底补齐逻辑覆盖
    const primaryLorebookName = targetLorebookOverride || await getInjectionTargetLorebook_ACU();
    if (primaryLorebookName) {
        try {
            const IMPORT_PREFIX = getImportBatchPrefix_ACU();
            // [修改] 加入隔离标识前缀
            const isoPrefix = getIsolationPrefix_ACU();
            const baseReadableComment = isImport ? `${IMPORT_PREFIX}TavernDB-ACU-ReadableDataTable` : 'TavernDB-ACU-ReadableDataTable';
            const READABLE_LOREBOOK_COMMENT = isoPrefix + baseReadableComment;
            // [修复] 外部导入的包裹条目必须带外部导入前缀，避免被 deleteAllGeneratedEntries_ACU 当作“本体注入条目”清理
            const WRAPPER_START_COMMENT = isoPrefix + (isImport ? `${IMPORT_PREFIX}TavernDB-ACU-WrapperStart` : 'TavernDB-ACU-WrapperStart');
            const WRAPPER_END_COMMENT = isoPrefix + (isImport ? `${IMPORT_PREFIX}TavernDB-ACU-WrapperEnd` : 'TavernDB-ACU-WrapperEnd');
            
            const entries = await gwGetLorebookEntries_ACU(primaryLorebookName);
            const usedOrders = buildUsedOrderSet_ACU(entries);
            const db2Entry = entries.find(e => e.comment === READABLE_LOREBOOK_COMMENT);
            const templateObjForGlobalCfg = parseTableTemplateJson_ACU({ stripSeedRows: false });
            const globalCfgRaw =
                mergedData?.mate?.globalInjectionConfig
                ?? currentJsonTableData_ACU?.mate?.globalInjectionConfig
                ?? templateObjForGlobalCfg?.mate?.globalInjectionConfig;
            const globalCfgFromData = ensureGlobalInjectionConfigDefaults_ACU(globalCfgRaw);
            const globalDefaults = buildDefaultGlobalInjectionConfig_ACU();
            const globalFixedEntryPlacement = normalizePlacementConfig_ACU(globalCfgFromData?.readableEntryPlacement, globalDefaults.readableEntryPlacement);
            const globalFixedIndexPlacement = normalizePlacementConfig_ACU(globalCfgFromData?.wrapperPlacement, globalDefaults.wrapperPlacement);
            const summaryCfg = ensureExportConfigDefaults_ACU(summaryTable?.exportConfig, summaryTable?.name || '总结表');
            const summaryFixedEntryPlacement = normalizePlacementConfig_ACU(
                summaryCfg.fixedEntryPlacement,
                getFixedPlacementDefaultsForTable_ACU(summaryTable?.name || '总结表').entry
            );
            const summaryFixedIndexPlacement = normalizePlacementConfig_ACU(
                summaryCfg.fixedIndexPlacement,
                getFixedPlacementDefaultsForTable_ACU(summaryTable?.name || '总结表').index
            );

            // [修复] 自定义导出条目与全局条目必须共用同一套“数据库是否为空”判定。
            // 否则会出现：全局条目已正确判空不注入，但自定义导出条目因为更早执行而提前被创建。
            if (isDatabaseEmpty) {
                // 数据库为空：不应在世界书中固定注入任何包裹条目，顺便清理旧条目避免残留
                const toDelete = [];
                if (db2Entry) toDelete.push(db2Entry.uid);

                const wrapperStartOld = entries.find(e => e.comment === WRAPPER_START_COMMENT);
                const wrapperEndOld = entries.find(e => e.comment === WRAPPER_END_COMMENT);
                const memoryStartOld = entries.find(e => e.comment === (isoPrefix + (isImport ? `${IMPORT_PREFIX}TavernDB-ACU-MemoryStart` : 'TavernDB-ACU-MemoryStart')));
                const memoryEndOld = entries.find(e => e.comment === (isoPrefix + (isImport ? `${IMPORT_PREFIX}TavernDB-ACU-MemoryEnd` : 'TavernDB-ACU-MemoryEnd')));
                if (wrapperStartOld) toDelete.push(wrapperStartOld.uid);
                if (wrapperEndOld) toDelete.push(wrapperEndOld.uid);
                if (memoryStartOld) toDelete.push(memoryStartOld.uid);
                if (memoryEndOld) toDelete.push(memoryEndOld.uid);

                if (toDelete.length > 0) {
                    await gwDeleteLorebookEntries_ACU(primaryLorebookName, toDelete);
                    logDebug_ACU(`Deleted ${toDelete.length} lorebook entries because database is empty/reset (readable + wrappers).`);
                }
                return; // 数据库为空时，不再继续创建或更新
            }

            // [修复2026-03-29] 全局条目顺序修正：使用 allocConsecutiveOrderBlock_ACU 分配连续的 3 个 order 区块
            // 确保顺序始终为：包裹上(baseOrder) → 全局内容(baseOrder+1) → 包裹下(baseOrder+2)
            // 即使默认 order 值被占用，也能保证三个条目的 order 是连续的
            const globalWrapperBlockBase = allocConsecutiveOrderBlock_ACU(usedOrders, 3, globalFixedIndexPlacement.order, 1, 99999);
            const wrapperStartOrder = globalWrapperBlockBase;
            const globalContentOrder = globalWrapperBlockBase + 1;
            const wrapperEndOrder = globalWrapperBlockBase + 2;
            
            if (db2Entry) {
                const newContent = readableText;
                const needsUpdate =
                    (db2Entry.content !== newContent) ||
                    (db2Entry.type !== 'constant') ||
                    (db2Entry.enabled !== true) ||
                    (db2Entry.prevent_recursion !== true) ||
                    (getEntryOrderNumber_ACU(db2Entry) !== globalContentOrder) ||
                    !isEntryPlacementMatched_ACU(db2Entry, globalFixedIndexPlacement);
                if (needsUpdate) {
                    const updatedDb2Entry = applyPlacementToEntry_ACU({
                        uid: db2Entry.uid,
                        content: newContent,
                        enabled: true,
                        type: 'constant',
                        order: globalContentOrder,
                        prevent_recursion: true,
                    }, globalFixedIndexPlacement);
                    await gwSetLorebookEntries_ACU(primaryLorebookName, [updatedDb2Entry]);
                    logDebug_ACU('Successfully updated the global readable lorebook entry.');
                } else {
                    logDebug_ACU('Global readable lorebook entry is already up-to-date.');
                }
            } else if (createIfNeeded) {
                const newDb2Entry = applyPlacementToEntry_ACU({
                    comment: READABLE_LOREBOOK_COMMENT,
                    content: readableText,
                    keys: ['TavernDB-ACU-ReadableDataTable-Key'],
                    enabled: true,
                    type: 'constant',
                    order: globalContentOrder,
                    prevent_recursion: true,
                }, globalFixedIndexPlacement);
                await gwCreateLorebookEntries_ACU(primaryLorebookName, [newDb2Entry]);
                logDebug_ACU('Global readable lorebook entry not found. Created a new one.');
            }

            // [新增] 创建 WrapperStart 条目
            const wrapperStartEntry = entries.find(e => e.comment === WRAPPER_START_COMMENT);
            const wrapperStartContent = '<最新数据与记录>\n以下是在这个时间点，当前场景下剧情相关的最新数据与记录，你在进行剧情分析时必须以此最新的数据为准，以下数据与记录的优先级高于其他任何背景设定：\n\n';
            if (!wrapperStartEntry) {
                await gwCreateLorebookEntries_ACU(primaryLorebookName, [applyPlacementToEntry_ACU({
                    comment: WRAPPER_START_COMMENT,
                    content: wrapperStartContent,
                    keys: ['TavernDB-ACU-WrapperStart-Key'],
                    enabled: true,
                    type: 'constant',
                    order: wrapperStartOrder,
                    prevent_recursion: true,
                }, globalFixedIndexPlacement)]);
                logDebug_ACU('Created wrapper start entry.');
            } else {
                const wrapperStartNeedsUpdate =
                    wrapperStartEntry.content !== wrapperStartContent ||
                    wrapperStartEntry.enabled !== true ||
                    wrapperStartEntry.type !== 'constant' ||
                    wrapperStartEntry.prevent_recursion !== true ||
                    getEntryOrderNumber_ACU(wrapperStartEntry) !== wrapperStartOrder ||
                    !isEntryPlacementMatched_ACU(wrapperStartEntry, globalFixedIndexPlacement);
                if (wrapperStartNeedsUpdate) {
                    await gwSetLorebookEntries_ACU(primaryLorebookName, [
                        applyPlacementToEntry_ACU({
                            uid: wrapperStartEntry.uid,
                            content: wrapperStartContent,
                            enabled: true,
                            type: 'constant',
                            order: wrapperStartOrder,
                            prevent_recursion: true,
                        }, globalFixedIndexPlacement)
                    ]);
                }
            }

            // [新增] 创建或更新 MemoryStart 条目（整合总结表表头）
            const MEMORY_START_COMMENT = isoPrefix + (isImport ? `${IMPORT_PREFIX}TavernDB-ACU-MemoryStart` : 'TavernDB-ACU-MemoryStart');
            const MEMORY_END_COMMENT = isoPrefix + (isImport ? `${IMPORT_PREFIX}TavernDB-ACU-MemoryEnd` : 'TavernDB-ACU-MemoryEnd');
            const memoryStartEntry = entries.find(e => e.comment === MEMORY_START_COMMENT);
            const memoryEndEntry = entries.find(e => e.comment === MEMORY_END_COMMENT);

            // [修复] 检查总结表是否有数据（至少有一行非表头数据）
            const hasSummaryData = summaryTable && summaryTable.content && summaryTable.content.length > 1;
            
            if (!hasSummaryData) {
                // [修复] 没有总结表数据时，删除已存在的 MemoryStart/MemoryEnd 条目
                const memoryEntriesToDelete = [];
                if (memoryStartEntry) memoryEntriesToDelete.push(memoryStartEntry.uid);
                if (memoryEndEntry) memoryEntriesToDelete.push(memoryEndEntry.uid);
                
                if (memoryEntriesToDelete.length > 0) {
                    await gwDeleteLorebookEntries_ACU(primaryLorebookName, memoryEntriesToDelete);
                    logDebug_ACU(`Deleted ${memoryEntriesToDelete.length} MemoryStart/MemoryEnd entries because summary table is empty.`);
                }
            } else {
                // 有总结表数据时，正常创建或更新 MemoryStart/MemoryEnd 条目
                // 准备总结表表头内容
                let summaryHeaderContent = '';
                const summaryHeaders = summaryTable.content[0].slice(1);
                if (summaryHeaders.length > 0) {
                    summaryHeaderContent = `# ${summaryTable.name}\n\n| ${summaryHeaders.join(' | ')} |\n|${summaryHeaders.map(() => '---').join('|')}|`;
                }
                
                // 构建 MemoryStart 条目内容
                let memoryStartContent = '<过往记忆>\n\n以下是你回忆起的跟当前剧情有关的过往的记忆，你要特地注意该记忆所标注的时间，以及分析与当前剧情的相关性，完美地将其融入本轮的剧情编写中：\n\n';
                if (summaryHeaderContent) {
                    memoryStartContent += summaryHeaderContent + '\n\n';
                }

                // =========================
                // [总结表] 3-depth 成组对齐：
                // - MemoryStart / 总结行条目 / MemoryEnd 只占用连续 3 个 order(深度)
                // - 这 3 个深度不能与任何已有条目重合，且必须紧挨在一起
                // =========================
                const baseSummaryPrefix2 = isImport ? `${IMPORT_PREFIX}总结条目` : '总结条目';
                const baseSmallSummaryPrefix2 = isImport ? `${IMPORT_PREFIX}小总结条目` : '小总结条目';
                const SUMMARY_ENTRY_PREFIX2 = isoPrefix + baseSummaryPrefix2;
                const SMALL_SUMMARY_PREFIX2 = isoPrefix + baseSmallSummaryPrefix2;
                const summaryOrderBlockBase = allocConsecutiveOrderBlock_ACU(usedOrders, 3, Math.max(1, summaryFixedEntryPlacement.order - 1), 1, 99999);
                const memoryStartOrder = summaryOrderBlockBase;
                const summaryDataOrder = summaryOrderBlockBase + 1;
                const memoryEndOrder = summaryOrderBlockBase + 2;

                // 将"总结条目/小总结条目"统一挪到 summaryDataOrder（多条共用同一深度）
                const summaryEntriesToReorder = entries.filter(e => {
                    const c = e?.comment || '';
                    return c.startsWith(SUMMARY_ENTRY_PREFIX2) || c.startsWith(SMALL_SUMMARY_PREFIX2);
                });
                if (summaryEntriesToReorder.length > 0) {
                    await gwSetLorebookEntries_ACU(
                        primaryLorebookName,
                        summaryEntriesToReorder.map(e => applyPlacementToEntry_ACU({ uid: e.uid, order: summaryDataOrder }, summaryFixedEntryPlacement))
                    );
                }
                
                if (!memoryStartEntry) {
                    // 创建新条目
                    await gwCreateLorebookEntries_ACU(primaryLorebookName, [applyPlacementToEntry_ACU({
                            comment: MEMORY_START_COMMENT,
                            content: memoryStartContent,
                            keys: ['AM'],
                            enabled: true,
                            type: 'keyword',
                            order: memoryStartOrder,
                            prevent_recursion: true,
                        }, summaryFixedIndexPlacement)]);
                } else {
                    // 更新现有条目（内容/深度）
                    const needsUpdate =
                        (memoryStartEntry.content !== memoryStartContent) ||
                        (getEntryOrderNumber_ACU(memoryStartEntry) !== memoryStartOrder) ||
                        !isEntryPlacementMatched_ACU(memoryStartEntry, summaryFixedIndexPlacement);
                    if (needsUpdate) {
                        await gwSetLorebookEntries_ACU(primaryLorebookName, [{
                            ...applyPlacementToEntry_ACU({
                                uid: memoryStartEntry.uid,
                                content: memoryStartContent,
                                order: memoryStartOrder,
                                enabled: true,
                                type: 'keyword',
                                prevent_recursion: true,
                                keys: memoryStartEntry.keys || memoryStartEntry.key || ['AM'],
                            }, summaryFixedIndexPlacement)
                        }]);
                    }
                }

                // [新增] 创建 MemoryEnd 条目
                if (!memoryEndEntry) {
                    await gwCreateLorebookEntries_ACU(primaryLorebookName, [applyPlacementToEntry_ACU({
                            comment: MEMORY_END_COMMENT,
                            content: '</过往记忆>',
                            keys: ['AM'],
                            enabled: true,
                            type: 'keyword',
                            order: memoryEndOrder,
                            prevent_recursion: true,
                        }, summaryFixedIndexPlacement)]);
                } else {
                    const needsUpdate =
                        (getEntryOrderNumber_ACU(memoryEndEntry) !== memoryEndOrder) ||
                        !isEntryPlacementMatched_ACU(memoryEndEntry, summaryFixedIndexPlacement);
                    if (needsUpdate) {
                        await gwSetLorebookEntries_ACU(primaryLorebookName, [{
                            ...applyPlacementToEntry_ACU({
                                uid: memoryEndEntry.uid,
                                order: memoryEndOrder,
                                enabled: true,
                                type: 'keyword',
                                prevent_recursion: true,
                                keys: memoryEndEntry.keys || memoryEndEntry.key || ['AM'],
                            }, summaryFixedIndexPlacement)
                        }]);
                    }
                }
            } // end of hasSummaryData

            // [新增] 创建 WrapperEnd 条目
            // [修复2026-03-29] 使用 globalWrapperBlockBase + 2 作为 wrapperEndOrder（已在上方通过 allocConsecutiveOrderBlock_ACU 分配）
            const wrapperEndEntry = entries.find(e => e.comment === WRAPPER_END_COMMENT);
            const wrapperEndContent = '</最新数据与记录>';
            if (!wrapperEndEntry) {
                await gwCreateLorebookEntries_ACU(primaryLorebookName, [applyPlacementToEntry_ACU({
                    comment: WRAPPER_END_COMMENT,
                    content: wrapperEndContent,
                    keys: ['TavernDB-ACU-WrapperEnd-Key'],
                    enabled: true,
                    type: 'constant',
                    order: wrapperEndOrder,
                    prevent_recursion: true,
                }, globalFixedIndexPlacement)]);
                logDebug_ACU('Created wrapper end entry.');
            } else {
                const wrapperEndNeedsUpdate =
                    wrapperEndEntry.content !== wrapperEndContent ||
                    wrapperEndEntry.enabled !== true ||
                    wrapperEndEntry.type !== 'constant' ||
                    wrapperEndEntry.prevent_recursion !== true ||
                    getEntryOrderNumber_ACU(wrapperEndEntry) !== wrapperEndOrder ||
                    !isEntryPlacementMatched_ACU(wrapperEndEntry, globalFixedIndexPlacement);
                if (wrapperEndNeedsUpdate) {
                    await gwSetLorebookEntries_ACU(primaryLorebookName, [
                        applyPlacementToEntry_ACU({
                            uid: wrapperEndEntry.uid,
                            content: wrapperEndContent,
                            enabled: true,
                            type: 'constant',
                            order: wrapperEndOrder,
                            prevent_recursion: true,
                        }, globalFixedIndexPlacement)
                    ]);
                }
            }
        } catch(error) {
            logError_ACU('Failed to get or update readable lorebook entry:', error);
        }
    }
  }


export   async function deleteAllGeneratedEntries_ACU(targetLorebook: string | null = null) {
    const primaryLorebookName = targetLorebook || (await getInjectionTargetLorebook_ACU());
    if (!primaryLorebookName) return;

    try {
        const allEntries = await gwGetLorebookEntries_ACU(primaryLorebookName);
        
        // [修改] 根据隔离状态构建删除逻辑
        const isolationPrefix = getIsolationPrefix_ACU();
        
        const basePrefixes = [
            'TavernDB-ACU-ReadableDataTable',
            'TavernDB-ACU-OutlineTable',
            '重要人物条目',
            'TavernDB-ACU-ImportantPersonsIndex',
            '总结条目',
            '小总结条目',
            'TavernDB-ACU-CustomExport',
            'TavernDB-ACU-WrapperStart',
            'TavernDB-ACU-WrapperEnd',
            'TavernDB-ACU-MemoryStart',
            'TavernDB-ACU-MemoryEnd',
            'TavernDB-ACU-PersonsHeader'
        ];

        // [修改] 使用 knownCustomEntryNames 增强删除逻辑
        const knownNames = settings_ACU.knownCustomEntryNames || [];
        
        // [新增] 获取当前配置的预期前缀作为补充 (防止 knownNames 丢失)
        const currentConfigPrefixes = new Set();
        if (currentJsonTableData_ACU) {
             const tableKeys = getSortedSheetKeys_ACU(currentJsonTableData_ACU);
             tableKeys.forEach(sheetKey => {
                 const table = currentJsonTableData_ACU[sheetKey];
                 if (table && table.exportConfig && table.exportConfig.enabled) {
                     const entryName = table.exportConfig.entryName || table.name;
                     if (entryName) {
                         currentConfigPrefixes.add(entryName);
                     }
                 }
             });
        }

        const uidsToDelete = allEntries
            .filter(entry => {
                if (!entry.comment) return false;

                // [严重问题修复] 外部导入生成的条目一律不参与“自动清理”
                // 说明：切回脚本/读不到聊天表格数据时，可能会触发 deleteAllGeneratedEntries_ACU 清理旧条目；
                // 但外部导入条目应被视为第三方条目，只允许用户手动清理/删除。
                if (settings_ACU.dataIsolationEnabled) {
                    if (isolationPrefix && entry.comment.startsWith(isolationPrefix + '外部导入-')) return false;
                } else {
                    if (entry.comment.startsWith('外部导入-')) return false;
                }
                
                if (settings_ACU.dataIsolationEnabled) {
                    // 隔离模式：只删除匹配当前标识前缀的
                    if (!isolationPrefix) return false;
                    
                    // 1. 基础前缀
                    if (basePrefixes.some(prefix => entry.comment.startsWith(isolationPrefix + prefix))) return true;

                    // 2. 已知自定义条目 (Known List) - 必须匹配隔离前缀
                    if (knownNames.includes(entry.comment) && entry.comment.startsWith(isolationPrefix)) return true;

                    // 3. 当前配置前缀 (Fallback)
                    for (const customPrefix of currentConfigPrefixes) {
                        if (entry.comment.startsWith(isolationPrefix + customPrefix)) return true;
                    }

                    return false;
                } else {
                    // 非隔离模式
                    if (entry.comment.startsWith('ACU-[')) return false; // 避开隔离数据
                    
                    // 1. 基础前缀
                    if (basePrefixes.some(prefix => entry.comment.startsWith(prefix))) return true;

                    // 2. 已知自定义条目 (Known List) - 必须不带隔离前缀(或者说我们假设knownNames存了完整名，这里只需检查它是否不以ACU-[开头)
                    // 其实 knownNames 可能包含带隔离前缀的（如果是切模式过来的）。我们只删非隔离的。
                    if (knownNames.includes(entry.comment) && !entry.comment.startsWith('ACU-[')) return true;

                    // 3. 当前配置前缀 (Fallback)
                    for (const customPrefix of currentConfigPrefixes) {
                        if (entry.comment.startsWith(customPrefix)) return true;
                    }

                    return false;
                }
            })
            .map(entry => entry.uid);

        if (uidsToDelete.length > 0) {
            await gwDeleteLorebookEntries_ACU(primaryLorebookName, uidsToDelete);
            logDebug_ACU(`Successfully deleted ${uidsToDelete.length} generated database entries for new chat.`);
            
            // [新增] 清理 knownCustomEntryNames 中属于当前隔离环境的记录
            // 因为我们已经把它们删了。
            // 注意：如果是“新聊天”，我们其实是重置。
            if (settings_ACU.knownCustomEntryNames) {
                if (settings_ACU.dataIsolationEnabled) {
                    settings_ACU.knownCustomEntryNames = settings_ACU.knownCustomEntryNames.filter((n: string) => !n.startsWith(isolationPrefix));
                } else {
                    settings_ACU.knownCustomEntryNames = settings_ACU.knownCustomEntryNames.filter((n: string) => n.startsWith('ACU-[')); // 只保留隔离的
                }
                saveSettings_ACU();
            }
        }
    } catch(error) {
        logError_ACU('Failed to delete generated lorebook entries:', error);
    }
  }


export   async function refreshMergedDataAndNotify_ACU() {
      // 重新加载聊天记录
    await loadAllChatMessages_ACU();

    // SQL 模式必须以 Storage Provider 为当前数据源。
    // 直接 merge 后写 currentJsonTableData_ACU 会绕过 SQLite 内存库，导致提示词看到的 JSON
    // 与后续 SQL applyEdits 操作的数据库不是同一份状态。
    if (isSqliteMode()) {
        try {
            await reloadStorageProvider();
            const providerData = getStorageProvider().getCurrentData();
            if (providerData) {
                logDebug_ACU('[Refresh] SQLite provider data loaded and synchronized to JSON view.');
                await updateReadableLorebookEntry_ACU(true);
                logDebug_ACU('Updated worldbook entries with SQLite provider data.');
                return { mergedData: currentJsonTableData_ACU, integrityFixed: false };
            }
        } catch (e: any) {
            logError_ACU(`[Refresh] SQLite provider refresh failed: ${e?.message}`);
        }
    }
      
    // 合并数据 (使用新的独立表合并逻辑)
    let mergedData = await mergeAllIndependentTables_ACU();

    // 当回溯找不到任何表格数据时（mergedData 为 null），
    // 优先用"已保存指导表的物化结构（不展开 seedRows）"作为基底；
    // 若不存在指导表，才使用"模板结构（不展开预置数据）"。
    if (!mergedData) {
        const currentIsolationKey = getCurrentIsolationKey_ACU();
        const guide = getChatSheetGuideDataForIsolationKey_ACU(currentIsolationKey);
        if (guide && typeof guide === 'object' && Object.keys(guide).some(k => k.startsWith('sheet_'))) {
            logDebug_ACU('[回溯空数据] 无历史表格数据：使用已保存指导表物化结构（不展开 seedRows）作为基底。');
            mergedData = materializeDataFromSheetGuide_ACU(guide, { includeSeedRows: false });
            _set_currentJsonTableData_ACU(mergedData);
        } else {
            logDebug_ACU('[回溯空数据] 无历史表格数据且无指导表：使用模板结构（不展开预置数据）。');
            const templateData = parseTableTemplateJson_ACU({ stripSeedRows: true }); // 仅结构，不携带模板预置数据行
            if (templateData) {
                mergedData = templateData;
                _set_currentJsonTableData_ACU(templateData);
            } else {
                // 极端兜底：模板也解析失败，设为空对象
                _set_currentJsonTableData_ACU({ mate: { type: 'chatSheets', version: 1 } });
                logWarn_ACU('[回溯空数据] 模板解析失败，currentJsonTableData_ACU 设为最小空结构。');
            }
        }
        // UI 选择器刷新由 presentation 层调用方负责
    } else {
        // 更新内存中的数据
        // [新增] 数据完整性检查：在加载数据时为AM编码的条目自动添加auto_merged标记
        let integrityFixed = false;
        Object.keys(mergedData).forEach((sheetKey: string) => {
            if (mergedData[sheetKey] && mergedData[sheetKey].content && Array.isArray(mergedData[sheetKey].content)) {
                const table = mergedData[sheetKey];
                table.content.slice(1).forEach((row: any, idx: number) => {
                    if (row && row.length > 1 && row[1] && row[1].startsWith('AM') && row[row.length - 1] !== 'auto_merged') {
                        // 发现AM开头的条目缺少auto_merged标记，自动修复
                        row.push('auto_merged');
                        integrityFixed = true;
                        logDebug_ACU(`[数据修复] 为表格${sheetKey}的第${idx + 1}条AM开头的条目添加auto_merged标记`);
                    }
                });
            }
        });

        if (integrityFixed) {
            logDebug_ACU('数据完整性已自动修复，添加了缺失的auto_merged标记');
        }

        // [修复] 强制稳定顺序（用户手动顺序优先，否则模板顺序）
        const stableKeys = getSortedSheetKeys_ACU(mergedData);
        _set_currentJsonTableData_ACU(reorderDataBySheetKeys_ACU(mergedData, stableKeys));
        logDebug_ACU('Updated currentJsonTableData_ACU with independently merged data.');
        // UI 选择器刷新由 presentation 层调用方负责
    }
          
    // 更新世界书
    await updateReadableLorebookEntry_ACU(true);
    logDebug_ACU('Updated worldbook entries with merged data.');

    // 返回结果，UI 通知由 presentation 层调用方负责
    return { mergedData: currentJsonTableData_ACU, integrityFixed: false };
  }


export   async function loadAllChatMessages_ACU() {
    if (!coreApisAreReady_ACU || !isWorldbookApiAvailable_ACU()) return;
    try {
      const chatLen = getChatLength_ACU();
      const lastMessageId = chatLen > 0 ? chatLen - 1 : -1;
      if (lastMessageId < 0) {
        _set_allChatMessages_ACU([]);
        logDebug_ACU('No chat messages (ACU).');
        return;
      }
      const messagesFromApi = await getChatMessages_ACU(`0-${lastMessageId}`, {
        include_swipes: false,
      });
      if (messagesFromApi && messagesFromApi.length > 0) {
        _set_allChatMessages_ACU(messagesFromApi.map((msg, idx) => ({ ...msg, id: idx }))); // Add simple index for now
        logDebug_ACU(`ACU Loaded ${allChatMessages_ACU.length} messages for: ${currentChatFileIdentifier_ACU}.`);
      } else {
        _set_allChatMessages_ACU([]);
      }
    } catch (error) {
      logError_ACU('ACU获取聊天记录失败: ' + error.message);
      _set_allChatMessages_ACU([]);
    }
  }


export   async function getWorldbookNames_ACU() {
      const bookNames = await listLorebooks_ACU();
      if (Array.isArray(bookNames) && bookNames.length > 0) {
          return bookNames
              .map(name => String(typeof name === 'object' ? (name as any)?.name || '' : name || '').trim())
              .filter(Boolean);
      }
      return [];
  }


export   async function getLorebookEntriesByNames_ACU(bookNames: string[] = []) {
      let uniqueNames = [...new Set((Array.isArray(bookNames) ? bookNames : []).map((name: string) => String(name || '').trim()).filter(Boolean))];
      const entriesMap: Record<string, any[]> = {};
      const canUseTavernHelper = isWorldbookApiAvailable_ACU();
      let fallbackBooks = null;

      // [防御] 预先验证世界书是否真实存在，过滤掉不存在的名称
      // 防止 SillyTavern API 返回残留/缓存的不存在世界书名称导致报错
      try {
          const availableBooks = await listLorebooks_ACU();
          if (Array.isArray(availableBooks) && availableBooks.length > 0) {
              const filtered = uniqueNames.filter(name => {
                  if (availableBooks.includes(name)) return true;
                  logDebug_ACU(`[Worldbook] 世界书 "${name}" 不存在于可用列表中，静默跳过。`);
                  entriesMap[name] = []; // 为不存在的书返回空数组，保持接口一致
                  return false;
              });
              uniqueNames = filtered;
          }
      } catch (_e) {
          // listLorebooks_ACU 失败时降级为不过滤，让下方原有的 try-catch 兜底
      }

      if (!canUseTavernHelper) {
          fallbackBooks = await gwGetWorldBooks_ACU();
      }

      for (const name of uniqueNames) {
          try {
              let entries = [];
              if (canUseTavernHelper) {
                  entries = await gwGetLorebookEntries_ACU(name);
              } else if (Array.isArray(fallbackBooks)) {
                  const matchedBook = fallbackBooks.find((book: any) => book?.name === name);
                  entries = (matchedBook as any)?.entries || [];
              }
              entriesMap[name] = Array.isArray(entries) ? entries.map((entry: any) => ({ ...entry, book: name })) : [];
          } catch (e) {
              logWarn_ACU(`[Worldbook] 获取世界书 "${name}" 条目失败（忽略该书，继续）：`, e);
              entriesMap[name] = [];
          }
      }
      return entriesMap;
  }


export   async function getWorldBooks_ACU() {
      const bookNames = await getWorldbookNames_ACU();
      const entriesMap = await getLorebookEntriesByNames_ACU(bookNames);
      return bookNames.map((name: string) => ({
          name,
          entries: Array.isArray(entriesMap[name]) ? entriesMap[name] : [],
      }));
  }


export   function isImportTaggedLorebookEntry_ACU(entry: Record<string, any>) {
    const rawComment = String(entry?.comment || entry?.name || '').trim();
    if (!rawComment) return false;
    const normalizedComment = rawComment.replace(/^ACU-\[[^\]]+\]-/, '');
    return normalizedComment.startsWith(getImportStablePrefix_ACU());
  }


export   function getWorldbookCommentInfo_ACU(entry: Record<string, any>) {
      const rawComment = String(entry?.comment || entry?.name || '').trim();
      let normalizedComment = rawComment.replace(/^ACU-\[[^\]]+\]-/, '');
      normalizedComment = normalizedComment.replace(/^外部导入-(?:[^-]+-)?/, '');
      return { rawComment, normalizedComment };
  }


export   function getWorldbookEntryKeywords_ACU(entry: Record<string, any>) {
      const toStrArray = (v: any) => {
          if (Array.isArray(v)) return v.filter(x => typeof x === 'string' && x.trim());
          if (typeof v === 'string' && v.trim()) return [v];
          return [];
      };
      return [...new Set([...toStrArray(entry?.key), ...toStrArray(entry?.keys)])].map(k => k.toLowerCase());
  }


export   function getWorldbookEntryPlaceholderSortKey_ACU(entry: Record<string, any>) {
      const position = normalizeLorebookPosition_ACU(entry?.position, 'at_depth_as_system');
      const order = getEntryOrderNumber_ACU(entry);
      const normalizedOrder = order === null ? Number.MAX_SAFE_INTEGER : order;
      const depthValue = typeof entry?.depth === 'number' ? entry.depth : parseInt(String(entry?.depth ?? ''), 10);
      const normalizedDepth = Number.isFinite(depthValue) ? depthValue : 0;

      if (position === 'before_character_definition') {
          return { segment: 0, depthRank: 0, order: normalizedOrder };
      }
      if (position === 'after_character_definition') {
          return { segment: 1, depthRank: 0, order: normalizedOrder };
      }
      return { segment: 2, depthRank: -normalizedDepth, order: normalizedOrder };
  }


export   function compareWorldbookEntriesForPlaceholder_ACU(a: Record<string, any>, b: Record<string, any>) {
      const keyA = getWorldbookEntryPlaceholderSortKey_ACU(a);
      const keyB = getWorldbookEntryPlaceholderSortKey_ACU(b);

      if (keyA.segment !== keyB.segment) return keyA.segment - keyB.segment;
      if (keyA.depthRank !== keyB.depthRank) return keyA.depthRank - keyB.depthRank;
      if (keyA.order !== keyB.order) return keyA.order - keyB.order;

      const originalIndexA = Number.isFinite(a?._acuPlaceholderOriginalIndex) ? a._acuPlaceholderOriginalIndex : Number.MAX_SAFE_INTEGER;
      const originalIndexB = Number.isFinite(b?._acuPlaceholderOriginalIndex) ? b._acuPlaceholderOriginalIndex : Number.MAX_SAFE_INTEGER;
      if (originalIndexA !== originalIndexB) return originalIndexA - originalIndexB;

      const bookNameA = String(a?.bookName || '');
      const bookNameB = String(b?.bookName || '');
      if (bookNameA !== bookNameB) return bookNameA.localeCompare(bookNameB, 'zh-Hans-CN');

      const uidA = String(a?.uid ?? '');
      const uidB = String(b?.uid ?? '');
      return uidA.localeCompare(uidB, 'zh-Hans-CN');
  }


export   async function buildCombinedWorldbookContentByStrategy_ACU(options: any = {}) {
      const logPrefix = String(options?.logPrefix || '[Worldbook]');
      const bookNames: string[] = [...new Set<string>((Array.isArray(options?.bookNames) ? options.bookNames : []).map((name: any) => String(name || '').trim()).filter(Boolean))];
      const includeEntry = typeof options?.includeEntry === 'function' ? options.includeEntry : () => true;
      const isSelected = typeof options?.isSelected === 'function' ? options.isSelected : () => true;
      const excludeDisabledEntries = options?.excludeDisabledEntries !== false;
      const includeConstantEntriesInBaseScan = options?.includeConstantEntriesInBaseScan === true;
      const formatEntry = typeof options?.formatEntry === 'function'
          ? options.formatEntry
          : ((entry: any) => `# ${entry.comment || `Entry from ${entry.bookName}`}\n${entry.content}`);
      const sortEntries = typeof options?.sortEntries === 'function' ? options.sortEntries : compareWorldbookEntriesForPlaceholder_ACU;

      if (bookNames.length === 0) {
          logWarn_ACU(`${logPrefix} 没有找到任何世界书，内容将为空`);
          return '';
      }

      const entriesMap: any = await getLorebookEntriesByNames_ACU(bookNames);
      let allEntries: any[] = [];
      let placeholderOriginalIndex = 0;
      for (const bookName of bookNames) {
          const bookEntries = Array.isArray(entriesMap[bookName]) ? entriesMap[bookName] : [];
          logDebug_ACU(`${logPrefix} 世界书 "${bookName}" 条目数量:`, bookEntries.length);
          bookEntries.forEach(entry => {
              const { rawComment, normalizedComment } = getWorldbookCommentInfo_ACU(entry);
              const decoratedEntry = {
                  ...entry,
                  bookName,
                  rawComment,
                  normalizedComment,
                  _acuPlaceholderOriginalIndex: placeholderOriginalIndex++,
              };
              if (includeEntry(decoratedEntry) === false) return;
              allEntries.push(decoratedEntry);
          });
      }

      if (typeof options?.onEntriesFiltered === 'function') {
          try { options.onEntriesFiltered(allEntries); } catch (e) {}
      }
      if (allEntries.length === 0) {
          logDebug_ACU(`${logPrefix} 所选世界书在过滤后无可用条目。`);
          return '';
      }

      let userEnabledEntries = allEntries.filter(entry => (excludeDisabledEntries ? !!entry.enabled : true));
      userEnabledEntries = userEnabledEntries.filter(entry => isSelected(entry) !== false);
      if (typeof options?.onSelectedEntries === 'function') {
          try { options.onSelectedEntries(userEnabledEntries); } catch (e) {}
      }
      if (userEnabledEntries.length === 0) {
          logDebug_ACU(`${logPrefix} 当前配置下没有启用的世界书条目。`);
          return '';
      }

      let baseScanText = '';
      if (typeof options?.baseScanText === 'string' && options.baseScanText.trim()) {
          baseScanText = options.baseScanText;
      } else if (typeof options?.fallbackScanText === 'string' && options.fallbackScanText.trim()) {
          baseScanText = options.fallbackScanText;
      }
      baseScanText = baseScanText.toLowerCase();

      const constantEntries = userEnabledEntries.filter(entry => entry.type === 'constant');
      let keywordEntries = userEnabledEntries.filter(entry => entry.type !== 'constant');

      if (includeConstantEntriesInBaseScan) {
          const constantBaseText = constantEntries
              .filter(entry => !entry.prevent_recursion)
              .map(entry => entry.content || '')
              .join('\n')
              .toLowerCase();
          if (constantBaseText) {
              baseScanText = [baseScanText, constantBaseText].filter(Boolean).join('\n');
          }
      }

      const triggeredEntries = new Set([...constantEntries]);
      let recursionDepth = 0;
      const MAX_RECURSION_DEPTH = 10;

      while (recursionDepth < MAX_RECURSION_DEPTH) {
          recursionDepth++;
          let hasChangedInThisPass = false;

          const recursionSourceContent = Array.from(triggeredEntries)
              .filter(entry => !entry.prevent_recursion)
              .map(entry => entry.content)
              .join('\n')
              .toLowerCase();
          const fullSearchText = `${baseScanText}\n${recursionSourceContent}`;

          const remainingKeywordEntries = [];
          for (const entry of keywordEntries) {
              const keywords = getWorldbookEntryKeywords_ACU(entry);
              const isTriggered = keywords.length > 0 && keywords.some(keyword =>
                  entry.exclude_recursion ? baseScanText.includes(keyword) : fullSearchText.includes(keyword)
              );

              if (isTriggered) {
                  triggeredEntries.add(entry);
                  hasChangedInThisPass = true;
              } else {
                  remainingKeywordEntries.push(entry);
              }
          }

          if (!hasChangedInThisPass) {
              logDebug_ACU(`${logPrefix} Worldbook recursion stabilized after ${recursionDepth} passes.`);
              break;
          }

          keywordEntries = remainingKeywordEntries;
      }

      if (recursionDepth >= MAX_RECURSION_DEPTH) {
          logWarn_ACU(`${logPrefix} Worldbook recursion reached max depth of ${MAX_RECURSION_DEPTH}. Breaking loop.`);
      }

      let finalEntries = Array.from(triggeredEntries);
      if (sortEntries) {
          finalEntries = finalEntries.sort(sortEntries);
      }

      const finalContent = finalEntries
          .map(entry => formatEntry(entry))
          .filter(chunk => typeof chunk === 'string' && chunk.trim());

      if (finalContent.length === 0) {
          logDebug_ACU(`${logPrefix} No worldbook entries were ultimately triggered.`);
          return '';
      }

      const combinedContent = finalContent.join('\n\n').trim();
      logDebug_ACU(`${logPrefix} Combined worldbook content generated, length: ${combinedContent.length}. ${finalEntries.length} entries triggered.`);
      return combinedContent;
  }


export   async function getCombinedWorldbookContent_ACU(initialScanTextOverride = '', options: any = {}) {
    logDebug_ACU('Starting to get combined worldbook content with advanced logic...');
    const worldbookConfig = getCurrentWorldbookConfig_ACU();
    const excludeImportTaggedEntries = options?.excludeImportTaggedEntries === true;

    if (!isWorldbookApiAvailable_ACU()) {
        logWarn_ACU('[ACU] Worldbook API not available, cannot get worldbook content.');
        return '';
    }

    try {
        let bookNames = [];
        
        if (worldbookConfig.source === 'manual') {
            bookNames = worldbookConfig.manualSelection || [];
        } else { // 'character' mode
            try {
                const charLorebooks = await getCharLorebooks_ACU({ type: 'all' });
                if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
                if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
            } catch (e) {
                logError_ACU('[Worldbook] 获取角色世界书失败:', e);
                return '';
            }
        }

        const enabledEntriesMap = worldbookConfig?.enabledEntries;
        const hasAnySelection = enabledEntriesMap && typeof enabledEntriesMap === 'object' && Object.keys(enabledEntriesMap).length > 0;
        return await buildCombinedWorldbookContentByStrategy_ACU({
            logPrefix: '[Worldbook]',
            bookNames,
            baseScanText: (typeof initialScanTextOverride === 'string' && initialScanTextOverride.trim()) ? initialScanTextOverride : '',
            fallbackScanText: allChatMessages_ACU.map(message => message.message).join('\n'),
            includeEntry: (entry: any) => {
                const comment = entry.comment || '';
                if (comment.startsWith('TavernDB-ACU-')) return false;
                if (comment.startsWith('重要人物条目')) return false;
                if (comment.startsWith('总结条目')) return false;
                if (excludeImportTaggedEntries && isImportTaggedLorebookEntry_ACU(entry)) return false;
                if (isEntryBlocked_ACU(entry)) return false;
                return true;
            },
            isSelected: (entry: any) => {
                if (!hasAnySelection) return true;
                const list = enabledEntriesMap?.[entry.bookName];
                if (typeof list === 'undefined') return true;
                if (!Array.isArray(list)) return true;
                return list.includes(entry.uid);
            },
            onEntriesFiltered: (entries: any[]) => {
                if (excludeImportTaggedEntries) {
                    logDebug_ACU(`[Worldbook][Import] Import prompt exclusion enabled. Remaining entries after excluding import-tagged lorebook items: ${entries.length}`);
                }
            },
        });

    } catch (error) {
        logError_ACU(`[ACU] An error occurred while processing worldbook logic:`, error);
        return ''; // Return empty string on error to prevent breaking the generation.
    }
  }
