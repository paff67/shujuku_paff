// service/ai/api-call.ts — AI 调用编排（剧情推进用）
// 从 04_shared_helpers.js 迁入

import { handleApiResponse_ACU } from './prompt-builder';
import { currentChatFileIdentifier_ACU, settings_ACU } from '../runtime/state-manager';
import { isGenerateRawAvailable_ACU, generateRaw_ACU, sendConnectionManagerRequest_ACU, getHostRequestHeaders_ACU } from '../../data/gateways/ai-gateway';
import { logDebug_ACU, logWarn_ACU } from '../../shared/utils';

/**
 * 剧情推进任务级 API 调用 — 接受显式预设名称
 * 调用优先级：presetName 参数 > 全局 plotApiPreset > 当前 API 配置
 */
export async function callApiWithPlotPreset_ACU(messages: any[], presetName: string, abortSignal: AbortSignal | null = null) {
    const effectivePresetName = presetName || settings_ACU.plotApiPreset || '';
    const apiPresetConfig = getApiConfigByPreset_ACU(effectivePresetName);
    const effectiveApiMode = apiPresetConfig.apiMode ?? settings_ACU.apiMode;
    const effectiveApiConfig = apiPresetConfig.apiConfig || settings_ACU.apiConfig || {};

    logDebug_ACU(`[剧情推进] 任务级API调用，预设: ${effectivePresetName || '当前配置'}, 模式: ${effectiveApiMode}`);

    if (effectiveApiMode === 'tavern' || effectiveApiConfig.useMainApi) {
      logDebug_ACU('[剧情推进] 通过酒馆主API发送请求（流式传输）...');
      if (!isGenerateRawAvailable_ACU()) {
        throw new Error('TavernHelper.generateRaw 函数不存在。请检查酒馆版本。');
      }
      const response = await generateRaw_ACU({
        ordered_prompts: messages,
        should_stream: settings_ACU.streamingEnabled || false,
      });
      if (typeof response !== 'string') {
        throw new Error('主API调用未返回预期的文本响应。');
      }
      return response.trim();
    } else {
      if (!effectiveApiConfig.url || !effectiveApiConfig.model) {
        throw new Error('自定义API的URL或模型未配置。');
      }

      const requestBody = {
        messages: messages,
        model: effectiveApiConfig.model.replace(/^models\//, ''),
        max_tokens: effectiveApiConfig.maxTokens || effectiveApiConfig.max_tokens || 20000,
        temperature: effectiveApiConfig.temperature || 0.7,
        top_p: effectiveApiConfig.topP || effectiveApiConfig.top_p || 0.95,
        stream: settings_ACU.streamingEnabled || false,
        chat_completion_source: 'custom',
        group_names: [] as string[],
        include_reasoning: false,
        reasoning_effort: 'medium',
        enable_web_search: false,
        request_images: false,
        custom_prompt_post_processing: 'strict',
        reverse_proxy: effectiveApiConfig.url,
        proxy_password: '',
        custom_url: effectiveApiConfig.url,
        custom_include_headers: effectiveApiConfig.apiKey ? `Authorization: Bearer ${effectiveApiConfig.apiKey}` : '',
      };

      const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: { ...getHostRequestHeaders_ACU(), 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!response.ok) {
        const errTxt = await response.text();
        throw new Error(`API请求失败: ${response.status} ${errTxt}`);
      }

      const content = await handleApiResponse_ACU(response, abortSignal);
      if (content) {
        return content.trim();
      }

      throw new Error(`API调用返回无效响应`);
    }
}

export   async function callApi_ACU(messages: any[], apiSettings: any, abortSignal: AbortSignal | null = null) {
    // [新增] 获取剧情推进使用的API配置（支持API预设）
    const apiPresetConfig = getApiConfigByPreset_ACU(settings_ACU.plotApiPreset);
    const effectiveApiMode = apiPresetConfig.apiMode;
    const effectiveApiConfig = apiPresetConfig.apiConfig;
    
    logDebug_ACU(`[剧情推进] 使用API预设: ${settings_ACU.plotApiPreset || '当前配置'}, 模式: ${effectiveApiMode}`);

    if (effectiveApiMode === 'tavern' || effectiveApiConfig.useMainApi) {
      // 使用主API或酒馆预设（流式传输）
      logDebug_ACU('[剧情推进] 通过酒馆主API发送请求（流式传输）...');
      if (!isGenerateRawAvailable_ACU()) {
        throw new Error('TavernHelper.generateRaw 函数不存在。请检查酒馆版本。');
      }
      const response = await generateRaw_ACU({
        ordered_prompts: messages,
        should_stream: settings_ACU.streamingEnabled || false,
      });
      if (typeof response !== 'string') {
        throw new Error('主API调用未返回预期的文本响应。');
      }
      return response.trim();
    } else {
      // 使用自定义API（流式传输）
      if (!effectiveApiConfig.url || !effectiveApiConfig.model) {
        throw new Error('自定义API的URL或模型未配置。');
      }

      const requestBody = {
        messages: messages,
        model: effectiveApiConfig.model.replace(/^models\//, ''),
        max_tokens: effectiveApiConfig.maxTokens || effectiveApiConfig.max_tokens || 20000,
        temperature: effectiveApiConfig.temperature || 0.7,
        top_p: effectiveApiConfig.topP || effectiveApiConfig.top_p || 0.95,
        stream: settings_ACU.streamingEnabled || false,
        chat_completion_source: 'custom',
        group_names: [] as string[],
        include_reasoning: false,
        reasoning_effort: 'medium',
        enable_web_search: false,
        request_images: false,
        custom_prompt_post_processing: 'strict',
        reverse_proxy: effectiveApiConfig.url,
        proxy_password: '',
        custom_url: effectiveApiConfig.url,
        custom_include_headers: effectiveApiConfig.apiKey ? `Authorization: Bearer ${effectiveApiConfig.apiKey}` : '',
      };

      const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: { ...getHostRequestHeaders_ACU(), 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!response.ok) {
        const errTxt = await response.text();
        throw new Error(`API请求失败: ${response.status} ${errTxt}`);
      }

      // 根据streamingEnabled设置选择响应处理方式
      const content = await handleApiResponse_ACU(response, abortSignal);
      if (content) {
        return content.trim();
      }

      throw new Error(`API调用返回无效响应`);
    }
  }


export   function getApiConfigByPreset_ACU(presetName: string) {
    if (!presetName) {
      // 使用当前配置
      return {
        apiMode: settings_ACU.apiMode,
        apiConfig: settings_ACU.apiConfig,
        tavernProfile: settings_ACU.tavernProfile
      };
    }
    
    const preset = settings_ACU.apiPresets.find((p: any) => p.name === presetName);
    if (preset) {
      return {
        apiMode: preset.apiMode,
        apiConfig: preset.apiConfig,
        tavernProfile: preset.tavernProfile
      };
    }
    
    // 预设不存在，回退到当前配置
    logWarn_ACU(`API预设 "${presetName}" 不存在，使用当前配置。`);
    return {
      apiMode: settings_ACU.apiMode,
      apiConfig: settings_ACU.apiConfig,
      tavernProfile: settings_ACU.tavernProfile
    };
  }

export function resolveCurrentChatApiPresetName_ACU(chatId = currentChatFileIdentifier_ACU): string {
    const presets = Array.isArray(settings_ACU.apiPresets) ? settings_ACU.apiPresets : [];
    const exists = (name: string) => !!name && presets.some((p: any) => p?.name === name);
    const chatKey = String(chatId || '').trim() || 'unknown_chat';
    const bindings = settings_ACU.apiPresetBindingsByChat;
    const bindingName = bindings && typeof bindings === 'object' && !Array.isArray(bindings)
        ? String(bindings[chatKey]?.presetName || '').trim()
        : '';
    if (exists(bindingName)) return bindingName;
    const defaultName = String(settings_ACU.defaultApiPresetName || '').trim();
    if (exists(defaultName)) return defaultName;
    return '';
}

export function applyCurrentChatApiPresetSelection_ACU(chatId = currentChatFileIdentifier_ACU): string {
    const presetName = resolveCurrentChatApiPresetName_ACU(chatId);
    if (!presetName) return '';
    const preset = Array.isArray(settings_ACU.apiPresets)
        ? settings_ACU.apiPresets.find((p: any) => p?.name === presetName)
        : null;
    if (!preset) return '';
    settings_ACU.apiMode = preset.apiMode === 'tavern' ? 'tavern' : 'custom';
    settings_ACU.apiConfig = JSON.parse(JSON.stringify(preset.apiConfig || {}));
    settings_ACU.tavernProfile = typeof preset.tavernProfile === 'string' ? preset.tavernProfile : '';
    return presetName;
}


export   async function callCustomOpenAI_ACU_Direct(messages: any[]) {
      // Reuse the logic from callCustomOpenAI_ACU but bypass the prompt replacement part
      // ... For brevity, I will just call callCustomOpenAI_ACU with a hacked dynamicContent?
      // No, callCustomOpenAI_ACU relies on settings_ACU.charCardPrompt.
      // I should refactor callCustomOpenAI_ACU to accept direct messages, or duplicate the API calling part.
      
      // Duplicating API calling logic for safety and isolation
      if (settings_ACU.apiMode === 'tavern') {
          const profileId = settings_ACU.tavernProfile;
          return await sendConnectionManagerRequest_ACU(
                profileId, messages, settings_ACU.apiConfig.max_tokens || 4096
          ).then(r => r.result.choices[0].message.content);
      } else {
          // Custom API（流式传输）
          if (settings_ACU.apiConfig.useMainApi) {
             return await generateRaw_ACU({ ordered_prompts: messages, should_stream: settings_ACU.streamingEnabled || false });
          } else {
             const url = `/api/backends/chat-completions/generate`;
             const body = JSON.stringify({
                 messages: messages,
                 model: settings_ACU.apiConfig.model,
                 max_tokens: settings_ACU.apiConfig.max_tokens,
                 stream: settings_ACU.streamingEnabled || false,
                 chat_completion_source: "custom",
                 // ... other params
                 reverse_proxy: settings_ACU.apiConfig.url,
                 custom_url: settings_ACU.apiConfig.url,
                 custom_include_headers: settings_ACU.apiConfig.apiKey ? `Authorization: Bearer ${settings_ACU.apiConfig.apiKey}` : ""
             });
             const res = await fetch(url, { method: 'POST', headers: {...getHostRequestHeaders_ACU(), 'Content-Type': 'application/json'}, body });
             // 根据streamingEnabled设置选择响应处理方式
             const content = await handleApiResponse_ACU(res);
             return content;
          }
      }
  }


/**
 * 通用 AI 调用（支持指定 API 预设名称）
 * 供 service 层内部使用，替代通过 topLevelWindow_ACU.AutoCardUpdaterAPI.callAI 的循环调用。
 * @param messages 消息数组 [{ role, content }]
 * @param presetName API 预设名称（空字符串表示使用当前配置）
 * @returns AI 响应文本，失败返回 null
 */
export async function callAIWithPreset_ACU(messages: any[], presetName: string = ''): Promise<string | null> {
    if (!Array.isArray(messages) || messages.length === 0) {
        logWarn_ACU('[callAIWithPreset] messages 必须是非空数组');
        return null;
    }

    const apiPresetConfig = getApiConfigByPreset_ACU(presetName);
    const effectiveApiMode = apiPresetConfig.apiMode;
    const effectiveApiConfig = apiPresetConfig.apiConfig || {} as any;
    const effectiveTavernProfile = apiPresetConfig.tavernProfile;
    const maxTokens = effectiveApiConfig.max_tokens || effectiveApiConfig.maxTokens || 4096;

    logDebug_ACU(`[callAIWithPreset] 调用 AI，消息数=${messages.length}，预设=${presetName || '当前配置'}，模式=${effectiveApiMode}`);

    if (effectiveApiMode === 'tavern') {
        const profileId = effectiveTavernProfile || settings_ACU.tavernProfile;
        const response = await sendConnectionManagerRequest_ACU(profileId, messages, maxTokens);
        if (response?.result?.choices?.[0]?.message?.content) {
            return response.result.choices[0].message.content;
        }
        if (response && typeof response.content === 'string') {
            return response.content;
        }
        logWarn_ACU('[callAIWithPreset] 酒馆 API 返回无效响应');
        return null;
    }

    if (effectiveApiConfig.useMainApi) {
        if (!isGenerateRawAvailable_ACU()) {
            throw new Error('TavernHelper.generateRaw 函数不存在。请检查酒馆版本。');
        }
        const response = await generateRaw_ACU({
            ordered_prompts: messages,
            should_stream: settings_ACU.streamingEnabled || false,
        });
        return typeof response === 'string' ? response.trim() : null;
    }

    if (!effectiveApiConfig.url || !effectiveApiConfig.model) {
        throw new Error('自定义API的URL或模型未配置。');
    }

    const body = JSON.stringify({
        messages,
        model: effectiveApiConfig.model,
        temperature: effectiveApiConfig.temperature || 1.0,
        top_p: effectiveApiConfig.top_p || 0.9,
        max_tokens: maxTokens,
        stream: settings_ACU.streamingEnabled || false,
        chat_completion_source: 'custom',
        group_names: [],
        include_reasoning: false,
        reasoning_effort: 'medium',
        enable_web_search: false,
        request_images: false,
        custom_prompt_post_processing: 'strict',
        reverse_proxy: effectiveApiConfig.url,
        proxy_password: '',
        custom_url: effectiveApiConfig.url,
        custom_include_headers: effectiveApiConfig.apiKey ? `Authorization: Bearer ${effectiveApiConfig.apiKey}` : '',
    });

    const res = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: { ...getHostRequestHeaders_ACU(), 'Content-Type': 'application/json' },
        body,
    });

    if (!res.ok) {
        const errTxt = await res.text();
        throw new Error(`API请求失败: ${res.status} ${errTxt}`);
    }

    const content = await handleApiResponse_ACU(res);
    return content ? content.trim() : null;
}
