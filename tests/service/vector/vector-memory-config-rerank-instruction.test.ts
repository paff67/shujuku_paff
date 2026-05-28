/**
 * tests/service/vector/vector-memory-config-rerank-instruction.test.ts
 * normalizeVectorMemoryConfig_ACU — rerankInstruction 字段归一化语义测试
 *
 * 覆盖：
 * - 字段不存在（旧配置升级）→ 回填默认提示词
 * - 字段为空字符串（用户主动清空）→ 保留空
 * - 字段为空白字符串 → trim 后为空
 * - 字段为自定义文本 → trim 后保留
 * - 字段为非字符串类型 → 回填默认提示词
 */
import { describe, it, expect } from 'vitest';
import { normalizeVectorMemoryConfig_ACU } from '../../../src/service/vector/vector-memory-config';
import { defaultVectorMemoryConfig_ACU } from '../../../src/shared/defaults';

describe('normalizeVectorMemoryConfig_ACU — rerankInstruction', () => {
    const DEFAULT_INSTRUCTION = defaultVectorMemoryConfig_ACU.rerankInstruction;

    it('字段不存在时回填默认提示词（旧配置升级）', () => {
        const config = normalizeVectorMemoryConfig_ACU({});
        expect(config.rerankInstruction).toBe(DEFAULT_INSTRUCTION);
        expect(config.rerankInstruction.length).toBeGreaterThan(0);
    });

    it('字段为 undefined 时回填默认提示词', () => {
        const config = normalizeVectorMemoryConfig_ACU({ rerankInstruction: undefined });
        expect(config.rerankInstruction).toBe(DEFAULT_INSTRUCTION);
    });

    it('字段为空字符串时保留空（用户主动清空）', () => {
        const config = normalizeVectorMemoryConfig_ACU({ rerankInstruction: '' });
        expect(config.rerankInstruction).toBe('');
    });

    it('字段为空白字符串时 trim 后为空', () => {
        const config = normalizeVectorMemoryConfig_ACU({ rerankInstruction: '   ' });
        expect(config.rerankInstruction).toBe('');
    });

    it('字段为自定义文本时 trim 后保留', () => {
        const config = normalizeVectorMemoryConfig_ACU({ rerankInstruction: '  自定义指令  ' });
        expect(config.rerankInstruction).toBe('自定义指令');
    });

    it('字段为非字符串类型时回填默认提示词', () => {
        const config = normalizeVectorMemoryConfig_ACU({ rerankInstruction: 123 });
        expect(config.rerankInstruction).toBe(DEFAULT_INSTRUCTION);
    });

    it('字段为 null 时回填默认提示词', () => {
        const config = normalizeVectorMemoryConfig_ACU({ rerankInstruction: null });
        expect(config.rerankInstruction).toBe(DEFAULT_INSTRUCTION);
    });

    it('默认提示词包含关键语义：用户输入、关键词、降序', () => {
        expect(DEFAULT_INSTRUCTION).toContain('用户输入');
        expect(DEFAULT_INSTRUCTION).toContain('关键词');
        expect(DEFAULT_INSTRUCTION).toContain('降序');
    });
});
