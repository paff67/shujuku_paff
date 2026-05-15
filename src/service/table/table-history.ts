import type { ACUMessage } from '../../shared/host-api';
import { getTablePersistenceDeltasV2_ACU } from '../../shared/models/table-persistence-v2-utils';

export interface TableHistoryState_ACU {
    latestAiMessageIndex: number;
    latestDataMessageIndex: number;
    lastTrackedUpdateMessageIndex: number;
    latestDataAiFloor: number;
    lastTrackedUpdateAiFloor: number;
    hasAnyData: boolean;
    hasTrackedUpdate: boolean;
}

interface ResolveTableHistoryOptions_ACU {
    sheetKey: string;
    isSummaryTable: boolean;
    isolationKey: string;
    settings: any;
}

function isLegacyMatchForMessage_ACU(msg: any, settings: any): boolean {
    const msgIdentity = msg?.TavernDB_ACU_Identity;
    if (settings?.dataIsolationEnabled) {
        return msgIdentity === settings.dataIsolationCode;
    }
    return !msgIdentity;
}

function getTablePersistenceLayerV2_ACU(msg: any, isolationKey: string): any {
    return msg?.TavernDB_ACU_IsolatedData?.[isolationKey]?.tablePersistenceV2 || null;
}

function hasTableDataInMessage_ACU(msg: any, options: ResolveTableHistoryOptions_ACU): boolean {
    const { sheetKey, isSummaryTable, isolationKey, settings } = options;
    const layer = getTablePersistenceLayerV2_ACU(msg, isolationKey);

    if (layer?.checkpoint?.data?.[sheetKey]) {
        return true;
    }

    for (const delta of getTablePersistenceDeltasV2_ACU(layer)) {
        if (Array.isArray(delta.changedSheets) && delta.changedSheets.includes(sheetKey)) {
            return true;
        }
        if (delta.changesBySheet?.[sheetKey]) {
            return true;
        }
    }

    if (msg?.TavernDB_ACU_IsolatedData?.[isolationKey]?.independentData?.[sheetKey]) {
        return true;
    }

    if (!isLegacyMatchForMessage_ACU(msg, settings)) {
        return false;
    }

    return !!(
        msg?.TavernDB_ACU_IndependentData?.[sheetKey]
        || (isSummaryTable
            ? msg?.TavernDB_ACU_SummaryData?.[sheetKey]
            : msg?.TavernDB_ACU_Data?.[sheetKey])
    );
}

function hasTrackedUpdateInMessage_ACU(msg: any, options: ResolveTableHistoryOptions_ACU): boolean {
    const { sheetKey, isolationKey, settings } = options;
    const tagData = msg?.TavernDB_ACU_IsolatedData?.[isolationKey];
    const layer = getTablePersistenceLayerV2_ACU(msg, isolationKey);

    for (const delta of getTablePersistenceDeltasV2_ACU(layer)) {
        const v2ModifiedKeys = Array.isArray(delta.modifiedKeys) ? delta.modifiedKeys : [];
        const v2UpdateGroupKeys = Array.isArray(delta.updateGroupKeys) ? delta.updateGroupKeys : [];

        if (v2UpdateGroupKeys.includes(sheetKey) || v2ModifiedKeys.includes(sheetKey)) {
            return true;
        }
    }

    const isolatedModifiedKeys = Array.isArray(tagData?.modifiedKeys) ? tagData.modifiedKeys : [];
    const isolatedUpdateGroupKeys = Array.isArray(tagData?.updateGroupKeys) ? tagData.updateGroupKeys : [];

    if (isolatedUpdateGroupKeys.includes(sheetKey) || isolatedModifiedKeys.includes(sheetKey)) {
        return true;
    }

    if (!isLegacyMatchForMessage_ACU(msg, settings)) {
        return false;
    }

    const legacyModifiedKeys = Array.isArray(msg?.TavernDB_ACU_ModifiedKeys) ? msg.TavernDB_ACU_ModifiedKeys : [];
    const legacyUpdateGroupKeys = Array.isArray(msg?.TavernDB_ACU_UpdateGroupKeys) ? msg.TavernDB_ACU_UpdateGroupKeys : [];
    return legacyUpdateGroupKeys.includes(sheetKey) || legacyModifiedKeys.includes(sheetKey);
}

export function getLatestAiMessageIndexFromChat_ACU(chat: ACUMessage[] | any[]): number {
    if (!Array.isArray(chat)) return -1;
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        if (chat[i] && !chat[i].is_user) return i;
    }
    return -1;
}

export function countAiMessagesUpToIndex_ACU(chat: ACUMessage[] | any[], messageIndex: number): number {
    if (!Array.isArray(chat) || messageIndex < 0) return 0;
    let count = 0;
    for (let i = 0; i <= messageIndex && i < chat.length; i += 1) {
        if (chat[i] && !chat[i].is_user) count += 1;
    }
    return count;
}

export function resolveTableHistoryStateFromChat_ACU(
    chat: ACUMessage[] | any[],
    options: ResolveTableHistoryOptions_ACU,
): TableHistoryState_ACU {
    const latestAiMessageIndex = getLatestAiMessageIndexFromChat_ACU(chat);
    let latestDataMessageIndex = -1;
    let lastTrackedUpdateMessageIndex = -1;

    if (Array.isArray(chat)) {
        for (let i = chat.length - 1; i >= 0; i -= 1) {
            const msg = chat[i];
            if (!msg || msg.is_user) continue;

            if (latestDataMessageIndex === -1 && hasTableDataInMessage_ACU(msg, options)) {
                latestDataMessageIndex = i;
            }

            if (lastTrackedUpdateMessageIndex === -1 && hasTrackedUpdateInMessage_ACU(msg, options)) {
                lastTrackedUpdateMessageIndex = i;
            }

            if (latestDataMessageIndex !== -1 && lastTrackedUpdateMessageIndex !== -1) {
                break;
            }
        }
    }

    return {
        latestAiMessageIndex,
        latestDataMessageIndex,
        lastTrackedUpdateMessageIndex,
        latestDataAiFloor: countAiMessagesUpToIndex_ACU(chat, latestDataMessageIndex),
        lastTrackedUpdateAiFloor: countAiMessagesUpToIndex_ACU(chat, lastTrackedUpdateMessageIndex),
        hasAnyData: latestDataMessageIndex !== -1,
        hasTrackedUpdate: lastTrackedUpdateMessageIndex !== -1,
    };
}
