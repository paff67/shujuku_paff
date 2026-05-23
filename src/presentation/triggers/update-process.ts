// update-process.ts — 表格更新 UI 壳（presentation 层：负责 UI 交互）
// service 层只返回结果，presentation 层根据返回值自行决定 UI 操作。

import { _set_isAutoUpdatingCard_ACU, _set_wasStoppedByUser_ACU } from '../../service/runtime/state-manager';
import { getManualSelectionFromUI_ACU } from '../components/table-selector';
import { showToastr_ACU } from '../theme/toast';
import { showCustomConfirm_ACU } from '../theme/custom-confirm';
import { ACU_TOAST_CATEGORY_ACU } from '../../shared/constants';
import { logDebug_ACU, logError_ACU, logWarn_ACU } from '../../shared/utils';
// re-export 从 service 层搬迁的业务逻辑函数，保持外部调用方兼容
export { saveCurrentDataForTable_ACU } from '../../service/chat/chat-service';
import { toastr_API_ACU } from '../../shared/host-api';
import { $statusMessageSpan_ACU } from '../state/ui-refs';
import { topLevelWindow_ACU } from '../../shared/env';
import { renderStopButton_ACU } from '../../shared/html-helpers';
import { bindTableFillStopButton_ACU, resetManualUpdateButton_ACU, shouldShowVectorMemoryManualUpdateWarning_ACU, syncManualUpdateButtonAvailability_ACU } from '../components/status-display';
import { updateCardUpdateStatusDisplay_ACU } from '../components/update-status-display';
import { collectManualExtraHint_ACU } from './settings-ui-sync';
import { refreshMergedDataAndNotifyWithUI_ACU } from '../components/pipeline-ui-helpers';
import { abortAllActiveRequests_ACU } from '../../service/runtime/state-manager';
import {
    processUpdatesBatch_ACU,
    executeCardUpdateCore_ACU,
    orchestrateManualUpdate_ACU,
    type CardUpdateResult,
    type BatchUpdateResult,
    type CardUpdateProgressEvent,
    type BatchUpdateProgressContext,
    type ExecuteCardUpdateOptions_ACU,
} from '../../service/table/update-orchestrator';

// ============================================================
// UI 辅助函数
// ============================================================

function updateStatusText(text: string, isSilentMode: boolean) {
    if (!isSilentMode && $statusMessageSpan_ACU) $statusMessageSpan_ACU.text(text);
}

function notifyTableFillStart() {
    try { (topLevelWindow_ACU as any).AutoCardUpdaterAPI._notifyTableFillStart(); } catch (_) {}
}

function notifyTableUpdate() {
    try { (topLevelWindow_ACU as any).AutoCardUpdaterAPI._notifyTableUpdate(); } catch (_) {}
}

function updateStatusDisplay() {
    if (typeof updateCardUpdateStatusDisplay_ACU === 'function') updateCardUpdateStatusDisplay_ACU();
}

function buildBatchProgressLabel(event: Partial<CardUpdateProgressEvent>): string {
    if (Number.isFinite(event.currentBatch) && Number.isFinite(event.totalBatches)) {
        return `第 ${event.currentBatch}/${event.totalBatches} 批`;
    }
    return '当前批次';
}

function buildProgressMessage(event: CardUpdateProgressEvent): string {
    const batchLabel = buildBatchProgressLabel(event);
    switch (event.phase) {
        case 'preparing':
            return `${batchLabel}：准备AI输入...`;
        case 'calling_ai':
            return `${batchLabel}：第 ${event.attempt || 1}/${event.maxRetries || 1} 次调用AI进行增量更新...`;
        case 'parsing':
            return `${batchLabel}：解析并应用AI返回的更新...`;
        case 'saving':
            return `${batchLabel}：正在将更新后的数据库保存到聊天记录...`;
        case 'chunk_done':
            return `${batchLabel}：分块处理成功...`;
        case 'complete':
            return `${batchLabel}：数据库增量更新成功！`;
        case 'retry':
            return `${batchLabel}：第 ${event.attempt || 1}/${event.maxRetries || 1} 次尝试失败，5秒后重试...${event.message ? ` (${event.message})` : ''}`;
        case 'error':
            return `${batchLabel}：错误：更新失败。`;
        default:
            return `${batchLabel}：正在处理...`;
    }
}

function updateLoadingToastMessage(loadingToast: any, message: string) {
    if (!loadingToast || !toastr_API_ACU) return;
    loadingToast.find('.acu-toast-progress-message').text(message);
}

/**
 * 根据 service 层返回的进度事件更新 UI
 * presentation 层自己决定"怎么展示"
 */
function handleProgressEvent(event: CardUpdateProgressEvent, isSilentMode: boolean, loadingToast?: any) {
    if (isSilentMode) return;
    const message = buildProgressMessage(event);
    updateStatusText(message, false);
    updateLoadingToastMessage(loadingToast, message);

    switch (event.phase) {
        case 'complete':
            updateStatusDisplay();
            break;
        case 'retry':
            showToastr_ACU('warning', message, { timeOut: 5000 });
            break;
        default:
            break;
    }
}

// ============================================================
// Presentation 层 UI 壳函数
// ============================================================

/**
 * 执行单次卡片更新：presentation 层负责 toast/停止按钮/状态文本
 * service 层只返回 CardUpdateResult
 */
export async function proceedWithCardUpdate_ACU(
    messagesToUse: any[],
    batchToastMessage = '正在填表，请稍候...',
    saveTargetIndex = -1,
    isImportMode = false,
    updateMode = 'standard',
    isSilentMode = false,
    targetSheetKeys: string[] | null = null,
    requestOptions: Record<string, any> | null = null,
    progressContext: BatchUpdateProgressContext | null = null,
    executionOptions: ExecuteCardUpdateOptions_ACU = {},
): Promise<CardUpdateResult> {
    logDebug_ACU(`[更新流程] proceedWithCardUpdate: 消息数=${messagesToUse.length}, 模式=${updateMode}, 静默=${isSilentMode}, 目标表=${targetSheetKeys?.join(',') || '全部'}`);
    const localAbortController = new AbortController();
    let loadingToast: any = null;
    const stopButtonId = `acu-stop-update-btn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // UI：通知填表开始
    if (!isSilentMode) {
        notifyTableFillStart();

        // UI：显示加载 toast（带停止按钮）
        const stopButtonHtml = renderStopButton_ACU(stopButtonId, '终止');
        const initialMessage = progressContext
            ? `${buildBatchProgressLabel(progressContext)}：${batchToastMessage || '正在填表，请稍候...'}`
            : (batchToastMessage || '正在填表，请稍候...');
        const toastMessage = `<div><span class="acu-toast-progress-message">${initialMessage}</span>${stopButtonHtml}</div>`;
        loadingToast = showToastr_ACU('info', toastMessage, {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
            acuToastCategory: ACU_TOAST_CATEGORY_ACU.MANUAL_TABLE,
            onShown: function () {
                if (typeof bindTableFillStopButton_ACU === 'function') {
                    bindTableFillStopButton_ACU(stopButtonId, () => {
                        _set_wasStoppedByUser_ACU(true);
                        abortAllActiveRequests_ACU();
                        _set_isAutoUpdatingCard_ACU(false);
                        updateStatusText('填表任务已终止，正在停止当前任务与后续批次...', false);
                        updateLoadingToastMessage(loadingToast, '填表任务已终止，正在停止当前任务与后续批次...');
                        showToastr_ACU('warning', '填表任务已由用户终止，当前任务与后续批次将立即停止。');
                    });
                }
            }
        });
    }

    try {
        // 调用 service 层，传入进度回调（只接收纯数据事件）
        const result = await executeCardUpdateCore_ACU(
            messagesToUse,
            saveTargetIndex,
            isImportMode,
            updateMode,
            isSilentMode,
            targetSheetKeys,
            requestOptions,
            localAbortController,
            progressContext,
            (event) => handleProgressEvent(event, isSilentMode, loadingToast),
            executionOptions,
        );

        // UI：根据返回值决定后续 UI 操作
        if (result.success && !isSilentMode) {
            setTimeout(() => {
                notifyTableUpdate();
            }, 250);
        } else if (!result.success && !result.aborted && !isSilentMode) {
            showToastr_ACU('error', `更新失败: ${result.error || '未知错误'}`);
            updateStatusText('错误：更新失败。', false);
        }

        return result;
    } finally {
        // UI：清除加载 toast
        if (loadingToast && toastr_API_ACU) {
            toastr_API_ACU.clear(loadingToast);
        }
    }
}

/**
 * 批处理更新：presentation 层调用 service 层，根据返回值显示 toast
 */
export async function processUpdates_ACU(indicesToUpdate: number[], mode = 'auto', options: any = {}): Promise<BatchUpdateResult> {
    const result = await processUpdatesBatch_ACU(
        indicesToUpdate,
        mode,
        options,
        // executeUpdate 回调：创建 AbortController 并调用 presentation 层的 proceedWithCardUpdate
        async (
            messagesToUse: any[],
            saveTargetIndex: number,
            updateMode: string,
            isSilentMode: boolean,
            targetSheetKeys: string[] | null,
            requestOptions: Record<string, any> | null,
            progressContext: BatchUpdateProgressContext,
            executionOptions?: ExecuteCardUpdateOptions_ACU,
        ): Promise<CardUpdateResult> => {
            return proceedWithCardUpdate_ACU(messagesToUse, '', saveTargetIndex, false, updateMode, isSilentMode, targetSheetKeys, requestOptions, progressContext, executionOptions || {});
        }
    );

    // UI：根据返回值显示错误 toast
    if (!result.success && result.error) {
        showToastr_ACU('error', result.error);
    }

    return result;
}

/**
 * 手动更新：presentation 层负责收集 UI 输入、显示确认框、显示 toast、重置按钮
 * service 层只返回 ManualUpdateResult
 */
export async function handleManualUpdate_ACU() {
    logDebug_ACU('[更新流程] handleManualUpdate: 开始手动更新');
    try {
        if (shouldShowVectorMemoryManualUpdateWarning_ACU()) {
            syncManualUpdateButtonAvailability_ACU();
            showToastr_ACU('warning', '向量功能启用时不建议手动更新表格；本次将继续执行。', {
                acuToastCategory: ACU_TOAST_CATEGORY_ACU.MANUAL_TABLE,
            });
        }
 
        // UI：收集手动额外提示
        collectManualExtraHint_ACU();

        // UI：获取手动选择的表格
        const targetKeys = getManualSelectionFromUI_ACU();

        // [前置校验] 在弹出确认框之前，先做基本有效性检查
        // 避免用户确认后又因为"没选表格"或"聊天为空"而报错
        if (!targetKeys || targetKeys.length === 0) {
            showToastr_ACU('warning', '未选择需要更新的表格。');
            return;
        }

        // 弹出确认框：告知用户将先清除对应楼层中本次选中表格的数据，再执行新的手动填表
        // 这是防止 SQL 严格填表逻辑因旧数据残留导致写入失败的关键步骤
        const confirmed = await showCustomConfirm_ACU(
            '手动填表确认',
            '即将执行手动填表。\n\n' +
            '为确保填表成功，系统将先清除本次涉及楼层中当前选中表格的数据，再进行新的数据填写。\n' +
            '（此操作可防止 SQL 严格填表逻辑因旧数据残留导致写入失败）\n\n' +
            '如果不想清空旧数据，可以选择取消。',
            { confirmLabel: '确认并继续', cancelLabel: '取消' }
        );

        if (!confirmed) {
            logDebug_ACU('[更新流程] 用户取消了手动填表确认框');
            showToastr_ACU('info', '已取消手动填表。');
            return;
        }

        // 调用 service 层，传入 clearBeforeUpdate: true（用户已确认清空）
        _set_wasStoppedByUser_ACU(false);

        // 手动更新进度 toast（和自动更新保持一致）
        const manualStopButtonId = `acu-stop-manual-btn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const manualStopButtonHtml = renderStopButton_ACU(manualStopButtonId, '终止');
        const manualInitialMessage = '正在准备手动填表...';
        const manualToastMessage = `<div><span class="acu-toast-progress-message">${manualInitialMessage}</span>${manualStopButtonHtml}</div>`;
        let manualLoadingToast: any = null;
        if (typeof toastr_API_ACU !== 'undefined') {
            notifyTableFillStart();
            manualLoadingToast = showToastr_ACU('info', manualToastMessage, {
                timeOut: 0,
                extendedTimeOut: 0,
                tapToDismiss: false,
                acuToastCategory: ACU_TOAST_CATEGORY_ACU.MANUAL_TABLE,
                onShown: function () {
                    if (typeof bindTableFillStopButton_ACU === 'function') {
                        bindTableFillStopButton_ACU(manualStopButtonId, () => {
                            _set_wasStoppedByUser_ACU(true);
                            abortAllActiveRequests_ACU();
                            _set_isAutoUpdatingCard_ACU(false);
                            updateStatusText('手动填表已终止...', false);
                            updateLoadingToastMessage(manualLoadingToast, '手动填表已终止...');
                            showToastr_ACU('warning', '手动填表任务已由用户终止。');
                        });
                    }
                },
            });
        }

        const manualOnProgress = (event: CardUpdateProgressEvent) => {
            const message = buildProgressMessage(event);
            updateStatusText(message, false);
            updateLoadingToastMessage(manualLoadingToast, message);
            if (event.phase === 'retry') {
                showToastr_ACU('warning', message, { timeOut: 5000 });
            }
        };

        const result = await orchestrateManualUpdate_ACU(
            targetKeys,
            // processBatch 回调
            async (indices, batchMode, batchOptions) => {
                return processUpdates_ACU(indices, batchMode, batchOptions);
            },
            // refreshData 回调（纯数据刷新 + UI 刷新）
            async () => {
                await refreshMergedDataAndNotifyWithUI_ACU();
            },
            // 传入用户确认后的预清空选项
            { clearBeforeUpdate: true },
            manualOnProgress,
        );

        // 清除进度 toast
        if (manualLoadingToast && toastr_API_ACU) {
            toastr_API_ACU.clear(manualLoadingToast);
        }

        // UI：根据返回值显示 toast
        if (result.success) {
            showToastr_ACU('success', '手动更新完成！');
            updateStatusDisplay();
            notifyTableUpdate();

            if (result.autoMergeTriggered && result.autoMergeSuccess) {
                showToastr_ACU('success', '自动合并纪要完成！');
                notifyTableUpdate();
            }
        } else if (result.error) {
            // 区分 warning 和 error 类型
            const warningMessages = ['正在进行中', '聊天记录为空', '尚未检测到', '未选择', '未找到可用'];
            const isWarning = warningMessages.some(msg => result.error!.includes(msg));
            showToastr_ACU(isWarning ? 'warning' : 'error', result.error);
        }
    } finally {
        // UI：重置手动更新按钮
        if (typeof resetManualUpdateButton_ACU === 'function') resetManualUpdateButton_ACU();
    }
}

// saveCurrentDataForTable_ACU 已搬迁到 service/chat/chat-service.ts
// 通过文件顶部的 re-export 保持外部调用方兼容
