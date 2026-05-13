# 本地聊天记录表格持久化改造计划：checkpoint + row-level delta

## 1. 背景与目标

本计划用于将当前插件保存在聊天记录中的表格数据机制，从“每个楼层保存表格快照”改造为“最早保留楼层保存 checkpoint，后续楼层只保存 row-level delta”。

助手已经确认以下决策：

1. `row_id` 保持和当前机制一致，不额外发明新的行身份规则。
2. checkpoint 存完整 [`TableDataObject_ACU`](../src/shared/models/table-data.ts)。
3. 旧数据采用首次读取/保留清理前的懒迁移方案。
4. 所有非填表入口一起纳入改造，完全斩断旧快照正常读写逻辑。

本改造不是局部保存格式微调，而是聊天记录表格持久化协议升级。只改自动填表和手动填表入口会造成 delta 与旧快照混写，后续回放链路必然被污染。这不是实现，是把事故硬塞进代码里而已。

---

## 2. 当前机制侦察结论

### 2.1 当前消息级存储结构

当前消息级字段定义在 [`chat-message-data.ts`](../src/data/models/chat-message-data.ts)。

现有隔离标签结构 [`IsolationTagData_ACU`](../src/data/models/chat-message-data.ts) 包含：

- `independentData`：`Record<string, Sheet_ACU>`，保存每层楼的表格快照或局部表快照。
- `modifiedKeys`：表级修改标记。
- `updateGroupKeys`：表级更新组标记。
- `summaryVectorIndexState` / `summaryVectorIndexManifest`：交火纪要向量索引状态。
- `_acu_base_state`：模板/基底状态标记。

同时存在旧兼容字段：

- `TavernDB_ACU_IndependentData`
- `TavernDB_ACU_Data`
- `TavernDB_ACU_SummaryData`
- `TavernDB_ACU_Identity`
- `TavernDB_ACU_ModifiedKeys`
- `TavernDB_ACU_UpdateGroupKeys`

这些字段目前仍会被读取和写入。改造后，它们只允许作为 legacy migration 的输入，不再作为正常持久化协议的一部分。

---

### 2.2 当前读取/合并机制

当前核心合并入口是 [`mergeAllIndependentTables_ACU()`](../src/service/runtime/helpers-data-merge.ts)。

当前行为：

1. 获取聊天记录。
2. 从后向前扫描 AI 消息。
3. 每张表遇到的第一份快照作为最新数据。
4. 使用 sheet guide / template 过滤与恢复表结构。
5. 返回完整 [`TableDataObject_ACU`](../src/shared/models/table-data.ts)。

本质是“倒序取每张表最新快照”，不是 delta 回放。

新机制必须替换为：

1. 查找当前隔离标签下最新有效 checkpoint。
2. 从 checkpoint 所在楼层之后开始，按消息正序 apply delta。
3. 得到完整 [`TableDataObject_ACU`](../src/shared/models/table-data.ts)。
4. 将完整数据继续提供给世界书、SQLite、填表上下文、可视化编辑器和 API。

---

### 2.3 当前写入机制

当前核心写入入口是 [`persistTablesToChatMessage_ACU()`](../src/service/table/table-service.ts)，包装入口是 [`saveIndependentTableToChatHistory_ACU()`](../src/service/table/table-service.ts)。

当前行为：

1. 选择目标 AI 消息。
2. 从 [`currentJsonTableData_ACU`](../src/service/runtime/state-manager.ts) 取目标表完整 [`Sheet_ACU`](../src/shared/models/table-data.ts)。
3. 写入 `IsolationTagData_ACU.independentData`。
4. 同步写入旧兼容字段。

新机制必须改为：

1. 获取保存前 before snapshot。
2. 获取保存后 after snapshot。
3. 对目标表执行 before/after diff。
4. 写入 row-level delta。
5. 不再写任何旧快照字段。

---

### 2.4 自动填表流程

自动填表入口位于 [`triggerAutomaticUpdateIfNeeded_ACU()`](../src/presentation/triggers/settings-ui-sync/settings-ui-trigger.ts)。

链路：

1. [`triggerAutomaticUpdateIfNeeded_ACU()`](../src/presentation/triggers/settings-ui-sync/settings-ui-trigger.ts)
2. [`buildAutoUpdatePlan_ACU()`](../src/service/table/update-scheduler.ts)
3. [`executeAutoUpdatePlan_ACU()`](../src/service/table/update-scheduler.ts)
4. [`processUpdates_ACU()`](../src/presentation/triggers/update-process.ts)
5. [`processUpdatesBatch_ACU()`](../src/service/table/update-orchestrator.ts)
6. [`executeCardUpdateCore_ACU()`](../src/service/table/update-orchestrator.ts)
7. [`prepareAIInput_ACU()`](../src/service/ai/prompt-builder/prompt-prepare.ts)
8. [`callCustomOpenAI_ACU()`](../src/service/ai/prompt-builder/prompt-api-call.ts)
9. [`parseAndApplyTableEdits_ACU()`](../src/service/ai/prompt-builder/table-edit-parser.ts)
10. [`saveIndependentTableToChatHistory_ACU()`](../src/service/table/table-service.ts)
11. [`updateReadableLorebookEntry_ACU()`](../src/service/worldbook/pipeline.ts)

自动填表保存点仍然归入公共保存入口，因此不要在自动流程里写一套专用 delta 逻辑。否则会把系统切成两种协议，低级错误。

---

### 2.5 手动填表流程

手动填表入口位于 [`handleManualUpdate_ACU()`](../src/presentation/triggers/update-process.ts)。

链路：

1. [`handleManualUpdate_ACU()`](../src/presentation/triggers/update-process.ts)
2. [`orchestrateManualUpdate_ACU()`](../src/service/table/update-orchestrator.ts)
3. [`clearTableDataAtFloors_ACU()`](../src/service/chat/chat-service.ts)
4. [`processUpdates_ACU()`](../src/presentation/triggers/update-process.ts)
5. [`processUpdatesBatch_ACU()`](../src/service/table/update-orchestrator.ts)
6. [`executeCardUpdateCore_ACU()`](../src/service/table/update-orchestrator.ts)
7. [`parseAndApplyTableEdits_ACU()`](../src/service/ai/prompt-builder/table-edit-parser.ts)
8. [`saveIndependentTableToChatHistory_ACU()`](../src/service/table/table-service.ts)
9. [`updateReadableLorebookEntry_ACU()`](../src/service/worldbook/pipeline.ts)

手动填表的特殊点是预清空目标楼层。当前 [`clearTableDataAtFloors_ACU()`](../src/service/chat/chat-service.ts) 会删快照字段。新机制下必须改为删除目标楼层的 delta 中对应表的变更，不能粗暴删除 checkpoint。

---

### 2.6 世界书注入依赖

世界书刷新入口是 [`updateReadableLorebookEntry_ACU()`](../src/service/worldbook/pipeline.ts)。

它依赖完整 [`TableDataObject_ACU`](../src/shared/models/table-data.ts)，之后会触发：

- [`updateImportantPersonsRelatedEntries_ACU()`](../src/service/worldbook/injection-engine-entries.ts)
- [`updateSummaryTableEntries_ACU()`](../src/service/worldbook/injection-engine-entries.ts)
- [`updateOutlineTableEntry_ACU()`](../src/service/worldbook/injection-engine-entries.ts)
- [`updateCustomTableExports_ACU()`](../src/service/worldbook/injection-engine-custom.ts)

这些消费者不应该理解 delta。delta 是持久层协议，运行时和注入层必须继续拿完整物化快照。

---

### 2.7 SQLite 模式依赖

SQLite provider 位于 [`sql-table-service.ts`](../src/service/table/sql-table-service.ts)。

当前 [`SqlTableService.loadFromChat()`](../src/service/table/sql-table-service.ts) 调用 [`mergeAllIndependentTables_ACU()`](../src/service/runtime/helpers-data-merge.ts)，再通过 [`SyncBridge.loadFromTableData()`](../src/data/sqlite/sync-bridge.ts) 建表灌数据。

当前 [`SqlTableService.saveToChat()`](../src/service/table/sql-table-service.ts) 从 SQLite 导出完整 [`TableDataObject_ACU`](../src/shared/models/table-data.ts)，再调用 [`saveIndependentTableToChatHistory_ACU()`](../src/service/table/table-service.ts)。

因此 SQLite 模式也必须走“完整 before/after diff → row-level delta”的统一保存路径，不能让 SQL provider 自己直接写聊天记录。

---

### 2.8 保留楼层清理机制

当前清理入口是 [`purgeOldLayerData_ACU()`](../src/service/chat/chat-service.ts)。

当前行为是：

1. 找到含本地数据的消息。
2. 按 [`settings_ACU.retainRecentLayers`](../src/service/runtime/state-manager.ts) 保留最近 N 层。
3. 直接删除更旧楼层上的表格字段、旧兼容字段和剧情字段。

在 delta 模式下，直接删除旧 delta 会断链。新机制必须先 rollup checkpoint，再清理旧层。

---

## 3. 新持久化协议设计

### 3.1 V2 数据挂载位置

继续挂载在当前隔离标签结构 [`IsolationTagData_ACU`](../src/data/models/chat-message-data.ts) 内，避免破坏数据隔离体系和现有向量索引状态存储。

建议新增字段：

```ts
interface IsolationTagData_ACU {
  independentData: Record<string, Sheet_ACU>;
  modifiedKeys: string[];
  updateGroupKeys: string[];
  tablePersistenceV2?: TablePersistenceLayerV2_ACU;
  summaryVectorIndexState?: ChatSummaryVectorIndexState_ACU | null;
  summaryVectorIndexManifest?: ChatSummaryVectorIndexManifest_ACU | null;
  _acu_base_state?: string;
}
```

保留 `independentData` 字段只是为了类型兼容和迁移阶段安全；新正常写入不得再写完整 [`Sheet_ACU`](../src/shared/models/table-data.ts)。

---

### 3.2 V2 checkpoint 结构

```ts
interface TableCheckpointV2_ACU {
  kind: 'checkpoint';
  version: 2;
  checkpointId: string;
  createdAt: string;
  source: 'legacy-migration' | 'retention-rollup' | 'template-seed' | 'manual-rebase';
  isolationKey: string;
  aiFloorHint?: number;
  messageIndexHint?: number;
  data: TableDataObject_ACU;
}
```

checkpoint 存完整 [`TableDataObject_ACU`](../src/shared/models/table-data.ts)。这是助手已经确认的设计。

理由：

1. 世界书注入需要完整数据。
2. SQLite 建表需要完整数据。
3. 模板/guide 恢复需要完整 sheet 结构。
4. 保留楼层推进时 checkpoint 是唯一基底。

---

### 3.3 V2 delta 结构

```ts
interface TableLayerDeltaV2_ACU {
  kind: 'delta';
  version: 2;
  deltaId: string;
  createdAt: string;
  isolationKey: string;
  baseCheckpointId?: string;
  aiFloorHint?: number;
  messageIndexHint?: number;
  changedSheets: string[];
  modifiedKeys: string[];
  updateGroupKeys: string[];
  changesBySheet: Record<string, SheetDeltaV2_ACU>;
}

interface SheetDeltaV2_ACU {
  sheetKey: string;
  sheetName?: string;
  header?: (string | null)[];
  sheetMeta?: Partial<Sheet_ACU>;
  rowChanges: RowChangeV2_ACU[];
}

type RowChangeV2_ACU =
  | {
      op: 'upsert';
      rowId: string;
      rowIndexHint?: number;
      row: (string | null)[];
    }
  | {
      op: 'delete';
      rowId: string;
      rowIndexHint?: number;
    }
  | {
      op: 'clearSheet';
    };
```

行标识使用当前机制中的 `row_id`，即数据行第一列。助手已经确认保持现有机制一致。

---

### 3.4 V2 layer 容器

```ts
interface TablePersistenceLayerV2_ACU {
  version: 2;
  checkpoint?: TableCheckpointV2_ACU;
  delta?: TableLayerDeltaV2_ACU;
}
```

一个消息层可以同时存在 checkpoint 和 delta，但默认规则应尽量避免同层同时写两者，除非 boundary checkpoint 之后同楼层又发生新增 delta。实现时可以允许，读取时先应用 checkpoint，再应用同层 delta。

---

## 4. 新增模块规划

### 4.1 类型模块

新增 [`table-delta-types.ts`](../src/service/table/table-delta-types.ts)。

职责：

1. 定义 V2 checkpoint/delta 类型。
2. 定义 row change 类型。
3. 定义迁移结果类型。
4. 定义 reconstruct 选项。

---

### 4.2 行工具模块

新增 [`table-row-identity.ts`](../src/service/table/table-row-identity.ts)。

职责：

1. 从 [`Sheet_ACU.content`](../src/shared/models/table-data.ts) 提取 `row_id`。
2. 保持当前机制一致，不引入额外语义。
3. 提供行 map 构造。
4. 对缺失/异常 `row_id` 做保守处理和日志。

注意：助手确认 `row_id` 保持现有机制一致，因此这里不应主动生成全新业务 ID 语义。若当前机制允许空值或位置 fallback，按当前行为兼容；若当前机制要求第一列，就按第一列执行。

---

### 4.3 diff 模块

新增 [`table-delta-diff.ts`](../src/service/table/table-delta-diff.ts)。

核心函数：

```ts
createTableDeltaFromBeforeAfter_ACU(options: {
  before: TableDataObject_ACU | null;
  after: TableDataObject_ACU | null;
  targetSheetKeys: string[];
  modifiedKeys: string[];
  updateGroupKeys: string[];
  isolationKey: string;
  targetMessageIndex: number;
}): TableLayerDeltaV2_ACU | null
```

规则：

1. 只比较 `targetSheetKeys`。
2. 表不存在到存在：写该表全部有效行 `upsert`。
3. 表存在到不存在：写 `clearSheet` 或表删除 tombstone。
4. 行新增/修改：写 `upsert`。
5. 行删除：写 `delete`。
6. header 变化：写 `header`。
7. sheet 元数据变化：写 `sheetMeta`。
8. 无变化返回 `null`，不能制造空 delta。

这是统一 native、SQLite、API、可视化编辑器的关键。分别在每个入口手写 delta 是低质量实现，会把维护者拖进泥潭。

---

### 4.4 apply 模块

新增 [`table-delta-apply.ts`](../src/service/table/table-delta-apply.ts)。

核心函数：

```ts
applyTableDelta_ACU(base: TableDataObject_ACU, delta: TableLayerDeltaV2_ACU): TableDataObject_ACU
```

规则：

1. 复制 base，禁止原地污染。
2. 对每张 sheet 应用 delta。
3. `clearSheet` 保留 header 和 sheet meta，清空数据行。
4. `upsert`：按 `row_id` 替换或插入整行。
5. `delete`：按 `row_id` 删除。
6. `rowIndexHint` 仅用于顺序恢复，不作为主身份。
7. 应用完成后执行表结构规范化。
8. 最终仍要通过 guide/template 过滤，避免旧表死灰复燃。

---

### 4.5 reconstruct 模块

新增 [`table-delta-reconstruct.ts`](../src/service/table/table-delta-reconstruct.ts)。

核心函数：

```ts
reconstructTablesFromChatDeltas_ACU(options?: {
  allowLegacyMigration?: boolean;
  targetMessageIndexExclusive?: number;
  includeSameLayerDeltaAfterCheckpoint?: boolean;
}): Promise<TableDataObject_ACU | null>
```

职责：

1. 获取 chat。
2. 获取当前 isolation key。
3. 查找 V2 checkpoint。
4. 从 checkpoint 后正序 apply delta。
5. 支持按消息索引截断，用于批次填表 base。
6. 无 checkpoint 但存在 legacy 快照时触发 migration。
7. 无数据时回退模板/guide 初始化。

当前 [`mergeAllIndependentTables_ACU()`](../src/service/runtime/helpers-data-merge.ts) 可以暂时保留函数名，但内部委托给 reconstruct，减少调用点大规模变动。

---

### 4.6 repository 模块

新增 [`table-delta-repository.ts`](../src/service/table/table-delta-repository.ts)。

职责：

1. 从消息读取 V2 layer。
2. 写入 V2 checkpoint。
3. 写入 V2 delta。
4. 删除指定 sheet 的 delta。
5. 删除旧字段。
6. 保留非表格状态，如 `summaryVectorIndexState` / `summaryVectorIndexManifest`。

注意不要直接在业务层到处操作 `TavernDB_ACU_IsolatedData`。那样就是把数据结构泄漏给所有调用方，后续改协议会继续痛苦。

---

### 4.7 legacy migration 模块

新增 [`table-delta-migration.ts`](../src/service/table/table-delta-migration.ts)。

核心函数：

```ts
migrateLegacySnapshotsToCheckpoint_ACU(options?: {
  targetBoundaryMessageIndex?: number;
  saveChat?: boolean;
}): Promise<{
  migrated: boolean;
  checkpointMessageIndex?: number;
  checkpointId?: string;
}>
```

职责：

1. 检测旧快照字段。
2. 用旧规则拼接每张表最新层数据。
3. 找到最远保留楼层。
4. 写入 V2 checkpoint。
5. 标记 migration source 为 `legacy-migration`。
6. 不继续把旧字段作为正常读取路径。

---

### 4.8 retention 模块

新增 [`table-delta-retention.ts`](../src/service/table/table-delta-retention.ts)。

核心函数：

```ts
rollupCheckpointBeforePurge_ACU(options: {
  retainCount: number;
}): Promise<{
  changed: boolean;
  boundaryMessageIndex?: number;
  purgedMessageIndices: number[];
}>
```

职责：

1. 计算保留区间。
2. 找到 boundary message。
3. 重建 boundary 之前所有表格状态。
4. 写入 boundary checkpoint。
5. 删除 boundary 之前 V2 delta/checkpoint 和 legacy 表格字段。
6. 不误删剧情字段和向量索引字段，除非调用方明确要清。

---

## 5. 读取链路改造计划

### 5.1 改造 [`mergeAllIndependentTables_ACU()`](../src/service/runtime/helpers-data-merge.ts)

短期策略：保留函数名，内部替换为新 reconstruct。

原因：调用点多，直接全局改名会扩大回归面。生产代码不是展示重构洁癖的地方，先降低风险。

新行为：

1. 调用 [`reconstructTablesFromChatDeltas_ACU()`](../src/service/table/table-delta-reconstruct.ts)。
2. 如无 V2 数据但存在 legacy 数据，触发 [`migrateLegacySnapshotsToCheckpoint_ACU()`](../src/service/table/table-delta-migration.ts)。
3. migration 后再次 reconstruct。
4. 返回完整 [`TableDataObject_ACU`](../src/shared/models/table-data.ts)。

---

### 5.2 改造 SQLite 加载

改造 [`SqlTableService.loadFromChat()`](../src/service/table/sql-table-service.ts)。

当前依赖 [`mergeAllIndependentTables_ACU()`](../src/service/runtime/helpers-data-merge.ts)，若函数名保留且内部委托 reconstruct，则 SQLite 加载可最小改动。

需要验证：

1. 空壳模板表仍不提前建 SQLite 表。
2. checkpoint 中 seed/base state 不被误判为真实数据。
3. delta apply 后的表结构与 DDL 仍能通过 [`SyncBridge.loadFromTableData()`](../src/data/sqlite/sync-bridge.ts)。

---

### 5.3 改造世界书刷新

改造 [`updateReadableLorebookEntry_ACU()`](../src/service/worldbook/pipeline.ts) 和 [`refreshMergedDataAndNotify_ACU()`](../src/service/worldbook/pipeline.ts)。

如果 [`mergeAllIndependentTables_ACU()`](../src/service/runtime/helpers-data-merge.ts) 已委托 reconstruct，世界书调用可以保持低侵入。

必须验证：

1. 可读总条目内容一致。
2. 重要人物条目一致。
3. 总结条目一致。
4. 大纲条目一致。
5. 自定义导出条目一致。
6. splitByRow 导出顺序一致。

---

## 6. 写入链路改造计划

### 6.1 改造 [`persistTablesToChatMessage_ACU()`](../src/service/table/table-service.ts)

新保存流程：

1. 定位目标 AI 消息。
2. 获取当前 isolation key。
3. 获取 before snapshot：
   - 优先使用调用方传入的 before。
   - 没有则 reconstruct 到目标消息写入前状态。
4. 获取 after snapshot：
   - 从 [`currentJsonTableData_ACU`](../src/service/runtime/state-manager.ts) 或 provider 导出的最新数据。
5. 调用 [`createTableDeltaFromBeforeAfter_ACU()`](../src/service/table/table-delta-diff.ts)。
6. delta 非空则写入 V2 layer。
7. 更新 V2 `modifiedKeys` / `updateGroupKeys`。
8. 删除或忽略本消息旧快照字段。
9. 保存聊天。

禁止再调用旧兼容写入函数写完整快照。尤其是 [`writeLegacyCompatData_ACU()`](../src/data/repositories/chat-message-data-repo.ts) 和 [`writeLegacyStandardAndSummary_ACU()`](../src/data/repositories/chat-message-data-repo.ts) 不能继续作为正常保存路径。

---

### 6.2 before snapshot 来源

必须建立可靠 before 来源。建议在保存 API 上扩展参数：

```ts
interface TableChatPersistOptions_ACU {
  targetMessageIndex?: number;
  targetSheetKeys?: string[] | null;
  updateGroupKeys?: string[] | null;
  skipCleanup?: boolean;
  trackAsUpdate?: boolean;
  beforeData?: TableDataObject_ACU | null;
  afterData?: TableDataObject_ACU | null;
}
```

如果调用方没有传 `beforeData`，保存函数可以 reconstruct，但这会有性能成本。关键路径应主动传 before。

---

### 6.3 provider committed snapshot

为 [`NativeTableServiceAdapter`](../src/service/table/native-table-service-adapter.ts) 和 [`SqlTableService`](../src/service/table/sql-table-service.ts) 增加 committed snapshot 概念。

用途：

1. loadFromChat 后记录当前完整数据为 committed。
2. applyEdits 前可 clone committed 作为 before。
3. saveToChat 成功后更新 committed。
4. SQLite export 后得到 after，再统一 diff。

没有 committed snapshot，保存函数只能猜 before。把正确性建立在“应该能 reconstruct 出来”上，质量只能算勉强合格。

---

## 7. 自动填表改造计划

### 7.1 批次 base 数据

当前 [`loadBatchBaseData_ACU()`](../src/service/table/update-orchestrator.ts) 会倒序找 batch 前的快照。

新机制改为：

1. 调用 [`reconstructTablesFromChatDeltas_ACU()`](../src/service/table/table-delta-reconstruct.ts)。
2. 设置 `targetMessageIndexExclusive` 为 batch 第一条消息索引。
3. 得到 batch 开始前的完整表格状态。

否则批量填表时会拿错上下文，尤其是在同一批内多楼层 delta 叠加时。

---

### 7.2 AI 编辑前后 diff

在 [`executeCardUpdateCore_ACU()`](../src/service/table/update-orchestrator.ts) 中：

1. 调用 [`prepareAIInput_ACU()`](../src/service/ai/prompt-builder/prompt-prepare.ts) 前，保证 [`currentJsonTableData_ACU`](../src/service/runtime/state-manager.ts) 是 reconstruct 后完整数据。
2. 调用 [`parseAndApplyTableEdits_ACU()`](../src/service/ai/prompt-builder/table-edit-parser.ts) 前 clone before。
3. apply 后获取 after。
4. 保存时传入 before/after。

---

### 7.3 自动计划历史判断

改造 [`resolveTableHistoryStateFromChat_ACU()`](../src/service/table/table-history.ts)。

新判断规则：

1. V2 checkpoint 中包含目标 sheet，则视为有数据。
2. V2 delta 的 `changedSheets` 包含目标 sheet，则视为有数据。
3. V2 delta 的 `modifiedKeys` / `updateGroupKeys` 包含目标 sheet，则视为 tracked update。
4. legacy 字段只允许触发 migration，不再直接算作正常历史状态。

---

## 8. 手动填表改造计划

### 8.1 目标楼层预清理

改造 [`clearTableDataAtFloors_ACU()`](../src/service/chat/chat-service.ts)。

当前它清理快照字段。新逻辑：

1. 如果传入 `targetSheetKeys`：
   - 删除目标楼层 V2 delta 中对应 sheet 的 rowChanges。
   - 从 `changedSheets` / `modifiedKeys` / `updateGroupKeys` 移除对应 sheet。
   - delta 空后删除 delta。
2. 如果未传 `targetSheetKeys`：
   - 删除当前隔离标签下该楼层的 V2 delta。
   - 不直接删除 checkpoint。
3. 如果该楼层只有 checkpoint：
   - 默认不删除。
   - 如业务确实需要覆盖，应重建 checkpoint 或写 clear delta。
4. 清理总结/大纲时仍处理 summary vector index manifest。

---

### 8.2 手动覆盖语义

手动填表的预清理目标是避免旧数据残留影响 SQL 严格填表。delta 模式下，等价动作不是“删除楼层全部数据”，而是“删除该楼层对目标表的贡献”。

这样才能保证：

1. 早于目标楼层的 checkpoint/base 保留。
2. 晚于目标楼层的 delta 仍可继续叠加。
3. 手动重填只替换目标楼层的贡献，不破坏整条链。

---

## 9. retention/checkpoint 改造计划

### 9.1 重写 [`purgeOldLayerData_ACU()`](../src/service/chat/chat-service.ts)

新流程：

1. 读取 [`settings_ACU.retainRecentLayers`](../src/service/runtime/state-manager.ts)。
2. 收集所有含本地数据的 AI 消息。
3. 区分：
   - V2 表格数据。
   - legacy 表格数据。
   - 剧情推进数据。
   - summary vector index 数据。
4. 若存在 legacy 且无 V2 checkpoint，先执行 legacy migration。
5. 计算 boundary，即最早保留的数据消息。
6. reconstruct 到 boundary 之前的完整状态。
7. 在 boundary 写入 checkpoint，source 为 `retention-rollup`。
8. 删除 boundary 之前所有 V2 表格层和 legacy 表格字段。
9. 按原策略清理剧情字段。
10. 对 summary vector index 外置 manifest 保持原有清理语义，不能被表格清理误删。
11. 保存聊天。

---

### 9.2 boundary checkpoint 规则

边界结构应为：

```text
[被清理旧层] [boundary checkpoint] [delta] [delta] [delta]
```

checkpoint 必须写到最早保留楼层，而不是最新楼层。

理由：

1. 与保留语义一致。
2. 后续 retention 推进时可继续 rollup。
3. reconstruct 起点稳定。

---

### 9.3 防止向量索引误删

当前 [`summaryVectorIndexState`](../src/service/vector/summary-vector-index-state-service.ts) 也挂在 [`IsolationTagData_ACU`](../src/data/models/chat-message-data.ts) 上。

改造 repository 和 purge 时必须避免：

1. 删除表格 delta 时误删 `summaryVectorIndexState`。
2. 删除旧 `independentData` 时误删 manifest。
3. 清理 checkpoint 时破坏交火索引恢复。

这部分要单独测试。否则表格持久化改好了，向量索引被顺手扫没，还是事故。

---

## 10. legacy migration 计划

### 10.1 触发条件

触发 migration 的条件：

1. 当前隔离标签没有 V2 checkpoint。
2. 聊天记录中存在任意 legacy 表格快照字段。
3. 正在执行 reconstruct 或 retention purge。

---

### 10.2 拼接旧快照

使用旧逻辑拼接：

1. 按当前 isolation key 读取 [`TavernDB_ACU_IsolatedData`](../src/data/models/chat-message-data.ts)。
2. 读取旧字段：
   - `TavernDB_ACU_IndependentData`
   - `TavernDB_ACU_Data`
   - `TavernDB_ACU_SummaryData`
3. 倒序取每张表最新快照。
4. 应用 sheet guide/template 过滤。
5. 得到完整 [`TableDataObject_ACU`](../src/shared/models/table-data.ts)。

---

### 10.3 写入 checkpoint

checkpoint 写入位置：

1. 优先写到最远保留楼层。
2. 如果保留楼层不存在可写 AI 消息，则写到最新 AI 消息。
3. source 为 `legacy-migration`。
4. 写入后正常 reconstruct 只走 V2。

---

### 10.4 旧字段处理

迁移后：

1. 不立即强删全部旧字段，避免一次性破坏用户聊天记录。
2. retention 推进时逐步删除。
3. 正常读取不再依赖旧字段。
4. 可以在日志中记录 migration 完成。

---

## 11. 非填表入口改造计划

助手已确认所有非填表入口一起纳入，这点必须执行到底。

### 11.1 可视化编辑器保存

文件：[`visualizer-main-save.ts`](../src/presentation/pages/visualizer-main-save.ts)。

当前会按表回写到原楼层并调用 [`saveIndependentTableToChatHistory_ACU()`](../src/service/table/table-service.ts)。

改造：

1. 编辑器打开或保存前捕获 before。
2. 保存后 after 是当前 [`currentJsonTableData_ACU`](../src/service/runtime/state-manager.ts)。
3. 分楼层保存时，每层生成对应 sheet delta。
4. 删除表时写明确删除/clear delta，并清理历史中相关 delta，而不是旧快照硬删。

---

### 11.2 API CRUD

文件：[`table-crud-api.ts`](../src/presentation/bootstrap/api-groups/table-crud-api.ts)。

当前 [`saveToLatestFloorAndRefresh()`](../src/presentation/bootstrap/api-groups/table-crud-api.ts) 会保存到表最新楼层。

改造：

1. API mutation 前 clone before。
2. mutation 后取 after。
3. 保存到目标楼层 delta。
4. refresh 仍通过 reconstruct 后完整数据刷新世界书。

---

### 11.3 总结合并

文件：[`merge-executor.ts`](../src/service/summary/merge-executor.ts) 和 [`merge-logic.ts`](../src/service/summary/merge-logic.ts)。

当前合并后调用 [`saveIndependentTableToChatHistory_ACU()`](../src/service/table/table-service.ts)。

改造：

1. 合并前捕获 summary table before。
2. 合并后写 summary table row-level delta。
3. 更新世界书仍使用完整 reconstruct 结果。

---

### 11.4 provider 保存

文件：

- [`native-table-service-adapter.ts`](../src/service/table/native-table-service-adapter.ts)
- [`sql-table-service.ts`](../src/service/table/sql-table-service.ts)

改造：

1. provider 不直接关心聊天字段细节。
2. provider 只提供 before/after 或 committed snapshot。
3. 统一交给 [`persistTablesToChatMessage_ACU()`](../src/service/table/table-service.ts) 生成 delta。

---

## 12. 停止旧快照正常读写

### 12.1 停止写入

以下函数不得再作为正常保存路径调用：

- [`writeLegacyCompatData_ACU()`](../src/data/repositories/chat-message-data-repo.ts)
- [`writeLegacyStandardAndSummary_ACU()`](../src/data/repositories/chat-message-data-repo.ts)

旧字段不得再被正常写入：

- `TavernDB_ACU_IndependentData`
- `TavernDB_ACU_Data`
- `TavernDB_ACU_SummaryData`
- `TavernDB_ACU_Identity`
- `TavernDB_ACU_ModifiedKeys`
- `TavernDB_ACU_UpdateGroupKeys`

---

### 12.2 限制读取

旧字段只允许被以下模块读取：

1. [`table-delta-migration.ts`](../src/service/table/table-delta-migration.ts)
2. retention 前置迁移逻辑。
3. 显式维护/诊断工具。

其他业务路径不允许继续读旧快照。

---

## 13. 实施阶段安排

### Phase 1：类型与基础工具

1. 新增 [`table-delta-types.ts`](../src/service/table/table-delta-types.ts)。
2. 新增 [`table-row-identity.ts`](../src/service/table/table-row-identity.ts)。
3. 新增 [`table-delta-diff.ts`](../src/service/table/table-delta-diff.ts)。
4. 新增 [`table-delta-apply.ts`](../src/service/table/table-delta-apply.ts)。
5. 添加基础单测。

验收：

- 单表 insert/update/delete 可生成 delta。
- delta apply 后与 after snapshot 等价。
- `row_id` 行身份与现有机制一致。

---

### Phase 2：reconstruct 与读取替换

1. 新增 [`table-delta-reconstruct.ts`](../src/service/table/table-delta-reconstruct.ts)。
2. 改造 [`mergeAllIndependentTables_ACU()`](../src/service/runtime/helpers-data-merge.ts) 委托 reconstruct。
3. 验证世界书和 SQLite 加载。

验收：

- V2 checkpoint + 多层 delta 能重建完整表。
- 世界书注入内容正确。
- SQLite 能从 reconstruct 后数据建表。

---

### Phase 3：保存链路替换

1. 改造 [`persistTablesToChatMessage_ACU()`](../src/service/table/table-service.ts)。
2. 停止 legacy 写入。
3. 增加 before/after 参数。
4. provider 增加 committed snapshot。

验收：

- 自动填表保存后聊天记录只出现 V2 delta。
- 手动填表保存后聊天记录只出现 V2 delta。
- 旧快照字段不再新增。

---

### Phase 4：自动/手动填表适配

1. 改造 [`executeCardUpdateCore_ACU()`](../src/service/table/update-orchestrator.ts) 捕获 before/after。
2. 改造 [`loadBatchBaseData_ACU()`](../src/service/table/update-orchestrator.ts) 使用按索引 reconstruct。
3. 改造 [`clearTableDataAtFloors_ACU()`](../src/service/chat/chat-service.ts) 删除 delta。
4. 改造 [`resolveTableHistoryStateFromChat_ACU()`](../src/service/table/table-history.ts) 识别 V2。

验收：

- 自动填表连续多层后，reconstruct 结果正确。
- 手动重填目标楼层后，目标层旧 delta 被替换。
- 后续楼层 delta 不丢失。

---

### Phase 5：retention/checkpoint

1. 新增 [`table-delta-retention.ts`](../src/service/table/table-delta-retention.ts)。
2. 改造 [`purgeOldLayerData_ACU()`](../src/service/chat/chat-service.ts)。
3. boundary 写 checkpoint。
4. 删除更旧表格层。

验收：

- 保留层推进后仍能 reconstruct 当前完整表。
- boundary checkpoint 内容正确。
- 旧 delta 删除后不丢数据。
- summary vector index manifest 不被误删。

---

### Phase 6：legacy migration

1. 新增 [`table-delta-migration.ts`](../src/service/table/table-delta-migration.ts)。
2. reconstruct 无 V2 checkpoint 时触发 migration。
3. retention 前兜底 migration。

验收：

- 旧聊天首次加载后生成 V2 checkpoint。
- 后续读取不再直接依赖旧快照。
- retention 推进后旧字段逐步清除。

---

### Phase 7：非填表入口统一改造

1. 改造 [`visualizer-main-save.ts`](../src/presentation/pages/visualizer-main-save.ts)。
2. 改造 [`table-crud-api.ts`](../src/presentation/bootstrap/api-groups/table-crud-api.ts)。
3. 改造 [`merge-executor.ts`](../src/service/summary/merge-executor.ts)。
4. 改造 [`merge-logic.ts`](../src/service/summary/merge-logic.ts)。
5. 改造 native/sql provider save。

验收：

- 任意入口保存后不产生旧快照字段。
- 所有入口的变更都能以 delta 重建。
- 世界书刷新结果一致。

---

## 14. 测试矩阵

### 14.1 基础 delta 测试

1. 单行新增。
2. 单行修改。
3. 单行删除。
4. 多行混合变更。
5. clear sheet。
6. header 变化。
7. sheet meta 变化。
8. 多 sheet 同层变更。

---

### 14.2 reconstruct 测试

1. checkpoint 无 delta。
2. checkpoint + 1 层 delta。
3. checkpoint + 多层 delta。
4. 多表交错 delta。
5. 同层 checkpoint + delta。
6. 无 checkpoint 但有 legacy。
7. 无数据时模板初始化。

---

### 14.3 自动/手动填表测试

1. native 自动填表。
2. native 手动填表。
3. SQLite 自动填表。
4. SQLite 手动填表。
5. 手动重填历史目标层。
6. 自动批量填表跨多层。
7. SQL 严格模式下预清理后重填。

---

### 14.4 非填表入口测试

1. 可视化编辑器修改单元格。
2. 可视化编辑器删除表。
3. API `insertRow`。
4. API `updateRow`。
5. API `deleteRow`。
6. 总结合并写入。
7. provider `saveToChat`。

---

### 14.5 retention 测试

1. retainRecentLayers 未超过时不清理。
2. 超过保留层后生成 boundary checkpoint。
3. 删除旧 delta 后 reconstruct 正确。
4. 连续多次 retention 推进。
5. boundary 原本有 delta 时的合并处理。
6. legacy 数据在 retention 前迁移。

---

### 14.6 世界书测试

1. 可读总条目更新。
2. 重要人物表条目更新。
3. 总结表条目更新。
4. 大纲表条目更新。
5. 自定义导出整表模式。
6. 自定义导出按行拆分模式。
7. 纪要索引条目与交火模式兼容。

---

### 14.7 数据隔离测试

1. 未启用数据隔离。
2. 启用数据隔离 code A。
3. 切换到 code B。
4. 同一消息多 isolationKey 并存。
5. 清理 A 不影响 B。

---

## 15. 风险与约束

### 15.1 最大风险：混合协议

如果任何保存入口继续写旧快照，就会产生：

1. reconstruct 忽略旧快照导致数据看似丢失。
2. migration 重复读旧快照导致旧数据复活。
3. retention 无法判断真实边界。
4. 世界书注入内容不稳定。

所以必须一次性斩断所有正常旧写入。

---

### 15.2 第二风险：before snapshot 不可靠

diff 的正确性依赖 before/after。如果 before 错了，delta 就错了。

应对：

1. provider 维护 committed snapshot。
2. 核心填表流程显式传 before。
3. 保存函数 fallback reconstruct 只作为兜底。
4. 保存后更新 committed snapshot。

---

### 15.3 第三风险：retention 断链

删除旧 delta 前必须写 checkpoint。任何绕过 checkpoint 的清理都是数据破坏。

应对：

1. [`purgeOldLayerData_ACU()`](../src/service/chat/chat-service.ts) 必须先 rollup。
2. 删除前后做 reconstruct 校验。
3. 日志记录 checkpointId、boundaryIndex、purged indices。

---

### 15.4 第四风险：向量索引状态误删

summary vector index 状态与表格数据共用 [`IsolationTagData_ACU`](../src/data/models/chat-message-data.ts)。

应对：

1. repository 层字段级更新。
2. 不整体替换 tagData。
3. 删除表格层时保留 vector manifest，除非调用方明确清理总结/大纲相关索引。

---

## 16. 最终落地原则

1. 聊天记录正常持久化只允许 V2 checkpoint + delta。
2. [`currentJsonTableData_ACU`](../src/service/runtime/state-manager.ts) 继续作为完整运行时缓存。
3. 世界书、SQLite、UI、API 不直接消费 delta。
4. 所有保存入口统一走 before/after diff。
5. retention 永远先 checkpoint rollup，再清旧层。
6. legacy 字段只作为 migration 输入。
7. 非填表入口必须同步改造，不能留下旧写入暗门。

这版计划的重点不是“少写点数据”这么浅薄，而是把持久化语义从快照覆盖改成可回放状态链。能跑不等于能交付；这个改造如果不按协议层升级处理，后续每个保存入口都会变成潜在事故源。