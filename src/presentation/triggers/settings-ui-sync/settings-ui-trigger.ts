/**
 * presentation/triggers/settings-ui-sync/settings-ui-trigger.ts
 */
import { DEFAULT_CHAR_CARD_PROMPT_ACU } from '../../../shared/defaults-json.js';
import { AUTO_UPDATE_FLOOR_INCREASE_DELAY_ACU } from '../../../shared/defaults';
import { updateCardUpdateStatusDisplay_ACU } from '../../components/update-status-display';
import { getCharCardPromptFromUI_ACU, isAutoUpdatingCard_ACU, newMessageDebounceTimer_ACU, renderPromptSegments_ACU, wasStoppedByUser_ACU , _set_isAutoUpdatingCard_ACU, _set_newMessageDebounceTimer_ACU} from '../../components/plot-editors';
import { showToastr_ACU } from '../../theme/toast';
import { ACU_TOAST_CATEGORY_ACU } from '../../../shared/constants';
import { SillyTavern_API_ACU, TavernHelper_API_ACU, toastr_API_ACU, _set_SillyTavern_API_ACU, _set_TavernHelper_API_ACU, _set_jQuery_API_ACU, _set_toastr_API_ACU, jQuery_API_ACU as jQueryHost_API_ACU } from '../../../shared/host-api';
import { jQuery_API_ACU } from '../../dom-utils';
import { getChatArray_ACU, saveChatToHost_ACU } from '../../../service/chat/chat-service';
import { getConnectionManagerProfiles_ACU } from '../../../service/ai/ai-service';
import { getCurrentCharacterFallback_ACU } from '../../../service/host/host-state-service';
import { NEW_MESSAGE_DEBOUNCE_DELAY_ACU, allChatMessages_ACU, coreApisAreReady_ACU, currentJsonTableData_ACU, getCurrentIsolationKey_ACU, lastTotalAiMessages_ACU, settings_ACU , _set_coreApisAreReady_ACU, _set_lastTotalAiMessages_ACU, _set_manualExtraHint_ACU} from '../../../service/runtime/state-manager';
import { $popupInstance_ACU, $customApiUrlInput_ACU, $customApiKeyInput_ACU, $customApiModelInput_ACU, $customApiModelSelect_ACU, $maxTokensInput_ACU, $temperatureInput_ACU, $apiStatusDisplay_ACU, $charCardPromptSegmentsContainer_ACU, $autoUpdateThresholdInput_ACU, $autoUpdateTokenThresholdInput_ACU, $autoUpdateFrequencyInput_ACU, $updateBatchSizeInput_ACU, $maxConcurrentGroupsInput_ACU, $skipUpdateFloorsInput_ACU, $retainRecentLayersInput_ACU, $tableMaxRetriesInput_ACU, $manualExtraHintCheckbox_ACU } from '../../state/ui-refs';
import { saveSettingsAndNotify_ACU, loadSettingsAndRefreshUI_ACU } from '../../components/settings-ui-helpers';
import { processUpdates_ACU } from '../update-process';
import { getSortedSheetKeys_ACU } from '../../../service/template/chat-scope';
import { loadAllChatMessages_ACU } from '../../../service/worldbook/pipeline';
import { refreshMergedDataAndNotifyWithUI_ACU } from '../../components/pipeline-ui-helpers';
import { SCRIPT_ID_PREFIX_ACU } from '../../../shared/constants';
import { escapeHtml_ACU } from '../../../shared/html-helpers';
import { topLevelWindow_ACU } from '../../../shared/env';
import { isSummaryOrOutlineTable_ACU, logDebug_ACU, logError_ACU, logWarn_ACU } from '../../../shared/utils';
import { executeContentOptimization_ACU } from '../../components/optimization-ui';
import { maybeLiftWorldbookSuppression_ACU } from '../../../service/runtime/helpers-remaining';
import { purgeOldLayerData_ACU } from './settings-ui-config';
import { buildAutoUpdatePlan_ACU, checkAutoUpdatePreConditions_ACU, executeAutoUpdatePlan_ACU, handleFloorIncreaseDelay_ACU, type AutoUpdateProgressEvent } from '../../../service/table/update-scheduler';
import { renderStopButton_ACU } from '../../../shared/html-helpers';
import { bindTableFillStopButton_ACU } from '../../components/status-display';
import { abortAllActiveRequests_ACU } from '../../../service/runtime/state-manager';
import { $statusMessageSpan_ACU } from '../../state/ui-refs';

  export async function triggerAutomaticUpdateIfNeeded_ACU() {
    logDebug_ACU('ACU Auto-Trigger: Starting independent check...');

    // [重构] 调用 service 层前置检查
    const preCheck = checkAutoUpdatePreConditions_ACU(
        settings_ACU,
        coreApisAreReady_ACU,
        isAutoUpdatingCard_ACU,
        currentJsonTableData_ACU,
        allChatMessages_ACU.length
    );
    if (!preCheck.canProceed) {
      logDebug_ACU(`ACU Auto-Trigger: ${preCheck.reason} Skipping.`);
      return;
    }

    let liveChat = getChatArray_ACU();
    if (!liveChat || liveChat.length === 0) return;

    let totalAiMessages = liveChat.filter(m => !m.is_user).length;

    // [重构] 调用 service 层楼层增加延迟逻辑
    const delayResult = await handleFloorIncreaseDelay_ACU(
        totalAiMessages,
        lastTotalAiMessages_ACU,
        AUTO_UPDATE_FLOOR_INCREASE_DELAY_ACU,
        getChatArray_ACU,
        _set_lastTotalAiMessages_ACU
    );
    if (delayResult === null) return; // chat 为空
    if (delayResult) {
        liveChat = delayResult.liveChat;
        totalAiMessages = delayResult.totalAiMessages;
    }

    // [重构] 调用 service 层构建更新计划
    const triggerIsolationKey = getCurrentIsolationKey_ACU();
    const plan = buildAutoUpdatePlan_ACU(liveChat, currentJsonTableData_ACU, settings_ACU, triggerIsolationKey);
    if (plan.tablesToUpdate.length === 0) return;

    const totalGroups = Object.keys(plan.updateGroups).length;

    // UI：创建与手动填表一致的进度 toast（带停止按钮）
    const autoStopButtonId = `acu-stop-auto-btn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const autoStopButtonHtml = renderStopButton_ACU(autoStopButtonId, '终止');
    const autoInitialMessage = `正在准备自动填表（${totalGroups} 组）...`;
    const autoToastMessage = `<div><span class="acu-toast-progress-message">${autoInitialMessage}</span>${autoStopButtonHtml}</div>`;
    let autoLoadingToast: any = null;

    try {
      if (typeof toastr_API_ACU !== 'undefined') {
        try { (topLevelWindow_ACU as any).AutoCardUpdaterAPI._notifyTableFillStart(); } catch (_) {}
        autoLoadingToast = showToastr_ACU('info', autoToastMessage, {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
            acuToastCategory: ACU_TOAST_CATEGORY_ACU.MANUAL_TABLE,
            onShown: function () {
                if (typeof bindTableFillStopButton_ACU === 'function') {
                    bindTableFillStopButton_ACU(autoStopButtonId, () => {
                        _set_isAutoUpdatingCard_ACU(false);
                        abortAllActiveRequests_ACU();
                        if ($statusMessageSpan_ACU) $statusMessageSpan_ACU.text('自动填表已终止...');
                        if (autoLoadingToast) autoLoadingToast.find('.acu-toast-progress-message').text('自动填表已终止...');
                        showToastr_ACU('warning', '自动填表任务已由用户终止。');
                    });
                }
            },
        });
      }
    } catch (_) { /* toast 创建失败不阻断业务 */ }

    // 构建自动进度回调（与手动填表进度更新逻辑一致）
    const autoOnProgress = (event: AutoUpdateProgressEvent) => {
        const phaseMessages: Record<string, string> = {
            'preparing': `正在准备自动填表（${event.totalGroups} 组）...`,
            'calling_ai': `正在调用 AI 生成更新...`,
            'merging': `正在合并 AI 编辑结果...`,
            'applying': `正在执行合并编辑...`,
            'saving': `正在保存更新到聊天记录...`,
            'complete': `${event.totalGroups} 组自动更新完成！`,
            'error': `更新出错：${event.message || '未知错误'}`,
        };
        const msg = phaseMessages[event.phase] || event.message || '正在处理...';
        if ($statusMessageSpan_ACU) $statusMessageSpan_ACU.text(msg);
        if (autoLoadingToast) autoLoadingToast.find('.acu-toast-progress-message').text(msg);
    };

    // 调用 service 层执行更新计划，传入纯业务操作委托（不含 UI 操作）
    const result = await executeAutoUpdatePlan_ACU(
        plan,
        settings_ACU,
        _set_isAutoUpdatingCard_ACU,
        {
            processUpdates: (indices, mode, options) => processUpdates_ACU(indices, mode, options),
            refreshData: () => refreshMergedDataAndNotifyWithUI_ACU(),
            loadAllChatMessages: () => loadAllChatMessages_ACU(),
            purgeOldLayerData: () => purgeOldLayerData_ACU(),
        },
        autoOnProgress,
    );

    // 清除进度 toast
    if (autoLoadingToast && toastr_API_ACU) {
        toastr_API_ACU.clear(autoLoadingToast);
    }


    // UI：根据返回值显示结果
    if (result.failedGroups > 0) {
        showToastr_ACU('warning', `并发分组更新有 ${result.failedGroups} 组失败，请查看日志。`);
    }
    if (result.autoMergeTriggered && result.autoMergeSuccess) {
        showToastr_ACU('success', '自动合并纪要完成！');
        try { (topLevelWindow_ACU as any).AutoCardUpdaterAPI._notifyTableUpdate(); } catch (_) {}
    }
    if (typeof updateCardUpdateStatusDisplay_ACU === 'function') updateCardUpdateStatusDisplay_ACU();
  }

  export function collectManualExtraHint_ACU() {
      _set_manualExtraHint_ACU('');
      if (!$manualExtraHintCheckbox_ACU || !$manualExtraHintCheckbox_ACU.length) return;
      if (!$manualExtraHintCheckbox_ACU.is(':checked')) return;

      const userInput = prompt('请输入本次手动填表的额外提示词（可留空）：', '');
      const trimmed = (userInput || '').trim();
      if (!trimmed) return;

      _set_manualExtraHint_ACU(`以下为用户的额外填表要求，请严格遵守：${trimmed}`);
  }

  // [新增] 获取当前选中的手动更新表格列表（无效或为空则回退为全部表）
  export function getSelectedManualSheetKeys_ACU() {
      if (!currentJsonTableData_ACU) return [];
      const availableKeys = getSortedSheetKeys_ACU(currentJsonTableData_ACU);
      const saved = Array.isArray(settings_ACU.manualSelectedTables) ? settings_ACU.manualSelectedTables : [];

      // 未曾手动选择过：默认全选
      if (!settings_ACU.hasManualSelection) return availableKeys;

      const validSaved = saved.filter((k: string) => availableKeys.includes(k));

      // 已手动选择过：严格按保存的交集，不再自动补全新表，防止回退全选
      return validSaved;
  }

