import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/service/runtime/state-manager', () => ({
  settings_ACU: { streamingEnabled: true },
}));

vi.mock('../../../src/shared/utils', () => ({
  logWarn_ACU: vi.fn(),
}));

import {
  buildCustomApiRequestBody_ACU,
  parseCustomApiBodyParams_ACU,
  parseCustomApiExcludeBodyParams_ACU,
  parseCustomApiRequestHeaders_ACU,
} from '../../../src/service/ai/custom-api-request';

describe('custom-api-request', () => {
  it('bodyParams 优先支持 JSON object，并保留值类型', () => {
    expect(parseCustomApiBodyParams_ACU('{"top_p":0.8,"enable_web_search":true,"metadata":{"a":1}}')).toEqual({
      top_p: 0.8,
      enable_web_search: true,
      metadata: { a: 1 },
    });
  });

  it('bodyParams 兼容 key:value / key=value 行格式', () => {
    expect(parseCustomApiBodyParams_ACU('top_p: 0.7\nflag=true\nname: test')).toEqual({
      top_p: 0.7,
      flag: true,
      name: 'test',
    });
  });

  it('excludeBodyParams 支持 JSON 数组和逗号列表', () => {
    expect(parseCustomApiExcludeBodyParams_ACU('["stream","top_p"]')).toEqual(['stream', 'top_p']);
    expect(parseCustomApiExcludeBodyParams_ACU('stream, top_p\nrequest_images')).toEqual(['stream', 'top_p', 'request_images']);
  });

  it('requestHeaders 支持 JSON object 和 Header 行格式', () => {
    expect(parseCustomApiRequestHeaders_ACU('{"X-Test":"yes"}')).toEqual({ 'X-Test': 'yes' });
    expect(parseCustomApiRequestHeaders_ACU('X-Test: yes\nX-Trace=abc')).toEqual({ 'X-Test': 'yes', 'X-Trace': 'abc' });
  });

  it('构建请求体时合并附加参数、移除排除字段，并允许 requestHeaders 覆盖 Authorization', () => {
    const body = buildCustomApiRequestBody_ACU(
      [{ role: 'user', content: 'hello' }],
      {
        url: 'https://api.example.com/v1',
        apiKey: 'sk-default',
        model: 'models/test-model',
        max_tokens: 2048,
        temperature: 0.5,
        bodyParams: '{"top_p":0.6,"reasoning_effort":"high","custom_flag":true}',
        excludeBodyParams: 'request_images,enable_web_search',
        requestHeaders: '{"Authorization":"Bearer sk-custom","X-Extra":"1"}',
      },
      { stripModelPrefix: true },
    );

    expect(body.model).toBe('test-model');
    expect(body.max_tokens).toBe(2048);
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.6);
    expect(body.reasoning_effort).toBe('high');
    expect(body.custom_flag).toBe(true);
    expect(body.request_images).toBeUndefined();
    expect(body.enable_web_search).toBeUndefined();
    expect(body.custom_include_headers).toContain('Authorization: Bearer sk-custom');
    expect(body.custom_include_headers).toContain('X-Extra: 1');
    expect(body.custom_include_headers).not.toContain('sk-default');
  });
});
