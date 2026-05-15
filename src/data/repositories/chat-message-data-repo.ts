/**
 * data/repositories/chat-message-data-repo.ts — 消息级表格数据 CRUD
 *
 * 封装所有对 message.TavernDB_ACU_* 字段的底层读写操作。
 * 纯数据层：不包含业务逻辑（合并策略、优先级判断等在 service/ 层）。
 *
 * 设计决策：
 * 1. 纯函数导出（与 isolation-repo.ts、profile-repo.ts 风格一致）
 * 2. 隔离配置作为参数传入（不引用 service 层的 state-manager）
 * 3. 不包含业务逻辑（不做合并策略、不做优先级判断，只做字段级 CRUD）
 * 4. 统一处理 string/object 格式（IsolatedData 可能是 JSON 字符串）
 */

import { safeJsonParse_ACU } from '../../shared/json-helpers';
import type { Sheet_ACU } from '../../shared/models/table-data';
import { pruneTablePersistenceLayerSheetKeysV2_ACU } from '../../shared/models/table-persistence-v2-utils';
import type {
    IsolationTagData_ACU,
    IsolatedDataContainer_ACU,
    LegacyTableContainer_ACU,
    IsolationConfig_ACU,
} from '../models/chat-message-data';

// ════════════════════════════════════════════════════════════════
// 内部辅助
// ════════════════════════════════════════════════════════════════

/**
 * 将 IsolatedData 字段解析为对象（处理 string/object 两种格式）。
 * 如果字段不存在或解析失败，返回 null。
 */
function parseIsolatedDataField(msg: any): IsolatedDataContainer_ACU | null {
    const raw = msg?.TavernDB_ACU_IsolatedData;
    if (!raw) return null;
    if (typeof raw === 'string') {
        const parsed = safeJsonParse_ACU(raw, null);
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            ? parsed as IsolatedDataContainer_ACU
            : null;
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as IsolatedDataContainer_ACU;
    }
    return null;
}

/**
 * 检查对象中是否还有 sheet_ 开头的键。
 */
function hasAnySheetKey(obj: any): boolean {
    return obj && typeof obj === 'object' && Object.keys(obj).some(k => k.startsWith('sheet_'));
}

/**
 * 安全深拷贝。
 */
function safeClone<T>(obj: T): T {
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch {
        return obj;
    }
}

/**
 * 从数组中移除指定元素，返回新数组和是否发生变化。
 */
function removeFromArray(arr: string[], key: string): { result: string[]; changed: boolean } {
    if (!Array.isArray(arr) || arr.length === 0) return { result: arr || [], changed: false };
    const next = arr.filter(x => x !== key);
    return { result: next, changed: next.length !== arr.length };
}

// ════════════════════════════════════════════════════════════════
// 读取类
// ════════════════════════════════════════════════════════════════

/**
 * 从消息读取指定隔离标签的 IsolationTagData。
 * 统一处理 IsolatedData 字段的 string/object 两种格式。
 *
 * @param msg 聊天消息对象
 * @param isolationKey 隔离标签键名
 * @returns 标签数据，或 null（不存在时）
 */
export function readIsolatedTagData_ACU(msg: any, isolationKey: string): IsolationTagData_ACU | null {
    const container = parseIsolatedDataField(msg);
    if (!container) return null;
    const tagData = container[isolationKey];
    if (!tagData || typeof tagData !== 'object') return null;
    return tagData;
}

/**
 * 从消息读取旧版 IndependentData。
 *
 * @param msg 聊天消息对象
 * @returns 独立表格数据，或 null
 */
export function readLegacyIndependentData_ACU(msg: any): Record<string, Sheet_ACU> | null {
    const data = msg?.TavernDB_ACU_IndependentData;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data as Record<string, Sheet_ACU>;
}

/**
 * 从消息读取旧版 Data（标准表）。
 *
 * @param msg 聊天消息对象
 * @returns 标准表容器，或 null
 */
export function readLegacyStandardData_ACU(msg: any): LegacyTableContainer_ACU | null {
    const data = msg?.TavernDB_ACU_Data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data as LegacyTableContainer_ACU;
}

/**
 * 从消息读取旧版 SummaryData（摘要表）。
 *
 * @param msg 聊天消息对象
 * @returns 摘要表容器，或 null
 */
export function readLegacySummaryData_ACU(msg: any): LegacyTableContainer_ACU | null {
    const data = msg?.TavernDB_ACU_SummaryData;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data as LegacyTableContainer_ACU;
}

/**
 * 从消息读取 Identity 字段。
 *
 * @param msg 聊天消息对象
 * @returns 隔离标识字符串，或 undefined（未设置时）
 */
export function readMessageIdentity_ACU(msg: any): string | undefined {
    return msg?.TavernDB_ACU_Identity;
}

/**
 * 从消息读取本地消息锚点字段。
 *
 * @param msg 聊天消息对象
 * @returns 本地锚点字符串，或 undefined（未设置时）
 */
export function readLocalMessageAnchor_ACU(msg: any): string | undefined {
    const anchor = String(msg?.TavernDB_ACU_LocalMessageAnchor || '').trim();
    return anchor || undefined;
}

/**
 * 从消息读取 ModifiedKeys。
 *
 * @param msg 聊天消息对象
 * @returns 修改键列表（不存在时返回空数组）
 */
export function readModifiedKeys_ACU(msg: any): string[] {
    const keys = msg?.TavernDB_ACU_ModifiedKeys;
    return Array.isArray(keys) ? keys : [];
}

/**
 * 从消息读取 UpdateGroupKeys。
 *
 * @param msg 聊天消息对象
 * @returns 更新组键列表（不存在时返回空数组）
 */
export function readUpdateGroupKeys_ACU(msg: any): string[] {
    const keys = msg?.TavernDB_ACU_UpdateGroupKeys;
    return Array.isArray(keys) ? keys : [];
}

/**
 * 判断旧版消息是否匹配当前隔离配置。
 * 封装隔离匹配逻辑：
 * - 开启隔离：Identity === code 时匹配
 * - 关闭隔离（无标签模式）：Identity 不存在时匹配
 *
 * @param msg 聊天消息对象
 * @param isolationConfig 隔离配置
 * @returns 是否匹配
 */
export function isLegacyMatchForIsolation_ACU(msg: any, isolationConfig: IsolationConfig_ACU): boolean {
    const msgIdentity = msg?.TavernDB_ACU_Identity;
    if (isolationConfig.enabled) {
        return msgIdentity === isolationConfig.code;
    }
    return !msgIdentity;
}

// ════════════════════════════════════════════════════════════════
// 写入类
// ════════════════════════════════════════════════════════════════

/**
 * 写入指定隔离标签的数据到 IsolatedData 容器。
 * 如果容器不存在会自动创建。
 *
 * @param msg 聊天消息对象
 * @param isolationKey 隔离标签键名
 * @param tagData 要写入的标签数据
 */
export function writeIsolatedTagData_ACU(msg: any, isolationKey: string, tagData: IsolationTagData_ACU): void {
    if (!msg) return;
    if (!msg.TavernDB_ACU_IsolatedData || typeof msg.TavernDB_ACU_IsolatedData !== 'object') {
        msg.TavernDB_ACU_IsolatedData = {};
    }
    msg.TavernDB_ACU_IsolatedData[isolationKey] = tagData;
}

/**
 * 确保 IsolatedData[isolationKey] 存在（初始化空槽）。
 * 如果已存在则不覆盖。
 *
 * @param msg 聊天消息对象
 * @param isolationKey 隔离标签键名
 * @returns 该标签槽的引用
 */
export function initIsolatedTagSlot_ACU(msg: any, isolationKey: string): IsolationTagData_ACU {
    if (!msg.TavernDB_ACU_IsolatedData || typeof msg.TavernDB_ACU_IsolatedData !== 'object') {
        msg.TavernDB_ACU_IsolatedData = {};
    }
    if (!msg.TavernDB_ACU_IsolatedData[isolationKey]) {
        msg.TavernDB_ACU_IsolatedData[isolationKey] = {
            independentData: {},
            modifiedKeys: [],
            updateGroupKeys: [],
        };
    }
    return msg.TavernDB_ACU_IsolatedData[isolationKey];
}

/**
 * 同步写入旧版兼容字段（IndependentData/ModifiedKeys/UpdateGroupKeys）。
 *
 * @param msg 聊天消息对象
 * @param independentData 独立表格数据
 * @param modifiedKeys 修改键列表
 * @param updateGroupKeys 更新组键列表
 */
export function writeLegacyCompatData_ACU(
    msg: any,
    independentData: Record<string, Sheet_ACU>,
    modifiedKeys: string[],
    updateGroupKeys: string[],
): void {
    if (!msg) return;
    msg.TavernDB_ACU_IndependentData = independentData;
    msg.TavernDB_ACU_ModifiedKeys = modifiedKeys;
    msg.TavernDB_ACU_UpdateGroupKeys = updateGroupKeys;
}

/**
 * 写入旧版 Data 和 SummaryData 字段。
 *
 * @param msg 聊天消息对象
 * @param standardData 标准表数据（可选，null 则不写入）
 * @param summaryData 摘要表数据（可选，null 则不写入）
 */
export function writeLegacyStandardAndSummary_ACU(
    msg: any,
    standardData: LegacyTableContainer_ACU | null,
    summaryData: LegacyTableContainer_ACU | null,
): void {
    if (!msg) return;
    if (standardData && hasAnySheetKey(standardData)) {
        msg.TavernDB_ACU_Data = standardData;
    }
    if (summaryData && hasAnySheetKey(summaryData)) {
        msg.TavernDB_ACU_SummaryData = summaryData;
    }
}

/**
 * 根据隔离配置设置或删除 Identity 字段。
 * - 隔离启用：设置 Identity 为隔离代码
 * - 隔离关闭：删除 Identity 字段
 *
 * @param msg 聊天消息对象
 * @param isolationConfig 隔离配置
 */
export function writeMessageIdentity_ACU(msg: any, isolationConfig: IsolationConfig_ACU): void {
    if (!msg) return;
    if (isolationConfig.enabled) {
        msg.TavernDB_ACU_Identity = isolationConfig.code;
    } else {
        delete msg.TavernDB_ACU_Identity;
    }
}

/**
 * 写入或删除本地消息锚点字段。
 *
 * @param msg 聊天消息对象
 * @param anchor 本地锚点；空字符串表示删除
 */
export function writeLocalMessageAnchor_ACU(msg: any, anchor: string): void {
    if (!msg) return;
    const normalizedAnchor = String(anchor || '').trim();
    if (normalizedAnchor) {
        msg.TavernDB_ACU_LocalMessageAnchor = normalizedAnchor;
    } else {
        delete msg.TavernDB_ACU_LocalMessageAnchor;
    }
}

// ════════════════════════════════════════════════════════════════
// 删除类
// ════════════════════════════════════════════════════════════════

/**
 * 从单条消息的所有字段中删除指定 sheetKey 的数据（新版+旧版）。
 * 处理删除后空对象的清理。
 *
 * @param msg 聊天消息对象
 * @param sheetKeys 要删除的 sheetKey 列表
 * @returns 是否发生了变化
 */
export function purgeSheetKeysFromMessage_ACU(msg: any, sheetKeys: string[]): boolean {
    if (!msg || !Array.isArray(sheetKeys) || sheetKeys.length === 0) return false;

    let msgChanged = false;

    // ── 新版：按标签分组（对该消息内所有标签槽执行删除） ──
    const isolated = parseIsolatedDataField(msg);
    if (isolated) {
        const nextIsolated = safeClone(isolated);
        Object.keys(nextIsolated).forEach(tagKey => {
            const tagData = nextIsolated[tagKey];
            if (!tagData || typeof tagData !== 'object') return;

            // 删除 independentData 中的指定 sheetKey
            if (tagData.independentData && typeof tagData.independentData === 'object') {
                sheetKeys.forEach(k => {
                    if (tagData.independentData[k]) {
                        delete tagData.independentData[k];
                        msgChanged = true;
                    }
                });
            }

            // 从 modifiedKeys 中移除
            if (Array.isArray(tagData.modifiedKeys)) {
                sheetKeys.forEach(k => {
                    const r = removeFromArray(tagData.modifiedKeys, k);
                    if (r.changed) {
                        tagData.modifiedKeys = r.result;
                        msgChanged = true;
                    }
                });
            }

            // 从 updateGroupKeys 中移除
            if (Array.isArray(tagData.updateGroupKeys)) {
                sheetKeys.forEach(k => {
                    const r = removeFromArray(tagData.updateGroupKeys, k);
                    if (r.changed) {
                        tagData.updateGroupKeys = r.result;
                        msgChanged = true;
                    }
                });
            }

            // ── V2：checkpoint + delta 字段级清理 ──
            if (tagData.tablePersistenceV2 && typeof tagData.tablePersistenceV2 === 'object') {
                const pruneResult = pruneTablePersistenceLayerSheetKeysV2_ACU(
                    tagData.tablePersistenceV2,
                    sheetKeys,
                );
                if (pruneResult.changed) {
                    if (pruneResult.layer) {
                        tagData.tablePersistenceV2 = pruneResult.layer;
                    } else {
                        delete tagData.tablePersistenceV2;
                    }
                    msgChanged = true;
                }
            }
        });
        if (msgChanged) {
            msg.TavernDB_ACU_IsolatedData = nextIsolated;
        }
    }

    // ── 旧版：独立数据 ──
    if (msg.TavernDB_ACU_IndependentData && typeof msg.TavernDB_ACU_IndependentData === 'object') {
        const next = safeClone(msg.TavernDB_ACU_IndependentData);
        let indepChanged = false;
        sheetKeys.forEach(k => {
            if (next[k]) {
                delete next[k];
                indepChanged = true;
            }
        });
        if (indepChanged) {
            msgChanged = true;
            if (!hasAnySheetKey(next)) {
                const hasNonSheet = Object.keys(next).some(k => !k.startsWith('sheet_'));
                if (!hasNonSheet) {
                    delete msg.TavernDB_ACU_IndependentData;
                } else {
                    msg.TavernDB_ACU_IndependentData = next;
                }
            } else {
                msg.TavernDB_ACU_IndependentData = next;
            }
        }
    }

    // ── 旧版：ModifiedKeys / UpdateGroupKeys ──
    if (Array.isArray(msg.TavernDB_ACU_ModifiedKeys)) {
        let next = [...msg.TavernDB_ACU_ModifiedKeys];
        let any = false;
        sheetKeys.forEach(k => {
            const r = removeFromArray(next, k);
            if (r.changed) { next = r.result; any = true; }
        });
        if (any) { msg.TavernDB_ACU_ModifiedKeys = next; msgChanged = true; }
    }
    if (Array.isArray(msg.TavernDB_ACU_UpdateGroupKeys)) {
        let next = [...msg.TavernDB_ACU_UpdateGroupKeys];
        let any = false;
        sheetKeys.forEach(k => {
            const r = removeFromArray(next, k);
            if (r.changed) { next = r.result; any = true; }
        });
        if (any) { msg.TavernDB_ACU_UpdateGroupKeys = next; msgChanged = true; }
    }

    // ── 旧版：标准表 ──
    if (msg.TavernDB_ACU_Data && typeof msg.TavernDB_ACU_Data === 'object') {
        const next = safeClone(msg.TavernDB_ACU_Data);
        let dataChanged = false;
        sheetKeys.forEach(k => {
            if (next[k]) { delete next[k]; dataChanged = true; }
        });
        if (dataChanged) {
            msgChanged = true;
            if (!hasAnySheetKey(next)) {
                const hasNonSheet = Object.keys(next).some(k => !k.startsWith('sheet_'));
                if (!hasNonSheet) {
                    delete msg.TavernDB_ACU_Data;
                } else {
                    msg.TavernDB_ACU_Data = next;
                }
            } else {
                msg.TavernDB_ACU_Data = next;
            }
        }
    }

    // ── 旧版：摘要表 ──
    if (msg.TavernDB_ACU_SummaryData && typeof msg.TavernDB_ACU_SummaryData === 'object') {
        const next = safeClone(msg.TavernDB_ACU_SummaryData);
        let summaryChanged = false;
        sheetKeys.forEach(k => {
            if (next[k]) { delete next[k]; summaryChanged = true; }
        });
        if (summaryChanged) {
            msgChanged = true;
            if (!hasAnySheetKey(next)) {
                const hasNonSheet = Object.keys(next).some(k => !k.startsWith('sheet_'));
                if (!hasNonSheet) {
                    delete msg.TavernDB_ACU_SummaryData;
                } else {
                    msg.TavernDB_ACU_SummaryData = next;
                }
            } else {
                msg.TavernDB_ACU_SummaryData = next;
            }
        }
    }

    return msgChanged;
}

/**
 * 清除消息上所有 TavernDB_ACU_* 表格数据字段（用于重置）。
 *
 * @param msg 聊天消息对象
 */
export function clearAllTableFields_ACU(msg: any): void {
    if (!msg) return;
    delete msg.TavernDB_ACU_IsolatedData;
    delete msg.TavernDB_ACU_IndependentData;
    delete msg.TavernDB_ACU_Data;
    delete msg.TavernDB_ACU_SummaryData;
    delete msg.TavernDB_ACU_Identity;
    delete msg.TavernDB_ACU_LocalMessageAnchor;
    delete msg.TavernDB_ACU_ModifiedKeys;
    delete msg.TavernDB_ACU_UpdateGroupKeys;
    delete msg._acu_local_template_base_state_seeded;
}

/**
 * 按隔离标签清空单条消息上的表格数据（精确版 clearAllTableFields）。
 *
 * 与 clearAllTableFields_ACU 的区别：
 * - clearAllTableFields_ACU：无差别删除所有标签的所有字段，会误删同一消息上其他标签的数据。
 * - 本函数：只删除当前隔离标签下的数据；如果消息上还有其他标签的数据则保留。
 *
 * 清理范围：
 * 1. 新版 IsolatedData[isolationKey] 槽 → 删除该标签槽；若容器变空则删除整个 IsolatedData 字段。
 * 2. 旧版兼容字段（IndependentData / Data / SummaryData / ModifiedKeys / UpdateGroupKeys / Identity）
 *    → 仅在 isolationConfig 不启用隔离或该消息的 Identity 匹配当前隔离代码时才删除。
 *    这样可以避免把同一消息上属于其他隔离标签的旧版数据误删。
 * 3. 不删除消息正文（mes）、不删除非表格业务字段。
 *
 * @param msg 聊天消息对象
 * @param isolationKey 当前隔离标签键名
 * @param isolationConfig 隔离配置（用于判断旧版字段是否属于当前标签）
 * @returns 是否有任何字段被修改（用于调用方决定是否 saveChat）
 */
export function clearTableFieldsForIsolation_ACU(
    msg: any,
    isolationKey: string,
    isolationConfig: IsolationConfig_ACU,
): boolean {
    if (!msg) return false;

    let changed = false;

    // ── 新版：删除指定隔离标签的槽 ──
    const container = parseIsolatedDataField(msg);
    if (container && container[isolationKey]) {
        delete container[isolationKey];
        changed = true;
        // 如果容器里已经没有任何标签槽了，删除整个字段
        if (Object.keys(container).length === 0) {
            delete msg.TavernDB_ACU_IsolatedData;
        } else {
            msg.TavernDB_ACU_IsolatedData = container;
        }
    }

    // ── 旧版：仅在消息属于当前隔离标签时才删除 ──
    // 判断条件与 mergeAllIndependentTables_ACU 中的 legacy 兼容逻辑一致：
    // - 隔离启用：msg.TavernDB_ACU_Identity === code 时匹配
    // - 隔离关闭（无标签模式）：msg.TavernDB_ACU_Identity 不存在时匹配
    if (isLegacyMatchForIsolation_ACU(msg, isolationConfig)) {
        if (msg.TavernDB_ACU_IndependentData) {
            delete msg.TavernDB_ACU_IndependentData;
            changed = true;
        }
        if (msg.TavernDB_ACU_Data) {
            delete msg.TavernDB_ACU_Data;
            changed = true;
        }
        if (msg.TavernDB_ACU_SummaryData) {
            delete msg.TavernDB_ACU_SummaryData;
            changed = true;
        }
        if (msg.TavernDB_ACU_Identity !== undefined) {
            delete msg.TavernDB_ACU_Identity;
            changed = true;
        }
        if (msg.TavernDB_ACU_ModifiedKeys) {
            delete msg.TavernDB_ACU_ModifiedKeys;
            changed = true;
        }
        if (msg.TavernDB_ACU_UpdateGroupKeys) {
            delete msg.TavernDB_ACU_UpdateGroupKeys;
            changed = true;
        }
    }

    return changed;
}

// ════════════════════════════════════════════════════════════════
// 辅助类
// ════════════════════════════════════════════════════════════════

/**
 * 检查消息是否包含任何表格数据（新版或旧版）。
 * 可选传入 isolationKey 和 isolationConfig 来限定检查范围。
 *
 * @param msg 聊天消息对象
 * @param isolationKey 可选，指定检查的隔离标签
 * @param isolationConfig 可选，用于旧版数据的隔离匹配
 * @returns 是否包含表格数据
 */
export function hasAnyTableData_ACU(
    msg: any,
    isolationKey?: string,
    isolationConfig?: IsolationConfig_ACU,
): boolean {
    if (!msg) return false;

    // 检查新版 IsolatedData
    if (isolationKey) {
        const tagData = readIsolatedTagData_ACU(msg, isolationKey);
        if (tagData?.independentData && Object.keys(tagData.independentData).some(k => k.startsWith('sheet_'))) {
            return true;
        }
    } else {
        const container = parseIsolatedDataField(msg);
        if (container && Object.keys(container).length > 0) {
            return true;
        }
    }

    // 检查旧版数据（如果提供了隔离配置，先检查匹配）
    if (isolationConfig && !isLegacyMatchForIsolation_ACU(msg, isolationConfig)) {
        return false;
    }

    if (msg.TavernDB_ACU_IndependentData && hasAnySheetKey(msg.TavernDB_ACU_IndependentData)) return true;
    if (msg.TavernDB_ACU_Data && hasAnySheetKey(msg.TavernDB_ACU_Data)) return true;
    if (msg.TavernDB_ACU_SummaryData && hasAnySheetKey(msg.TavernDB_ACU_SummaryData)) return true;

    return false;
}

/**
 * 深拷贝 IsolatedData 容器（安全修改用）。
 * 如果字段不存在或解析失败，返回空对象。
 *
 * @param msg 聊天消息对象
 * @returns 深拷贝后的 IsolatedData 容器
 */
export function cloneIsolatedData_ACU(msg: any): IsolatedDataContainer_ACU {
    const container = parseIsolatedDataField(msg);
    if (!container) return {};
    return safeClone(container);
}
