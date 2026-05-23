/**
 * presentation/bootstrap/api-groups/table-crud-api.ts
 * 表格 CRUD API — updateCell / updateRow / insertRow / deleteRow
 */

import { topLevelWindow_ACU } from '../../../shared/env';
import { isSummaryOrOutlineTable_ACU, logDebug_ACU, logError_ACU, logWarn_ACU } from '../../../shared/utils';
import { SillyTavern_API_ACU, type ACUMessage } from '../../../shared/host-api';
import {
    currentJsonTableData_ACU,
    settings_ACU,
    getCurrentIsolationKey_ACU,
} from '../../../service/runtime/state-manager';
import { saveIndependentTableToChatHistory_ACU } from '../../../service/table/table-service';
import { saveCurrentDataForTable_ACU } from '../../triggers/update-process';
import { refreshMergedDataAndNotifyWithUI_ACU } from '../../components/pipeline-ui-helpers';
import type { ApiGroupContext } from './callback-api';
import { isSqliteMode } from '../../../service/table/storage-mode';
import { getStorageProvider } from '../../../service/table/table-storage-strategy';
import { getNameMapper } from '../../../service/runtime/template-vars/name-mapper';
import { parseDDLTableName } from '../../../shared/ddl-utils';
import { resolveTableHistoryStateFromChat_ACU } from '../../../service/table/table-history';
import { enqueueSummaryVectorIndexFlush_ACU } from '../../../service/vector/summary-vector-index-flush-queue';
import { getCurrentWorldbookConfig_ACU } from '../../../service/settings/settings-readers';

/**
 * 从 sheet 解析英文物理表名
 * 优先从 DDL 解析，fallback 为传入的 tableName 或 sheet.name
 */
function getEnglishTableName(sheet: any, fallback: string): string {
    const ddl = sheet?.sourceData?.ddl;
    if (ddl) {
        const parsed = parseDDLTableName(ddl);
        if (parsed) return parsed;
    }
    return fallback;
}

/**
 * 查找指定表格的目标 sheet 和 sheetKey
 * 支持中文显示名、英文物理表名、中英混用
 * 返回值包含英文物理表名（用于 SQL 拼接）
 */
export function findTargetSheet(
    tableName: string,
): { sheet: any; sheetKey: string; englishTableName: string } | null {
    if (!currentJsonTableData_ACU) return null;

    // 路径 1：按 sheet.name（中文显示名）直接匹配
    for (const sheetKey in currentJsonTableData_ACU) {
        if (!sheetKey.startsWith('sheet_')) continue;
        const sheet = currentJsonTableData_ACU[sheetKey];
        if (sheet?.name === tableName) {
            return {
                sheet,
                sheetKey,
                englishTableName: getEnglishTableName(sheet, tableName),
            };
        }
    }

    // 路径 2：用户传的可能是英文物理表名——通过 NameMapper 反查对应的中文名
    const mapper = getNameMapper();
    const maybeChineseName = mapper.getChineseTableName(tableName);
    if (maybeChineseName && maybeChineseName !== tableName) {
        for (const sheetKey in currentJsonTableData_ACU) {
            if (!sheetKey.startsWith('sheet_')) continue;
            const sheet = currentJsonTableData_ACU[sheetKey];
            if (sheet?.name === maybeChineseName) {
                return {
                    sheet,
                    sheetKey,
                    englishTableName: getEnglishTableName(sheet, tableName),
                };
            }
        }
    }

    // 路径 3：直接从 DDL 的英文表名匹配（兜底，覆盖 NameMapper 未构建的场景）
    for (const sheetKey in currentJsonTableData_ACU) {
        if (!sheetKey.startsWith('sheet_')) continue;
        const sheet = currentJsonTableData_ACU[sheetKey];
        const english = getEnglishTableName(sheet, '');
        if (english && english === tableName) {
            return {
                sheet,
                sheetKey,
                englishTableName: english,
            };
        }
    }

    return null;
}

/**
 * 将用户传入的列名（可能是中文、英文、或数字索引得来的中文）
 * 翻译成英文列名（供 SQL 拼接）和中文列名（供原生模式 headers 匹配）
 *
 * 原生模式下 NameMapper 未构建，resolve* 方法会原样返回——
 * 此时 englishColName === chineseColName === 原始 colName，行为与旧版一致。
 */
function resolveColumnForSheet(
    englishTableName: string,
    colName: string,
): { englishColName: string; chineseColName: string } {
    const mapper = getNameMapper();
    const englishColName = mapper.resolveColumnName(englishTableName, colName);
    const chineseColName = mapper.getChineseColumnName(englishTableName, englishColName);
    return { englishColName, chineseColName };
}

function toSqlValueParam_ACU(value: any): string | number | null {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'boolean') return value ? 1 : 0;
    return String(value);
}

function isPlainObjectArg_ACU(value: any): value is Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstDefined_ACU<T = any>(...values: T[]): T | undefined {
    for (const value of values) {
        if (value !== undefined) return value;
    }
    return undefined;
}

function normalizeRowIndexArg_ACU(value: any, methodName: string): number | null {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue) || !Number.isInteger(numericValue)) {
        logError_ACU(`${methodName}: Invalid rowIndex "${String(value)}". rowIndex must be an integer, where 1 is the first data row.`);
        return null;
    }
    return numericValue;
}

function normalizeTableNameArg_ACU(value: any, methodName: string): string | null {
    const tableName = String(value ?? '').trim();
    if (!tableName) {
        logError_ACU(`${methodName}: tableName is required.`);
        return null;
    }
    return tableName;
}

type TableCrudMutationOptions_ACU = {
    skipChatSave: boolean;
    skipNotify: boolean;
};

type ParsedUpdateCellArgs_ACU = TableCrudMutationOptions_ACU & {
    tableName: string;
    rowIndex: number;
    colIdentifier: string | number;
    value: any;
};

type ParsedUpdateRowArgs_ACU = TableCrudMutationOptions_ACU & {
    tableName: string;
    rowIndex: number;
    data: Record<string, any>;
};

type ParsedInsertRowArgs_ACU = TableCrudMutationOptions_ACU & {
    tableName: string;
    data: Record<string, any>;
};

type ParsedDeleteRowArgs_ACU = TableCrudMutationOptions_ACU & {
    tableName: string;
    rowIndex: number;
};

function toBooleanOption_ACU(value: any): boolean {
    if (value === true) return true;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized === 'true' || normalized === '1' || normalized === 'yes';
    }
    return value === 1;
}

function parseMutationOptions_ACU(options: Record<string, any> | null, rowData?: Record<string, any> | null): TableCrudMutationOptions_ACU {
    const skipChatSave = toBooleanOption_ACU(firstDefined_ACU(
        options?.skipChatSave,
        options?.skipSave,
        options?.isImportMode,
        rowData?.isImportMode,
    ));
    const skipNotify = toBooleanOption_ACU(firstDefined_ACU(
        options?.skipNotify,
        options?.silent,
        options?.isSilent,
        options?.suppressNotify,
        options?.suppressNotification,
        rowData?.skipNotify,
        rowData?.silent,
    ));
    return { skipChatSave, skipNotify };
}

function parseUpdateCellArgs_ACU(
    tableNameOrOptions: any,
    rowIndex?: any,
    colIdentifier?: any,
    value?: any,
): ParsedUpdateCellArgs_ACU | null {
    const options = isPlainObjectArg_ACU(tableNameOrOptions) ? tableNameOrOptions : null;
    const tableName = normalizeTableNameArg_ACU(
        options ? firstDefined_ACU(options.tableName, options.table, options.sheetName, options.name) : tableNameOrOptions,
        'updateCell',
    );
    const normalizedRowIndex = normalizeRowIndexArg_ACU(
        options ? firstDefined_ACU(options.rowIndex, options.row, options.index) : rowIndex,
        'updateCell',
    );
    const rawColIdentifier = options ? firstDefined_ACU(options.colIdentifier, options.column, options.colName, options.colIndex, options.columnIndex) : colIdentifier;
    if (rawColIdentifier === undefined || rawColIdentifier === null || rawColIdentifier === '') {
        logError_ACU('updateCell: colIdentifier is required.');
        return null;
    }
    if (!tableName || normalizedRowIndex === null) return null;
    return {
        tableName,
        rowIndex: normalizedRowIndex,
        colIdentifier: rawColIdentifier,
        value: options ? options.value : value,
        ...parseMutationOptions_ACU(options),
    };
}

function parseUpdateRowArgs_ACU(
    tableNameOrOptions: any,
    rowIndex?: any,
    data?: any,
): ParsedUpdateRowArgs_ACU | null {
    const options = isPlainObjectArg_ACU(tableNameOrOptions) ? tableNameOrOptions : null;
    const tableName = normalizeTableNameArg_ACU(
        options ? firstDefined_ACU(options.tableName, options.table, options.sheetName, options.name) : tableNameOrOptions,
        'updateRow',
    );
    const normalizedRowIndex = normalizeRowIndexArg_ACU(
        options ? firstDefined_ACU(options.rowIndex, options.row, options.index) : rowIndex,
        'updateRow',
    );
    const rowData = options ? firstDefined_ACU(options.data, options.values, options.rowData) : data;
    if (!isPlainObjectArg_ACU(rowData)) {
        logError_ACU('updateRow: data must be an object.');
        return null;
    }
    if (!tableName || normalizedRowIndex === null) return null;
    return {
        tableName,
        rowIndex: normalizedRowIndex,
        data: rowData,
        ...parseMutationOptions_ACU(options, rowData),
    };
}

function parseInsertRowArgs_ACU(
    tableNameOrOptions: any,
    data?: any,
): ParsedInsertRowArgs_ACU | null {
    const options = isPlainObjectArg_ACU(tableNameOrOptions) ? tableNameOrOptions : null;
    const tableName = normalizeTableNameArg_ACU(
        options ? firstDefined_ACU(options.tableName, options.table, options.sheetName, options.name) : tableNameOrOptions,
        'insertRow',
    );
    const rowData = options ? firstDefined_ACU(options.data, options.values, options.rowData) : data;
    if (!isPlainObjectArg_ACU(rowData)) {
        logError_ACU('insertRow: data must be an object.');
        return null;
    }
    if (!tableName) return null;
    return {
        tableName,
        data: rowData,
        ...parseMutationOptions_ACU(options, rowData),
    };
}

function parseDeleteRowArgs_ACU(
    tableNameOrOptions: any,
    rowIndex?: any,
): ParsedDeleteRowArgs_ACU | null {
    const options = isPlainObjectArg_ACU(tableNameOrOptions) ? tableNameOrOptions : null;
    const tableName = normalizeTableNameArg_ACU(
        options ? firstDefined_ACU(options.tableName, options.table, options.sheetName, options.name) : tableNameOrOptions,
        'deleteRow',
    );
    const normalizedRowIndex = normalizeRowIndexArg_ACU(
        options ? firstDefined_ACU(options.rowIndex, options.row, options.index) : rowIndex,
        'deleteRow',
    );
    if (!tableName || normalizedRowIndex === null) return null;
    return {
        tableName,
        rowIndex: normalizedRowIndex,
        ...parseMutationOptions_ACU(options),
    };
}

function cloneCurrentTableDataForPersist_ACU(): any | null {
    return currentJsonTableData_ACU ? JSON.parse(JSON.stringify(currentJsonTableData_ACU)) : null;
}

function assertSqlMutationChanged_ACU(
    methodName: string,
    actionLabel: string,
    result: { changes: number; errors: string[] },
): boolean {
    if (result.errors.length > 0) {
        logError_ACU(`${methodName} SQL failed: ${result.errors.join(', ')}`);
        return false;
    }
    if (result.changes <= 0) {
        logWarn_ACU(`${methodName}: SQL executed but affected 0 rows. action=${actionLabel}`);
        return false;
    }
    return true;
}

/**
 * 查找指定表格数据所在的最新聊天楼层索引
 * 复用逻辑：updateRow / insertRow / deleteRow 共享此函数
 */
function findTableLatestFloor(targetSheetKey: string, tableName: string): number {
    const chat = SillyTavern_API_ACU.chat;
    if (!chat || chat.length === 0) return -1;
    const history = resolveTableHistoryStateFromChat_ACU(chat as ACUMessage[], {
        sheetKey: targetSheetKey,
        isSummaryTable: isSummaryOrOutlineTable_ACU(tableName),
        isolationKey: getCurrentIsolationKey_ACU(),
        settings: settings_ACU,
    });
    if (history.latestDataMessageIndex !== -1) return history.latestDataMessageIndex;
    return history.latestAiMessageIndex;
}

async function syncSummaryVectorIndexAfterTableEdit_ACU(
    tableName: string,
    methodName: string,
    tableLatestFloorIndex: number,
    skipSync?: boolean,
): Promise<void> {
    if (skipSync) {
        logDebug_ACU(`${methodName}: Skip summary vector index sync for [${tableName}] because this edit is marked as batch/import mode.`);
        return;
    }
    if (!isSummaryOrOutlineTable_ACU(tableName)) return;
    if (getCurrentWorldbookConfig_ACU().summaryVectorIndexModeEnabled !== true) return;

    const chat = SillyTavern_API_ACU.chat as ACUMessage[];
    const preferredTargetIndex = tableLatestFloorIndex >= 0 && chat?.[tableLatestFloorIndex] && !chat[tableLatestFloorIndex].is_user
        ? tableLatestFloorIndex
        : undefined;

    try {
        const result = await enqueueSummaryVectorIndexFlush_ACU({
            targetMessageIndex: preferredTargetIndex,
            mode: 'sync',
            reason: methodName,
        });
        if (!result.queued && !result.skipped) {
            logWarn_ACU(`${methodName}: Summary vector index flush enqueue failed after editing [${tableName}]. reason=${result.reason || 'unknown'}`);
        } else {
            logDebug_ACU(`${methodName}: Summary vector index flush queued after editing [${tableName}]. queued=${result.queued}, reason=${result.reason || 'ok'}`);
        }
    } catch (error) {
        logError_ACU(`${methodName}: Summary vector index flush enqueue threw after editing [${tableName}].`, error);
    }
}

/**
 * 保存表格到最新楼层并刷新世界书（updateCell / updateRow / insertRow / deleteRow 共享）
 */
async function saveToLatestFloorAndRefresh(
    targetSheetKey: string,
    tableName: string,
    ctx: ApiGroupContext,
    methodName: string,
    options: TableCrudMutationOptions_ACU = { skipChatSave: false, skipNotify: false },
    beforeData: any | null = null,
): Promise<void> {
    const tableLatestFloorIndex = findTableLatestFloor(targetSheetKey, tableName);
    let didNotifyThroughRefresh = false;

    if (tableLatestFloorIndex !== -1) {
        if (!options.skipChatSave) {
            logDebug_ACU(`${methodName}: Saving [${tableName}] to its latest floor ${tableLatestFloorIndex}`);
            const chat = SillyTavern_API_ACU.chat as ACUMessage[];
            const history = resolveTableHistoryStateFromChat_ACU(chat, {
                sheetKey: targetSheetKey,
                isSummaryTable: isSummaryOrOutlineTable_ACU(tableName),
                isolationKey: getCurrentIsolationKey_ACU(),
                settings: settings_ACU,
            });
            const shouldTrackAsUpdate = history.latestDataMessageIndex === -1;
            await saveIndependentTableToChatHistory_ACU({
                targetMessageIndex: tableLatestFloorIndex,
                targetSheetKeys: [targetSheetKey],
                updateGroupKeys: shouldTrackAsUpdate ? [targetSheetKey] : null,
                beforeData,
                afterData: cloneCurrentTableDataForPersist_ACU(),
                trackAsUpdate: true,
            });
        }
        await refreshMergedDataAndNotifyWithUI_ACU({ skipNotify: options.skipNotify });
        didNotifyThroughRefresh = !options.skipNotify;
        logDebug_ACU(`${methodName}: Worldbook refreshed after saving [${tableName}]`);
    } else {
        logDebug_ACU(`${methodName}: No AI floor found, falling back to saveCurrentDataForTable_ACU`);
        await saveCurrentDataForTable_ACU(targetSheetKey);
    }

    await syncSummaryVectorIndexAfterTableEdit_ACU(tableName, methodName, tableLatestFloorIndex, options.skipChatSave);
    if (!options.skipNotify && !didNotifyThroughRefresh) {
        (topLevelWindow_ACU as any).AutoCardUpdaterAPI._notifyTableUpdate();
    } else if (options.skipNotify) {
        logDebug_ACU(`${methodName}: Skip table update notification for [${tableName}] because this edit is marked as silent.`);
    }
}

export function createTableCrudApi(ctx: ApiGroupContext): Record<string, Function> {
    return {
        updateCell: async function(tableNameOrOptions: any, rowIndex?: any, colIdentifier?: any, value?: any) {
            try {
                if (!currentJsonTableData_ACU) {
                    logError_ACU('updateCell: No table data loaded.');
                    return false;
                }

                const args = parseUpdateCellArgs_ACU(tableNameOrOptions, rowIndex, colIdentifier, value);
                if (!args) return false;
                const {
                    tableName,
                    rowIndex: normalizedRowIndex,
                    colIdentifier: normalizedColIdentifier,
                    value: normalizedValue,
                    skipChatSave,
                    skipNotify,
                } = args;

                const target = findTargetSheet(tableName);
                if (!target) {
                    logError_ACU(`updateCell: Table "${tableName}" not found.`);
                    return false;
                }

                const { sheet: targetSheet, sheetKey: targetSheetKey, englishTableName } = target;

                if (!targetSheet.content || targetSheet.content.length === 0) {
                    logError_ACU(`updateCell: Table "${tableName}" has no content.`);
                    return false;
                }

                // 解析列名：先拿到一个「原始列名」（来自用户输入或表头索引）
                const numericColIdentifier = typeof normalizedColIdentifier === 'number'
                    ? normalizedColIdentifier
                    : (String(normalizedColIdentifier).trim() !== '' && Number.isInteger(Number(normalizedColIdentifier)) ? Number(normalizedColIdentifier) : null);
                let rawColName: string;
                if (numericColIdentifier !== null) {
                    const headers = targetSheet.content[0] || [];
                    if (numericColIdentifier < 0 || numericColIdentifier >= headers.length) {
                        logError_ACU(`updateCell: Column index ${numericColIdentifier} out of bounds in table "${tableName}".`);
                        return false;
                    }
                    rawColName = headers[numericColIdentifier]; // 中文
                } else {
                    rawColName = String(normalizedColIdentifier); // 可能中文也可能英文
                }

                // 统一翻译为英文+中文双形态
                const { englishColName, chineseColName } = resolveColumnForSheet(englishTableName, rawColName);

                // 校验列名：用中文形态和 headers 比对（headers 是中文），
                // 这样用户传英文列名也能通过校验
                if (numericColIdentifier === null) {
                    const headers = targetSheet.content[0] || [];
                    if (!headers.includes(chineseColName)) {
                        logError_ACU(`updateCell: Column "${normalizedColIdentifier}" not found in table "${tableName}".`);
                        return false;
                    }
                }

                if (normalizedRowIndex < 1 || normalizedRowIndex >= targetSheet.content.length) {
                    logError_ACU(`updateCell: Row index ${normalizedRowIndex} out of bounds in table "${tableName}".`);
                    return false;
                }

                const beforeData = cloneCurrentTableDataForPersist_ACU();

                if (isSqliteMode()) {
                    // SQLite 模式：用英文物理表名和英文列名生成 UPDATE SQL；值统一走参数绑定，避免 row_id/单元格值字符串破坏 SQL。
                    const rowId = targetSheet.content[normalizedRowIndex][0]; // row_id 是第一列
                    if (rowId === undefined || rowId === null) {
                        logError_ACU(`updateCell: row_id not found at index ${normalizedRowIndex}`);
                        return false;
                    }
                    const sql = `UPDATE ${quoteIdentifier(englishTableName)} SET ${quoteIdentifier(englishColName)} = ? WHERE ${quoteIdentifier('row_id')} = ?;`;
                    const result = getStorageProvider().executeMutation(sql, [
                        toSqlValueParam_ACU(normalizedValue),
                        toSqlValueParam_ACU(rowId),
                    ]);
                    if (!assertSqlMutationChanged_ACU('updateCell', `table=${englishTableName}, row_id=${rowId}, col=${englishColName}`, result)) {
                        return false;
                    }
                    logDebug_ACU(`updateCell: [SQLite] Updated [${englishTableName}] row_id=${rowId}, col=${englishColName}`);
                } else {
                    // 原生模式：直接操作 JSON 数组，用中文列名在 headers 中定位
                    let colIndex = -1;
                    if (numericColIdentifier !== null) {
                        colIndex = numericColIdentifier;
                    } else {
                        const headers = targetSheet.content[0] || [];
                        colIndex = headers.indexOf(chineseColName);
                    }
                    if (colIndex < 0) {
                        logError_ACU(`updateCell: Column "${normalizedColIdentifier}" not found in table "${tableName}".`);
                        return false;
                    }
                    targetSheet.content[normalizedRowIndex][colIndex] = normalizedValue;
                    logDebug_ACU(`updateCell: Updated [${tableName}] row ${normalizedRowIndex}, col ${normalizedColIdentifier} = ${normalizedValue}`);
                }

                await saveToLatestFloorAndRefresh(targetSheetKey, targetSheet.name, ctx, 'updateCell', { skipChatSave, skipNotify }, beforeData);

                return true;
            } catch (e) {
                logError_ACU('updateCell failed:', e);
                return false;
            }
        },

        updateRow: async function(tableNameOrOptions: any, rowIndex?: any, data?: any) {
            try {
                if (!currentJsonTableData_ACU) {
                    logError_ACU('updateRow: No table data loaded.');
                    return false;
                }

                const args = parseUpdateRowArgs_ACU(tableNameOrOptions, rowIndex, data);
                if (!args) return false;
                const {
                    tableName,
                    rowIndex: normalizedRowIndex,
                    data: normalizedData,
                    skipChatSave,
                    skipNotify,
                } = args;

                if (normalizedRowIndex < 1) {
                    logError_ACU('updateRow: Cannot modify header row (index 0).');
                    return false;
                }

                const target = findTargetSheet(tableName);
                if (!target) {
                    logError_ACU(`updateRow: Table "${tableName}" not found.`);
                    return false;
                }

                const { sheet: targetSheet, sheetKey: targetSheetKey, englishTableName } = target;

                const beforeData = cloneCurrentTableDataForPersist_ACU();

                if (isSqliteMode()) {
                    // SQLite 模式：用英文物理表名和英文列名生成 UPDATE SQL
                    const rowId = targetSheet.content[normalizedRowIndex]?.[0];
                    if (rowId === undefined || rowId === null) {
                        logError_ACU(`updateRow: row_id not found at index ${normalizedRowIndex}`);
                        return false;
                    }
                    const setClauses: string[] = [];
                    const params: (string | number | null)[] = [];
                    const headers = targetSheet.content[0] || [];
                    for (const colName in normalizedData) {
                        if (colName === 'isImportMode') continue; // 跳过内部标记
                        const { englishColName, chineseColName } = resolveColumnForSheet(englishTableName, colName);
                        if (!headers.includes(chineseColName)) {
                            logWarn_ACU(`updateRow: Column "${colName}" not found in table "${tableName}".`);
                            continue;
                        }
                        setClauses.push(`${quoteIdentifier(englishColName)} = ?`);
                        params.push(toSqlValueParam_ACU(normalizedData[colName]));
                    }
                    if (setClauses.length === 0) {
                        logWarn_ACU('updateRow: No valid columns to update.');
                        return false;
                    }
                    params.push(toSqlValueParam_ACU(rowId));
                    const sql = `UPDATE ${quoteIdentifier(englishTableName)} SET ${setClauses.join(', ')} WHERE ${quoteIdentifier('row_id')} = ?;`;
                    const result = getStorageProvider().executeMutation(sql, params);
                    if (!assertSqlMutationChanged_ACU('updateRow', `table=${englishTableName}, row_id=${rowId}, cols=${setClauses.length}`, result)) {
                        return false;
                    }
                    logDebug_ACU(`updateRow: [SQLite] Updated ${setClauses.length} cols in [${englishTableName}] row_id=${rowId}`);
                } else {
                    // 原生模式：直接操作 JSON 数组
                    while (targetSheet.content.length <= normalizedRowIndex) {
                        const newRow = new Array((targetSheet.content[0] || []).length).fill('');
                        targetSheet.content.push(newRow);
                    }

                    const headers = targetSheet.content[0] || [];
                    const row = targetSheet.content[normalizedRowIndex];

                    let updated = 0;
                    for (const colName in normalizedData) {
                        if (colName === 'isImportMode') continue;
                        // 将用户传入的列名翻译为中文（原生模式 headers 是中文）。
                        // 原生模式下 NameMapper 未构建时 resolveColumnForSheet 原样返回，
                        // 行为与旧版一致。
                        const { chineseColName } = resolveColumnForSheet(englishTableName, colName);
                        const colIndex = headers.indexOf(chineseColName);
                        if (colIndex !== -1) {
                            row[colIndex] = normalizedData[colName];
                            updated++;
                        } else {
                            logWarn_ACU(`updateRow: Column "${colName}" not found in table "${tableName}".`);
                        }
                    }

                    if (updated === 0) {
                        logWarn_ACU(`updateRow: No valid columns updated in [${tableName}] row ${normalizedRowIndex}.`);
                        return false;
                    }
                    logDebug_ACU(`updateRow: Updated ${updated} cells in [${tableName}] row ${normalizedRowIndex}`);
                }

                await saveToLatestFloorAndRefresh(targetSheetKey, targetSheet.name, ctx, 'updateRow', { skipChatSave, skipNotify }, beforeData);

                return true;
            } catch (e) {
                logError_ACU('updateRow failed:', e);
                return false;
            }
        },

        insertRow: async function(tableNameOrOptions: any, data?: any) {
            try {
                if (!currentJsonTableData_ACU) {
                    logError_ACU('insertRow: No table data loaded.');
                    return -1;
                }

                const args = parseInsertRowArgs_ACU(tableNameOrOptions, data);
                if (!args) return -1;
                const {
                    tableName,
                    data: normalizedData,
                    skipChatSave,
                    skipNotify,
                } = args;

                const target = findTargetSheet(tableName);
                if (!target) {
                    logError_ACU(`insertRow: Table "${tableName}" not found.`);
                    return -1;
                }

                const { sheet: targetSheet, sheetKey: targetSheetKey, englishTableName } = target;
                const headers = targetSheet.content[0] || [];

                const beforeData = cloneCurrentTableDataForPersist_ACU();

                if (isSqliteMode()) {
                    // SQLite 模式：用英文物理表名和英文列名生成 INSERT SQL
                    const beforeLength = targetSheet.content.length;
                    const colNames: string[] = [];
                    const params: (string | number | null)[] = [];
                    for (const colName in normalizedData) {
                        const { englishColName, chineseColName } = resolveColumnForSheet(englishTableName, colName);
                        // 跳过 row_id（自增主键），同时检查英文形态和原始名，防止用户传中文"行号"等变体
                        if (englishColName === 'row_id' || colName === 'row_id') continue;
                        if (!headers.includes(chineseColName)) continue;
                        colNames.push(quoteIdentifier(englishColName));
                        params.push(toSqlValueParam_ACU(normalizedData[colName]));
                    }
                    const placeholders = colNames.map(() => '?').join(', ');
                    const sql = colNames.length > 0
                        ? `INSERT INTO ${quoteIdentifier(englishTableName)} (${colNames.join(', ')}) VALUES (${placeholders});`
                        : `INSERT INTO ${quoteIdentifier(englishTableName)} DEFAULT VALUES;`;
                    const result = getStorageProvider().executeMutation(sql, params);
                    if (!assertSqlMutationChanged_ACU('insertRow', `table=${englishTableName}, cols=${colNames.length}`, result)) {
                        return -1;
                    }
                    const refreshedTarget = findTargetSheet(tableName);
                    const refreshedLength = refreshedTarget?.sheet?.content?.length ?? 0;
                    if (!refreshedTarget || refreshedLength <= beforeLength) {
                        logError_ACU(`insertRow: SQLite mutation succeeded but refreshed JSON view did not contain a new row for [${tableName}].`);
                        return -1;
                    }
                    const newIndex = refreshedLength - 1;
                    logDebug_ACU(`insertRow: [SQLite] Inserted row in [${englishTableName}] at index ${newIndex}`);

                    await saveToLatestFloorAndRefresh(targetSheetKey, targetSheet.name, ctx, 'insertRow', { skipChatSave, skipNotify }, beforeData);
                    return newIndex;
                } else {
                    // 原生模式：直接操作 JSON 数组，用中文列名在 headers 中定位
                    const newRow = new Array(headers.length).fill('');

                    for (const colName in normalizedData) {
                        const { chineseColName } = resolveColumnForSheet(englishTableName, colName);
                        const colIndex = headers.indexOf(chineseColName);
                        if (colIndex !== -1) {
                            newRow[colIndex] = normalizedData[colName];
                        }
                    }

                    // 原生模式自动补 row_id：当第一列是 row_id 且调用者未提供时，
                    // 扫描现有行取最大数值 row_id + 1，确保 delta 机制不会跳过该行
                    const firstHeader = headers[0];
                    if (firstHeader === 'row_id' && (!newRow[0] || String(newRow[0]).trim() === '')) {
                        let maxId = 0;
                        for (let i = 1; i < targetSheet.content.length; i++) {
                            const num = Number(targetSheet.content[i]?.[0]);
                            if (!isNaN(num) && num > maxId) maxId = num;
                        }
                        newRow[0] = String(maxId + 1);
                    }

                    targetSheet.content.push(newRow);
                    const newIndex = targetSheet.content.length - 1;

                    logDebug_ACU(`insertRow: Inserted row at index ${newIndex} in [${tableName}]`);

                    await saveToLatestFloorAndRefresh(targetSheetKey, targetSheet.name, ctx, 'insertRow', { skipChatSave, skipNotify }, beforeData);

                    return newIndex;
                }
            } catch (e) {
                logError_ACU('insertRow failed:', e);
                return -1;
            }
        },

        deleteRow: async function(tableNameOrOptions: any, rowIndex?: any) {
            try {
                if (!currentJsonTableData_ACU) {
                    logError_ACU('deleteRow: No table data loaded.');
                    return false;
                }

                const args = parseDeleteRowArgs_ACU(tableNameOrOptions, rowIndex);
                if (!args) return false;
                const {
                    tableName,
                    rowIndex: normalizedRowIndex,
                    skipChatSave,
                    skipNotify,
                } = args;

                if (normalizedRowIndex < 1) {
                    logError_ACU('deleteRow: Cannot delete header row (index 0).');
                    return false;
                }

                const target = findTargetSheet(tableName);
                if (!target) {
                    logError_ACU(`deleteRow: Table "${tableName}" not found.`);
                    return false;
                }

                const { sheet: targetSheet, sheetKey: targetSheetKey, englishTableName } = target;

                if (normalizedRowIndex >= targetSheet.content.length) {
                    logError_ACU(`deleteRow: Row index ${normalizedRowIndex} out of bounds.`);
                    return false;
                }

                const beforeData = cloneCurrentTableDataForPersist_ACU();

                if (isSqliteMode()) {
                    // SQLite 模式：用英文物理表名生成 DELETE SQL；row_id 走参数绑定，避免字符串 row_id 删除失效。
                    const rowId = targetSheet.content[normalizedRowIndex]?.[0];
                    if (rowId === undefined || rowId === null) {
                        logError_ACU(`deleteRow: row_id not found at index ${normalizedRowIndex}`);
                        return false;
                    }
                    const sql = `DELETE FROM ${quoteIdentifier(englishTableName)} WHERE ${quoteIdentifier('row_id')} = ?;`;
                    const result = getStorageProvider().executeMutation(sql, [toSqlValueParam_ACU(rowId)]);
                    if (!assertSqlMutationChanged_ACU('deleteRow', `table=${englishTableName}, row_id=${rowId}`, result)) {
                        return false;
                    }
                    logDebug_ACU(`deleteRow: [SQLite] Deleted row_id=${rowId} from [${englishTableName}]`);
                } else {
                    // 原生模式：直接操作 JSON 数组
                    targetSheet.content.splice(normalizedRowIndex, 1);
                    logDebug_ACU(`deleteRow: Deleted row ${normalizedRowIndex} from [${tableName}]`);
                }

                await saveToLatestFloorAndRefresh(targetSheetKey, targetSheet.name, ctx, 'deleteRow', { skipChatSave, skipNotify }, beforeData);

                return true;
            } catch (e) {
                logError_ACU('deleteRow failed:', e);
                return false;
            }
        },
    };
}

/**
 * 用反引号包裹标识符（表名/列名），防止中文或特殊字符导致 SQL 语法错误
 */
export function quoteIdentifier(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
}
