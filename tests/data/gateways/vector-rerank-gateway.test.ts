/**
 * tests/data/gateways/vector-rerank-gateway.test.ts
 * Rerank Gateway — instruction 字段兼容测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('../../../src/data/gateways/ai-gateway', () => ({
    getHostRequestHeaders_ACU: () => ({}),
}));

import { createRerankScores_ACU } from '../../../src/data/gateways/vector-rerank-gateway';

beforeEach(() => {
    vi.clearAllMocks();
});

function mockOkResponse(results: any[]) {
    mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results }),
    });
}

describe('createRerankScores_ACU', () => {
    const baseRequest = {
        endpoint: 'https://rerank.test/v1/rerank',
        model: 'bge-reranker-v2-m3',
        query: 'test query',
        documents: ['doc1', 'doc2'],
    };

    it('instruction 非空时写入请求体', async () => {
        mockOkResponse([{ index: 0, relevance_score: 0.9 }]);

        await createRerankScores_ACU({
            ...baseRequest,
            instruction: '按相关性降序排列',
        });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.instruction).toBe('按相关性降序排列');
        expect(body.model).toBe('bge-reranker-v2-m3');
        expect(body.query).toBe('test query');
        expect(body.documents).toEqual(['doc1', 'doc2']);
    });

    it('instruction 为空字符串时不写入请求体', async () => {
        mockOkResponse([{ index: 0, relevance_score: 0.8 }]);

        await createRerankScores_ACU({
            ...baseRequest,
            instruction: '',
        });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body).not.toHaveProperty('instruction');
    });

    it('instruction 未提供时不写入请求体', async () => {
        mockOkResponse([{ index: 0, relevance_score: 0.7 }]);

        await createRerankScores_ACU(baseRequest);

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body).not.toHaveProperty('instruction');
    });

    it('instruction 只有空白时不写入请求体', async () => {
        mockOkResponse([{ index: 0, relevance_score: 0.6 }]);

        await createRerankScores_ACU({
            ...baseRequest,
            instruction: '   ',
        });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body).not.toHaveProperty('instruction');
    });
});
