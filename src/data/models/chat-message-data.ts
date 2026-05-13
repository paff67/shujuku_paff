/**
 * data/models/chat-message-data.ts — 消息级表格数据结构定义
 *
 * 定义聊天消息上挂载的 TavernDB_ACU_* 字段的 TypeScript 接口。
 * 这些类型描述了每条消息上存储的表格数据结构。
 */

import type { Sheet_ACU } from '../../shared/models/table-data';
import type { TablePersistenceLayerV2_ACU } from '../../shared/models/table-persistence-v2';
import type {
    ChatSummaryVectorIndexManifest_ACU,
    ChatSummaryVectorIndexState_ACU,
} from '../../shared/models/summary-vector-index';

// ── 新版按标签分组存储 ──

/** 单个隔离标签下的数据槽 */
export interface IsolationTagData_ACU {
    independentData: Record<string, Sheet_ACU>;
    modifiedKeys: string[];
    updateGroupKeys: string[];
    /** V2 表格持久化层：checkpoint + row-level delta。 */
    tablePersistenceV2?: TablePersistenceLayerV2_ACU;
    /** 旧版/兼容向量记忆状态。保留字段是为了不破坏已有聊天记录。 */
    vectorMemoryState?: any;
    /** 交火模式纪要向量索引轻量状态。新外置模式下不应保存完整 vector 数组。 */
    summaryVectorIndexState?: ChatSummaryVectorIndexState_ACU | null;
    /** 外置向量索引 manifest。聊天记录只保存定位和校验信息。 */
    summaryVectorIndexManifest?: ChatSummaryVectorIndexManifest_ACU | null;
    /** 基底状态标记（首楼初始化时写入） */
    _acu_base_state?: string;
}

export type {
    ChatSummaryVectorIndexChunk_ACU,
    ChatSummaryVectorIndexManifest_ACU,
    ChatSummaryVectorIndexRow_ACU,
    ChatSummaryVectorIndexState_ACU,
} from '../../shared/models/summary-vector-index';

/** 按标签分组的容器（TavernDB_ACU_IsolatedData 的类型） */
export interface IsolatedDataContainer_ACU {
    [isolationKey: string]: IsolationTagData_ACU;
}

// ── 旧版兼容格式 ──

/** 旧版标准表/摘要表容器（TavernDB_ACU_Data / TavernDB_ACU_SummaryData 的类型） */
export interface LegacyTableContainer_ACU {
    mate?: { type: string; version: number };
    [sheetKey: string]: Sheet_ACU | { type: string; version: number } | undefined;
}

// ── 消息上所有 TavernDB_ACU_* 字段的完整类型 ──

/** 消息对象上所有 TavernDB_ACU_* 字段的类型描述 */
export interface MessageTableFields_ACU {
    /** 新版按标签分组的表格数据（可能是 object 或 JSON 字符串） */
    TavernDB_ACU_IsolatedData?: IsolatedDataContainer_ACU | string;
    /** 旧版独立表格数据 */
    TavernDB_ACU_IndependentData?: Record<string, Sheet_ACU>;
    /** 旧版标准表数据 */
    TavernDB_ACU_Data?: LegacyTableContainer_ACU;
    /** 旧版摘要/大纲表数据 */
    TavernDB_ACU_SummaryData?: LegacyTableContainer_ACU;
    /** 隔离标识代码 */
    TavernDB_ACU_Identity?: string;
    /** 本次修改的表格键列表 */
    TavernDB_ACU_ModifiedKeys?: string[];
    /** 本次更新组的表格键列表 */
    TavernDB_ACU_UpdateGroupKeys?: string[];
    /** 首楼模板基底状态标记（幂等用） */
    _acu_local_template_base_state_seeded?: string;
}

// ── 隔离配置（作为参数传入 repository，不引用 service 层） ──

/** 隔离配置，由 service 层从 settings_ACU 中提取后传入 */
export interface IsolationConfig_ACU {
    /** 是否启用数据隔离 */
    enabled: boolean;
    /** 隔离标识代码 */
    code: string;
}
