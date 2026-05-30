/**
 * presentation/bootstrap/api-groups/worldbook-ai-api.ts
 * 世界书操作 + 正文优化 + AI 调用 API
 */

import { topLevelWindow_ACU } from '../../../shared/env';
import { logDebug_ACU, logError_ACU } from '../../../shared/utils';
import { sendConnectionManagerRequest_ACU, generateRaw_ACU, isGenerateRawAvailable_ACU, getHostRequestHeaders_ACU } from '../../../service/ai/ai-service';
import { getChatArray_ACU } from '../../../service/chat/chat-service';
import {
    settings_ACU,
    currentJsonTableData_ACU,
} from '../../../service/runtime/state-manager';
import { setZeroTkOccupyMode_ACU } from '../../../service/settings/settings-service';
import { deleteAllGeneratedEntries_ACU, updateReadableLorebookEntry_ACU } from '../../../service/worldbook/pipeline';
import { updateOutlineTableEntry_ACU } from '../../../service/worldbook/injection-engine';
import { formatJsonToReadable_ACU } from '../../../service/runtime/helpers-remaining';
import { getApiConfigByPreset_ACU } from '../../../service/ai/api-call';
import { handleApiResponse_ACU } from '../../../service/ai/prompt-builder';
import { buildCustomApiRequestBody_ACU } from '../../../service/ai/custom-api-request';
import { cancelContentOptimization_ACU } from '../../../service/optimization/content-optimization';
import { reoptimizeMessage_ACU } from '../../components/optimization-ui';
import { refreshMergedDataAndNotifyWithUI_ACU } from '../../components/pipeline-ui-helpers';
import { showToastr_ACU } from '../../theme/toast';
import type { ApiGroupContext } from './callback-api';

declare const SillyTavern: any;

export function createWorldbookAiApi(_ctx: ApiGroupContext): Record<string, Function> {
    return {
        // 即时同步世界书注入条目
        syncWorldbookEntries: async function({ createIfNeeded = true } = {}) {
            try {
                await updateReadableLorebookEntry_ACU(!!createIfNeeded, false);
                return true;
            } catch (e) {
                logError_ACU('syncWorldbookEntries failed:', e);
                return false;
            }
        },

        // 强制刷新数据并重新注入世界书
        refreshDataAndWorldbook: async function() {
            try {
                await refreshMergedDataAndNotifyWithUI_ACU();
                logDebug_ACU('refreshDataAndWorldbook: Data refreshed and worldbook updated successfully.');
                return true;
            } catch (e) {
                logError_ACU('refreshDataAndWorldbook failed:', e);
                return false;
            }
        },

        reoptimizeMessage: async function(messageIndex: any) {
            try {
                return await reoptimizeMessage_ACU(messageIndex);
            } catch (e) {
                logError_ACU('reoptimizeMessage failed:', e);
                return false;
            }
        },

        cancelContentOptimization: function(reason: any) {
            try {
                const result = cancelContentOptimization_ACU(reason);
                if (result.cancelled) showToastr_ACU('warning', result.reason);
                return result.cancelled;
            } catch (e) {
                logError_ACU('cancelContentOptimization failed:', e);
                return false;
            }
        },

        // 删除注入条目
        deleteInjectedEntries: async function() {
            try {
                await deleteAllGeneratedEntries_ACU();
                return true;
            } catch (e) {
                logError_ACU('deleteInjectedEntries failed:', e);
                return false;
            }
        },

        // 设置 OutlineTable 条目启用状态
        setOutlineEntryEnabled: async function(enabled: any) {
            try {
                const isEnabled = !!enabled;
                setZeroTkOccupyMode_ACU(!isEnabled);
                if (currentJsonTableData_ACU) {
                    const { outlineTable } = formatJsonToReadable_ACU(currentJsonTableData_ACU);
                    await updateOutlineTableEntry_ACU(outlineTable, false);
                }
                return true;
            } catch (e) {
                logError_ACU('setOutlineEntryEnabled failed:', e);
                return false;
            }
        },

        // 设置 0TK占用模式
        setZeroTkOccupyMode: async function(modeEnabled: any) {
            try {
                setZeroTkOccupyMode_ACU(!!modeEnabled);
                if (currentJsonTableData_ACU) {
                    const { outlineTable } = formatJsonToReadable_ACU(currentJsonTableData_ACU);
                    await updateOutlineTableEntry_ACU(outlineTable, false);
                }
                return true;
            } catch (e) {
                logError_ACU('setZeroTkOccupyMode failed:', e);
                return false;
            }
        },

        // AI 调用
        callAI: async function(messages: any[], options: any = {}) {
            try {
                if (!Array.isArray(messages) || messages.length === 0) {
                    logError_ACU('callAI: messages must be a non-empty array');
                    return null;
                }

                const presetName = options.presetName || '';
                const apiPresetConfig = getApiConfigByPreset_ACU(presetName);
                const effectiveApiMode = apiPresetConfig.apiMode;
                const effectiveApiConfig = apiPresetConfig.apiConfig || {};
                const effectiveTavernProfile = apiPresetConfig.tavernProfile;

                logDebug_ACU(`[callAI] Calling AI with ${messages.length} messages, preset: ${presetName || '当前配置'}, mode: ${effectiveApiMode}`);

                const maxTokensRaw = options.max_tokens ?? options.maxTokens ?? effectiveApiConfig.max_tokens ?? effectiveApiConfig.maxTokens ?? 4096;
                const maxTokensNumber = Number(maxTokensRaw);
                const maxTokens = Number.isFinite(maxTokensNumber) && maxTokensNumber > 0
                    ? Math.trunc(maxTokensNumber)
                    : 4096;

                if (effectiveApiMode === 'tavern') {
                    const profileId = effectiveTavernProfile || settings_ACU.tavernProfile;
                    const response = await sendConnectionManagerRequest_ACU(
                        profileId, messages, maxTokens
                    );
                    if (response && response.result && response.result.choices && response.result.choices[0]) {
                        return response.result.choices[0].message.content;
                    }
                    if (response && typeof response.content === 'string') {
                        return response.content;
                    }
                    logError_ACU('[callAI] Invalid response from Tavern API:', response);
                    return null;
                } else {
                    if (effectiveApiConfig.useMainApi) {
                        if (isGenerateRawAvailable_ACU()) {
                            const response = await generateRaw_ACU({
                                ordered_prompts: messages,
                                should_stream: settings_ACU.streamingEnabled || false
                            });
                            if (typeof response === 'string') {
                                return response.trim();
                            }
                            logError_ACU('[callAI] Main API did not return string');
                            return null;
                        }
                        logError_ACU('[callAI] TavernHelper.generateRaw not available');
                        return null;
                    } else {
                        if (!effectiveApiConfig.url || !effectiveApiConfig.model) {
                            logError_ACU('[callAI] Custom API URL or model not configured');
                            return null;
                        }

                        const url = `/api/backends/chat-completions/generate`;
                        const body = JSON.stringify(buildCustomApiRequestBody_ACU(messages, effectiveApiConfig, {
                            maxTokens,
                            temperature: effectiveApiConfig.temperature ?? 1.0,
                            topP: effectiveApiConfig.top_p ?? effectiveApiConfig.topP ?? 0.9,
                            stripModelPrefix: false,
                        }));

                        const headers = {
                            ...getHostRequestHeaders_ACU(),
                            'Content-Type': 'application/json'
                        };
                        const res = await fetch(url, { method: 'POST', headers, body });

                        if (!res.ok) {
                            const errTxt = await res.text();
                            logError_ACU('[callAI] API request failed:', res.status, errTxt);
                            return null;
                        }

                        const content = await handleApiResponse_ACU(res);
                        if (content) {
                            return content;
                        }
                        logError_ACU('[callAI] Invalid response from custom API');
                        return null;
                    }
                }
            } catch (e) {
                logError_ACU('[callAI] Failed:', e);
                return null;
            }
        },

        // 获取最近剧情上下文
        getStoryContext: function(maxTurns = 3) {
            try {
                const chat = getChatArray_ACU();
                if (!Array.isArray(chat) || chat.length === 0) {
                    return '';
                }

                const aiMessages = [];
                let turnCount = 0;

                for (let i = chat.length - 1; i >= 0 && turnCount < maxTurns; i--) {
                    const msg = chat[i];
                    if (msg && !msg.is_user && msg.mes) {
                        aiMessages.unshift(msg.mes);
                        turnCount++;
                    }
                }

                return aiMessages.join('\n\n');
            } catch (e) {
                logError_ACU('getStoryContext failed:', e);
                return '';
            }
        },
    };
}
