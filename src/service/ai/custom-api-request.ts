import { settings_ACU } from '../runtime/state-manager';
import { logWarn_ACU } from '../../shared/utils';

export interface BuildCustomApiRequestBodyOptions_ACU {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stripModelPrefix?: boolean;
  stream?: boolean;
}

function isPlainObject_ACU(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJson_ACU(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function coerceLineValue_ACU(raw: string): any {
  const value = raw.trim();
  if (value === '') return '';
  const parsed = parseJson_ACU(value);
  if (parsed !== undefined) return parsed;
  if (/^-?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return value;
}

function parseKeyValueLines_ACU(raw: string, options: { headerMode?: boolean } = {}): Record<string, any> {
  const result: Record<string, any> = {};
  if (!raw || typeof raw !== 'string') return result;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const colonIndex = trimmed.indexOf(':');
    const eqIndex = trimmed.indexOf('=');
    const splitIndex = colonIndex > 0
      ? colonIndex
      : (eqIndex > 0 ? eqIndex : -1);
    if (splitIndex <= 0) continue;
    const key = trimmed.slice(0, splitIndex).trim();
    const value = trimmed.slice(splitIndex + 1).trim();
    if (!key) continue;
    result[key] = options.headerMode ? value : coerceLineValue_ACU(value);
  }
  return result;
}

export function parseCustomApiBodyParams_ACU(raw: unknown): Record<string, any> {
  if (isPlainObject_ACU(raw)) return { ...raw };
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return {};

  const parsed = parseJson_ACU(text);
  if (isPlainObject_ACU(parsed)) return parsed;
  if (parsed !== undefined) {
    logWarn_ACU('[CustomAPI] bodyParams 必须是 JSON object；已回退到 key:value 行解析。');
  }
  return parseKeyValueLines_ACU(text);
}

export function parseCustomApiExcludeBodyParams_ACU(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(item => String(item || '').trim()).filter(Boolean);
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return [];

  const parsed = parseJson_ACU(text);
  if (Array.isArray(parsed)) {
    return parsed.map(item => String(item || '').trim()).filter(Boolean);
  }
  if (isPlainObject_ACU(parsed)) {
    return Object.keys(parsed).map(key => key.trim()).filter(Boolean);
  }
  if (parsed !== undefined) {
    logWarn_ACU('[CustomAPI] excludeBodyParams 必须是 JSON array；已回退到逗号/换行解析。');
  }
  return text.split(/[,\n\r]+/).map(item => item.trim()).filter(Boolean);
}

export function parseCustomApiRequestHeaders_ACU(raw: unknown): Record<string, string> {
  if (isPlainObject_ACU(raw)) {
    return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value ?? '')]));
  }
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return {};

  const parsed = parseJson_ACU(text);
  if (isPlainObject_ACU(parsed)) {
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value ?? '')]));
  }
  if (parsed !== undefined) {
    logWarn_ACU('[CustomAPI] requestHeaders 必须是 JSON object；已回退到 Header: value 行解析。');
  }
  return Object.fromEntries(
    Object.entries(parseKeyValueLines_ACU(text, { headerMode: true }))
      .map(([key, value]) => [key, String(value ?? '')]),
  );
}

export function buildCustomApiIncludeHeaders_ACU(effectiveApiConfig: any): string {
  const headerMap = new Map<string, { name: string; value: string }>();
  const setHeader = (name: string, value: string) => {
    const key = String(name || '').trim();
    if (!key) return;
    headerMap.set(key.toLowerCase(), { name: key, value: String(value ?? '').trim() });
  };

  if (effectiveApiConfig?.apiKey) {
    setHeader('Authorization', `Bearer ${effectiveApiConfig.apiKey}`);
  }
  const extraHeaders = parseCustomApiRequestHeaders_ACU(effectiveApiConfig?.requestHeaders);
  for (const [key, value] of Object.entries(extraHeaders)) {
    setHeader(key, value);
  }

  return Array.from(headerMap.values())
    .filter(header => header.value !== '')
    .map(header => `${header.name}: ${header.value}`)
    .join('\n');
}

export function buildCustomApiRequestBody_ACU(
  messages: any[],
  effectiveApiConfig: any,
  overrides: BuildCustomApiRequestBodyOptions_ACU = {},
): Record<string, any> {
  const model = overrides.stripModelPrefix !== false
    ? String(effectiveApiConfig?.model || '').replace(/^models\//, '')
    : String(effectiveApiConfig?.model || '');
  const maxTokens = overrides.maxTokens
    ?? effectiveApiConfig?.max_tokens
    ?? effectiveApiConfig?.maxTokens
    ?? 20000;
  const temperature = overrides.temperature
    ?? effectiveApiConfig?.temperature
    ?? 1.0;
  const topP = overrides.topP
    ?? effectiveApiConfig?.top_p
    ?? effectiveApiConfig?.topP
    ?? 0.95;

  const body: Record<string, any> = {
    messages,
    model,
    max_tokens: maxTokens,
    temperature,
    top_p: topP,
    stream: overrides.stream ?? settings_ACU.streamingEnabled ?? false,
    chat_completion_source: 'custom',
    group_names: [],
    include_reasoning: false,
    reasoning_effort: 'medium',
    enable_web_search: false,
    request_images: false,
    custom_prompt_post_processing: 'strict',
    reverse_proxy: effectiveApiConfig?.url || '',
    proxy_password: '',
    custom_url: effectiveApiConfig?.url || '',
    custom_include_headers: buildCustomApiIncludeHeaders_ACU(effectiveApiConfig),
  };

  Object.assign(body, parseCustomApiBodyParams_ACU(effectiveApiConfig?.bodyParams));
  for (const key of parseCustomApiExcludeBodyParams_ACU(effectiveApiConfig?.excludeBodyParams)) {
    delete body[key];
  }

  return body;
}
