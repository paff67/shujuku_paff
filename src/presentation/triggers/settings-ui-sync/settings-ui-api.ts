/**
 * presentation/triggers/settings-ui-sync/settings-ui-api.ts
 */
import { DEFAULT_CHAR_CARD_PROMPT_ACU } from '../../../shared/defaults-json.js';
import { AUTO_UPDATE_FLOOR_INCREASE_DELAY_ACU } from '../../../shared/defaults';
import { updateCardUpdateStatusDisplay_ACU } from '../../components/update-status-display';
import { getCharCardPromptFromUI_ACU, isAutoUpdatingCard_ACU, manualExtraHint_ACU, newMessageDebounceTimer_ACU, refreshCurrentPlotTaskApiPresetSelect_ACU, renderPromptSegments_ACU, wasStoppedByUser_ACU , _set_isAutoUpdatingCard_ACU, _set_manualExtraHint_ACU, _set_newMessageDebounceTimer_ACU} from '../../components/plot-editors';
import { showToastr_ACU } from '../../theme/toast';
import { ACU_TOAST_CATEGORY_ACU } from '../../../shared/constants';
import { SillyTavern_API_ACU, TavernHelper_API_ACU, toastr_API_ACU, _set_SillyTavern_API_ACU, _set_TavernHelper_API_ACU, _set_jQuery_API_ACU, _set_toastr_API_ACU } from '../../../shared/host-api';
import { jQuery_API_ACU } from '../../dom-utils';
import { getChatArray_ACU, saveChatToHost_ACU } from '../../../service/chat/chat-service';
import { getConnectionManagerProfiles_ACU } from '../../../service/ai/ai-service';
import { getCurrentCharacterFallback_ACU } from '../../../service/host/host-state-service';
import { NEW_MESSAGE_DEBOUNCE_DELAY_ACU, allChatMessages_ACU, coreApisAreReady_ACU, currentJsonTableData_ACU, getCurrentIsolationKey_ACU, lastTotalAiMessages_ACU, settings_ACU , _set_coreApisAreReady_ACU, _set_lastTotalAiMessages_ACU} from '../../../service/runtime/state-manager';
import { $popupInstance_ACU, $customApiUrlInput_ACU, $customApiKeyInput_ACU, $customApiModelInput_ACU, $customApiModelSelect_ACU, $maxTokensInput_ACU, $temperatureInput_ACU, $apiStatusDisplay_ACU, $charCardPromptSegmentsContainer_ACU, $autoUpdateThresholdInput_ACU, $autoUpdateTokenThresholdInput_ACU, $autoUpdateFrequencyInput_ACU, $updateBatchSizeInput_ACU, $maxConcurrentGroupsInput_ACU, $skipUpdateFloorsInput_ACU, $retainRecentLayersInput_ACU, $tableMaxRetriesInput_ACU, $manualExtraHintCheckbox_ACU } from '../../state/ui-refs';
import { saveSettingsAndNotify_ACU, loadSettingsAndRefreshUI_ACU } from '../../components/settings-ui-helpers';
import { checkAutoMergeTrigger_ACU, prepareAutoMergeBatches_ACU, executeAutoMergeBatch_ACU, finalizeAutoMerge_ACU } from '../../../service/summary/merge-logic';
import { processUpdates_ACU } from '../update-process';
import { getSortedSheetKeys_ACU } from '../../../service/template/chat-scope';
import { loadAllChatMessages_ACU } from '../../../service/worldbook/pipeline';
import { refreshMergedDataAndNotifyWithUI_ACU } from '../../components/pipeline-ui-helpers';
import { SCRIPT_ID_PREFIX_ACU } from '../../../shared/constants';
import { escapeHtml_ACU, renderOption_ACU } from '../../../shared/html-helpers';
import { topLevelWindow_ACU } from '../../../shared/env';
import { isSummaryOrOutlineTable_ACU, logDebug_ACU, logError_ACU, logWarn_ACU } from '../../../shared/utils';
import { executeContentOptimization_ACU } from '../../components/optimization-ui';
import { maybeLiftWorldbookSuppression_ACU } from '../../../service/runtime/helpers-remaining';
import { getCurrentVectorMemoryConfig_ACU } from '../../../service/vector/vector-memory-config';
/**
 * presentation/triggers/settings-ui-sync.ts — UI读写/保存/刷新函数
 * 从 service/runtime/helpers-remaining.ts 提取的纯 UI 函数
 */

  // --- 循环 UI ---

  /**
   * 更新循环UI状态

   */
  export function updateLoopUIStatus_ACU(isRunning: boolean) {
    if (!$popupInstance_ACU) return;
    const $startBtn = $popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-plot-start-loop-btn`);
    const $stopBtn = $popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-plot-stop-loop-btn`);
    const $statusText = $popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-plot-loop-status-text`);
    const $timerDisplay = $popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-plot-loop-timer-display`);

    if (isRunning) {
      $startBtn.hide();
      $stopBtn.css('display', 'inline-flex').show();
      $statusText.text('运行中').css('color', 'var(--green, #4CAF50)');
      $timerDisplay.show();
    } else {
      $stopBtn.hide();
      $startBtn.css('display', 'inline-flex').show();
      $statusText.text('已停止').css('color', 'var(--red, #f44336)');
      $timerDisplay.hide().text('');
    }
  }

  /**
   * 更新循环倒计时显示
   */
  export function updateLoopTimerDisplay_ACU(timeLeftFormatted: string) {
    if (!$popupInstance_ACU) return;
    $popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-plot-loop-timer-display`).text(`(剩余: ${timeLeftFormatted})`);
  }


  // --- API / 设置 UI ---
  export function updateApiModeView_ACU(apiMode: string) {
    if (!$popupInstance_ACU) return;
    const $customApiBlock = $popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-custom-api-settings-block`);
    const $tavernApiBlock = $popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-tavern-api-profile-block`);

    if (apiMode === 'tavern') {
        $customApiBlock.hide();
        $tavernApiBlock.show();
        loadTavernApiProfiles_ACU();
    } else { // custom
        $customApiBlock.show();
        $tavernApiBlock.hide();
    }
  }

  export function updateCustomApiInputsState_ACU() {
    if (!$popupInstance_ACU) return;
    const useMainApi = settings_ACU.apiConfig.useMainApi;
    const $customApiFields = $popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-custom-api-fields`);
    if (useMainApi) {
        $customApiFields.css('opacity', '0.5');
        $customApiFields.find('input, select, button, textarea').prop('disabled', true);
    } else {
        $customApiFields.css('opacity', '1.0');
        $customApiFields.find('input, select, button, textarea').prop('disabled', false);
    }
  }

  export async function loadTavernApiProfiles_ACU() {
    if (!$popupInstance_ACU) return;
    const $select = $popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-tavern-api-profile-select`);
    const currentProfileId = settings_ACU.tavernProfile;
    
    $select.empty().append('<option value="">-- 请选择一个酒馆预设 --</option>');

    try {
        const tavernProfiles = getConnectionManagerProfiles_ACU();
        if (!tavernProfiles || tavernProfiles.length === 0) {
            $select.append(jQuery_API_ACU('<option>', { value: '', text: '未找到酒馆预设', disabled: true }));
            return;
        }

        let foundCurrentProfile = false;
        tavernProfiles.forEach(profile => {
            if (profile.api && profile.preset) { // Ensure it's a valid API profile
                const option = jQuery_API_ACU('<option>', {
                    value: profile.id,
                    text: profile.name || profile.id,
                    selected: profile.id === currentProfileId
                });
                $select.append(option);
                if (profile.id === currentProfileId) {
                    foundCurrentProfile = true;
                }
            }
        });

        if (currentProfileId && foundCurrentProfile) {
             $select.val(currentProfileId);
        }

    } catch (error) {
        logError_ACU('加载酒馆API预设失败:', error);
        showToastr_ACU('error', '无法加载酒馆API预设列表。');
    }
  }

  export function saveApiConfig_ACU() {
    if (!$popupInstance_ACU || !$customApiUrlInput_ACU || !$customApiKeyInput_ACU || !$customApiModelInput_ACU) {
      logError_ACU('保存API配置失败：UI元素未初始化。');
      return;
    }
    const url = String($customApiUrlInput_ACU.val() || '').trim();
    const apiKey = $customApiKeyInput_ACU.val() as string;
    const model = String($customApiModelInput_ACU.val() || '').trim();
    const max_tokens = parseInt($maxTokensInput_ACU.val() as string, 10);
    const temperature = parseFloat($temperatureInput_ACU.val() as string);


    if (!url) {
      showToastr_ACU('warning', 'API URL 不能为空。');
      return;
    }
    if (!model) {
      showToastr_ACU('warning', '请输入或选择一个模型。');
      return;
    }

    Object.assign(settings_ACU.apiConfig, {
        url,
        apiKey,
        model,
        max_tokens: isNaN(max_tokens) ? 120000 : max_tokens,
        temperature: isNaN(temperature) ? 0.9 : temperature,
        bodyParams: String($popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-api-body-params`).val() ?? ''),
        excludeBodyParams: String($popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-api-exclude-body-params`).val() ?? ''),
        requestHeaders: String($popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-api-request-headers`).val() ?? ''),
    });
    // 将新保存的模型添加到select中（如果不存在）
    if ($customApiModelSelect_ACU && $customApiModelSelect_ACU.find(`option[value="${escapeHtml_ACU(model)}"]`).length === 0) {
        $customApiModelSelect_ACU.append(`<option value="${escapeHtml_ACU(model)}">${escapeHtml_ACU(model)}</option>`);
    }
    saveSettingsAndNotify_ACU();
    showToastr_ACU('success', 'API配置已保存！');
    loadSettingsAndRefreshUI_ACU();
  }

  export function clearApiConfig_ACU() {
    Object.assign(settings_ACU.apiConfig, { url: '', apiKey: '', model: '', max_tokens: 120000, temperature: 0.9, bodyParams: '', excludeBodyParams: '', requestHeaders: '' });
    saveSettingsAndNotify_ACU();
    showToastr_ACU('info', 'API配置已清除！');
    loadSettingsAndRefreshUI_ACU();
  }

  // --- [新增] API预设管理函数 ---
  export function saveApiPreset_ACU(presetName: string) {
    if (!presetName || !presetName.trim()) {
      showToastr_ACU('warning', '请输入预设名称。');
      return false;
    }
    presetName = presetName.trim();
    
    const newPreset = {
      name: presetName,
      apiMode: settings_ACU.apiMode,
      apiConfig: JSON.parse(JSON.stringify(settings_ACU.apiConfig)),
      tavernProfile: settings_ACU.tavernProfile
    };
    
    // 检查是否已存在同名预设
    const existingIndex = settings_ACU.apiPresets.findIndex((p: any) => p.name === presetName);
    if (existingIndex >= 0) {
      settings_ACU.apiPresets[existingIndex] = newPreset;
      showToastr_ACU('success', `API预设 "${presetName}" 已更新。`);
    } else {
      settings_ACU.apiPresets.push(newPreset);
      showToastr_ACU('success', `API预设 "${presetName}" 已保存。`);
    }
    
    saveSettingsAndNotify_ACU();
    refreshApiPresetSelectors_ACU();
    return true;
  }

  export function loadApiPreset_ACU(presetName: string) {
    const preset = settings_ACU.apiPresets.find((p: any) => p.name === presetName);
    if (!preset) {
      showToastr_ACU('error', `未找到预设 "${presetName}"。`);
      return false;
    }
    
    settings_ACU.apiMode = preset.apiMode;
    settings_ACU.apiConfig = JSON.parse(JSON.stringify(preset.apiConfig));
    settings_ACU.tavernProfile = preset.tavernProfile;
    
    saveSettingsAndNotify_ACU();
    loadSettingsAndRefreshUI_ACU();
    showToastr_ACU('success', `已加载API预设 "${presetName}"。`);
    return true;
  }

  export function deleteApiPreset_ACU(presetName: string) {
    const index = settings_ACU.apiPresets.findIndex((p: any) => p.name === presetName);
    if (index < 0) {
      showToastr_ACU('error', `未找到预设 "${presetName}"。`);
      return false;
    }
    
    settings_ACU.apiPresets.splice(index, 1);
    
    // 清除使用该预设的引用
    if (settings_ACU.tableApiPreset === presetName) {
      settings_ACU.tableApiPreset = '';
    }
    if (settings_ACU.plotApiPreset === presetName) {
      settings_ACU.plotApiPreset = '';
    }
    const vectorMemoryConfig = getCurrentVectorMemoryConfig_ACU();
    if (vectorMemoryConfig.keywordApiPreset === presetName) {
      vectorMemoryConfig.keywordApiPreset = '';
    }
    // [新增] 清除按表名保存的表级 API 预设覆盖中引用了该预设的条目
    if (settings_ACU.tableApiPresetOverridesByName && typeof settings_ACU.tableApiPresetOverridesByName === 'object') {
      const overrides = settings_ACU.tableApiPresetOverridesByName;
      Object.keys(overrides).forEach((tableName: string) => {
        if (overrides[tableName] === presetName) {
          delete overrides[tableName];
        }
      });
    }
    
    saveSettingsAndNotify_ACU();
    refreshApiPresetSelectors_ACU();
    showToastr_ACU('info', `API预设 "${presetName}" 已删除。`);
    return true;
  }

  export function refreshApiPresetSelectors_ACU() {
    if (!$popupInstance_ACU) return;
    
    const presets = settings_ACU.apiPresets || [];
    
    // 刷新API配置页面的预设选择器
    const $apiPresetSelect = $popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-api-preset-select`);
    if ($apiPresetSelect.length) {
      $apiPresetSelect.empty().append('<option value="">-- 选择预设 --</option>');
      presets.forEach((p: any) => {
$apiPresetSelect.append(renderOption_ACU(p.name, p.name));
      });
    }
    
    // 刷新填表的API预设选择器
    const $tableApiPresetSelect = $popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-table-api-preset-select`);
    if ($tableApiPresetSelect.length) {
      $tableApiPresetSelect.empty().append('<option value="">使用当前API配置</option>');
      presets.forEach((p: any) => {
$tableApiPresetSelect.append(renderOption_ACU(p.name, p.name));
      });
      $tableApiPresetSelect.val(settings_ACU.tableApiPreset || '');
    }
    
    // 刷新剧情推进的API预设选择器
    const $plotApiPresetSelect = $popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-plot-api-preset-select`);
    if ($plotApiPresetSelect.length) {
      $plotApiPresetSelect.empty().append('<option value="">使用当前API配置</option>');
      presets.forEach((p: any) => {
$plotApiPresetSelect.append(renderOption_ACU(p.name, p.name));
      });
      $plotApiPresetSelect.val(settings_ACU.plotApiPreset || '');
    }

    // 刷新任务级数据库API预设选择器
    const $plotTaskApiPresetSelect = $popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-plot-task-api-preset`);
    if ($plotTaskApiPresetSelect.length) {
      const currentTaskApiPreset = $plotTaskApiPresetSelect.val() || '';
      $plotTaskApiPresetSelect.empty().append('<option value="">继承全局剧情推进API预设</option>');
      presets.forEach((p: any) => {
$plotTaskApiPresetSelect.append(renderOption_ACU(p.name, p.name));
      });
      $plotTaskApiPresetSelect.val(currentTaskApiPreset);
      refreshCurrentPlotTaskApiPresetSelect_ACU();
    }

    // 刷新正文替换的API预设选择器
    const $optimizationApiPresetSelect = $popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-optimization-api-preset`);
    if ($optimizationApiPresetSelect.length) {
      $optimizationApiPresetSelect.empty().append('<option value="">使用当前API配置</option>');
      presets.forEach((p: any) => {
$optimizationApiPresetSelect.append(renderOption_ACU(p.name, p.name));
      });
      $optimizationApiPresetSelect.val(settings_ACU.contentOptimizationSettings?.apiPreset || '');
    }

    // 刷新交火关键词生成的 API 预设选择器
    const $keywordApiPresetSelect = $popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-worldbook-vector-memory-keyword-api-preset`);
    if ($keywordApiPresetSelect.length) {
      const vectorMemoryConfig = getCurrentVectorMemoryConfig_ACU();
      const currentKeywordPreset = String(vectorMemoryConfig.keywordApiPreset || $keywordApiPresetSelect.val() || '');
      $keywordApiPresetSelect.empty().append('<option value="">使用当前API配置</option>');
      presets.forEach((p: any) => {
$keywordApiPresetSelect.append(renderOption_ACU(p.name, p.name));
      });
      $keywordApiPresetSelect.val(currentKeywordPreset);
    }

    // [新增] 刷新可视化编辑器配置面板中的表级 API 预设覆盖选择器
    // 该 select 可能不在 popup 中，而是在可视化编辑器容器里
    const $cfgTableApiPreset = jQuery_API_ACU('#cfg-table-api-preset');
    if ($cfgTableApiPreset.length) {
      const currentVal = String($cfgTableApiPreset.val() || '');
      $cfgTableApiPreset.empty().append('<option value="">使用填表整体API配置</option>');
      presets.forEach((p: any) => {
        $cfgTableApiPreset.append(renderOption_ACU(p.name, p.name));
      });
      $cfgTableApiPreset.val(currentVal);
    }
  }

  /**
   * 根据预设名称获取API配置
   * @param {string} presetName - 预设名称，空字符串表示使用当前配置
   * @returns {object} - 包含 apiMode, apiConfig, tavernProfile 的配置对象
   */

