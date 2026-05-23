## TODO LIST

<!-- LIMCODE_TODO_LIST_START -->
- [x] A1: 修改迁移目标楼层——checkpoint写入旧快照最新一楼（checkpointMessageIndex）而非第一楼  `#A1`
- [x] A1b: 新增「无checkpoint+有V2 delta+无旧快照」场景——从模板建表累加delta生成checkpoint写入最早V2 delta楼层，删除该楼层delta  `#A1b`
- [x] A2: 移除migrateLegacyCheckpointToRootMessage_ACU中遍历删除旧快照的逻辑（L308-310）  `#A2`
- [x] A3: 回归验证——已有checkpoint时不触发迁移（sawV2Checkpoint检查已存在）  `#A3`
- [x] B1: 确认迁移时机已覆盖楼层更新场景（懒迁移在所有读取路径上触发）  `#B1`
- [x] B2: 确认rollup逻辑与迁移逻辑的衔接（rollupCheckpointBeforePurge_ACU不需改动）  `#B2`
- [x] C1: 移除chat-scope-guide.ts中buildHistoricalGuideDataFromChat_ACU的旧快照读取，改用V2路径  `#C1`
- [x] C2: 确认messageHasCurrentIsolationLocalTableLayer_ACU不再被迁移路径依赖  `#C2`
- [x] C3: 保留table-service.ts和helpers-data-merge.ts中写入时清理同消息旧格式的调用  `#C3`
- [x] C4: 清理前端API输出路径中的旧格式数据暴露  `#C4`
- [x] D1: 确保migrateContentNullToRowId在checkpoint写入前执行  `#D1`
- [x] D2: 确保迁移时表结构不受DDL格式变化影响丢表（已有templateSheetKeySet回退逻辑）  `#D2`
- [x] E1: 原生模式迁移路径回归验证  `#E1`
<!-- LIMCODE_TODO_LIST_END -->

# 旧快照迁移逻辑重构实施计划

## 计划来源
助手直接需求，基于代码库现状分析制定。

### 助手确认的边界条件

1. **迁移后保留旧格式字段**：不再读取即可，不删除
2. **有 checkpoint 就不迁移**：只要聊天中存在 V2 checkpoint，跳过所有旧快照/孤立 delta 扫描
3. **checkpoint 只有三种产生逻辑**：
   - **无 checkpoint + 有旧快照**：从旧快照合并生成 checkpoint，写入旧快照最新一楼（不删旧字段）
   - **无 checkpoint + 有 V2 delta 但无旧快照**：从模板建表作为初始数据，累加最早 V2 delta 那一楼及之前的 delta，生成 checkpoint 写入该楼层，删除该楼层的 delta
   - **checkpoint 超出保留窗口**：删除前在保留楼层的最早一层 rollup 新 checkpoint（已有 `rollupCheckpointBeforePurge_ACU`，**不需要改动**）

---

## 一、现状分析

### 1.1 旧快照迁移流程（当前实现）

**核心文件**：`src/service/table/table-delta-migration.ts`、`src/service/table/table-delta-reconstruct.ts`

**当前流程**：
1. `reconstructTablesFromChatDeltas_ACU` 正向扫描聊天记录：
   - 有 V2 checkpoint → 直接用 checkpoint + delta 回放，**不迁移**
   - 有 V2 delta 但无 checkpoint → 逐层 apply delta 到 `data = null`，不生成 checkpoint，然后进入旧快照迁移路径
   - 无 V2 层 → 完全走旧快照迁移
2. `buildLegacyCheckpointFromChat_ACU()` — 从聊天记录反向扫描旧格式数据，合并为 V2 checkpoint
3. `migrateLegacyCheckpointToRootMessage_ACU()` — 将 checkpoint 写入**锚点消息（通常是第一楼）**，然后**遍历所有消息删除旧快照**

**问题清单**：

| # | 问题 | 影响 |
|---|------|------|
| P1 | checkpoint 写入第一楼（锚点逻辑），而非旧快照的最新一楼 | 违反直觉；与 rollup 逻辑写法不一致 |
| P2 | 迁移后遍历所有消息删除旧快照 | **不可回滚**；违反"保留旧字段"原则 |
| P3 | 「无 checkpoint + 有 V2 delta + 无旧快照」场景不生成 checkpoint | 每次读取都需重放所有 delta，性能浪费；逻辑上应补齐 checkpoint |
| P4 | 迁移后旧快照读取路径仍散布在多处 | `chat-scope-guide.ts` 等仍直接读旧格式，存在数据源不一致风险 |

### 1.2 三种场景的当前处理 vs 目标处理

| 场景 | 当前处理 | 目标处理 |
|------|----------|----------|
| 有 checkpoint | 直接用 checkpoint + delta 回放 | **不变** |
| 无 checkpoint + 有旧快照 | 懒迁移：合并旧快照 → 写第一楼 → 删旧快照 | 合并旧快照 → 写旧快照最新一楼 → **不删旧字段** |
| 无 checkpoint + 有 V2 delta + 无旧快照 | apply delta 到 null，不生成 checkpoint | **从模板建表 → 累加最早 V2 delta 楼层的 delta → 生成 checkpoint 写入该楼层 → 删除该楼层 delta** |

### 1.3 旧快照读取路径（需全部移除/替换为 V2 路径）

| 文件 | 行号 | 读取方式 | 用途 | 处理策略 |
|------|------|----------|------|----------|
| `table-delta-migration.ts` L107-143 | `scanLegacySnapshots` → `readLegacyIndependentData_ACU` / `readLegacyStandardData_ACU` / `readLegacySummaryData_ACU` |迁移扫描 | **保留**（迁移本身是旧快照的"最后一次读取"） |
| `table-delta-migration.ts` L219-227 | `readIsolatedTagData_ACU` + `readLegacyIndependentData_ACU` 等 | 判断消息是否有表数据 | **改为仅检查 V2 层** |
| `chat-scope-guide.ts` L106-121 | `readIsolatedTagData_ACU` + `readLegacyIndependentData_ACU` 等 | 指导表构建 | **改用 `reconstructTablesFromChatDeltas_ACU`** |
| `table-service.ts` L286 | `clearCurrentIsolationLegacyTableSnapshots_ACU` | 保存时清理当前消息旧格式 | **保留**（写入新 V2 delta 时清理同消息旧格式冗余，非迁移删除） |
| `helpers-data-merge.ts` L394-398 | `clearCurrentIsolationLegacyTableSnapshots_ACU` | 模板种子写入时清理旧格式 | **保留**（同上） |
| `table-delta-migration.ts` L308-310 | `clearCurrentIsolationLegacyTableSnapshots_ACU`（遍历全聊天） | 迁移后删除所有旧格式 | **移除**（P2 修复） |
| `chat-message-data-repo.ts` L386-403 | `msg.TavernDB_ACU_IndependentData` | 清理指定 sheet | **保留**（清理指定 sheet 功能仍需要） |

### 1.4 数据流全景

```
数据读取时机（合并/显示/世界书注入）
  → mergeAllIndependentTablesWithMeta_ACU / mergeAllIndependentTables_ACU
    → reconstructTablesFromChatDeltas_ACU
      → 有 V2 checkpoint → 直接用 checkpoint + delta 回放 [不迁移]
      → 无 V2 checkpoint + 有旧快照 → 懒迁移：buildLegacyCheckpoint → 写入旧快照最新一楼 [不删旧字段]
      → 无 V2 checkpoint + 有 V2 delta + 无旧快照 → 从模板建表 + 累加 delta → 写入最早 V2 delta 楼层 [删该楼层 delta]

旧快照写入时机（填表/手动操作）
  → saveIndependentTableToChatHistory_ACU → persistTablesToChatMessage_ACU
    → 写 V2 delta + 清理当前消息的旧格式（clearCurrentIsolationLegacyTableSnapshots_ACU）

世界书写入时机（楼层更新）
  → updateReadableLorebookEntry_ACU → mergeAllIndependentTables_ACU
  → refreshMergedDataAndNotify_ACU → mergeAllIndependentTables_ACU

checkpoint rollup（超出保留窗口）
  → rollupCheckpointBeforePurge_ACU [已有逻辑，不需要改动]
```

### 1.5 SQL 模式兼容要点

- SQL 模式通过 `mergeAllIndependentTablesWithMeta_ACU()` 获取 JSON 快照后灌入 SQLite
- 迁移后 checkpoint 数据的格式必须与 `SyncBridge.loadFromTableData()` 兼容
- 旧快照中可能存在 `content[0][0] === null` 的格式（已由 `migrateContentNullToRowId` 处理），迁移时需确保该转换仍然执行
- 新增场景（从模板建表 + 累加 delta）中，模板数据本身已是正确格式，但 delta apply 后的结果可能需要 `migrateContentNullToRowId`

### 1.6 原生模式适配

- 原生模式与 SQL 模式共享同一套 `reconstructTablesFromChatDeltas_ACU` 合并路径
- 新增的「从模板建表 + 累加 delta」场景对原生模式同样适用
- 无需额外适配代码，仅需回归验证

---

## 二、实施任务拆解

### 阶段 A：迁移核心逻辑重构

#### A1. 修改迁移目标楼层：从第一楼改为旧快照最新一楼

**文件**：`src/service/table/table-delta-migration.ts`

**修改内容**：
- `migrateLegacyCheckpointToRootMessage_ACU`（L286-313）当前逻辑：
  - 调用 `resolveLegacyCheckpointAnchorMessageIndex_ACU` 决定锚点 → 默认写第一楼
  - 调用 `migrateLegacyCheckpointToMessage_ACU(anchorMessage, ...)` 写入
- 改为：
  - 不再调用 `resolveLegacyCheckpointAnchorMessageIndex_ACU`
  - 直接使用调用方传入的 `targetMessageIndex`（即 `buildLegacyCheckpointFromChat_ACU` 返回的 `checkpointMessageIndex`——旧快照最新一楼）
  - 在该消息上调用 `migrateLegacyCheckpointToMessage_ACU` 写入 checkpoint
- 修改 `migrateLegacyCheckpointToRootMessage_ACU` 的签名，接受 `targetMessageIndex` 参数
- `reconstructTablesFromChatDeltas_ACU` 中 L118-124 的调用也需相应调整，传入 `legacyResult.checkpointMessageIndex`

**验收标准**：
- 迁移后 checkpoint 写在旧快照最新一楼的 `tablePersistenceV2` 中
- 如果旧快照只存在于第一楼，则写入第一楼（不冲突）

#### A1b. 新增「无 checkpoint + 有 V2 delta + 无旧快照」场景处理

**文件**：`src/service/table/table-delta-reconstruct.ts`、`src/service/table/table-delta-migration.ts`（或新建辅助函数）

**场景描述**：
聊天中没有 V2 checkpoint，也没有旧快照数据，但存在孤立的 V2 delta。这种情况可能发生在：模板种子写入后被手动清理、或数据导入后仅写入 delta 而未生成 checkpoint。

**目标处理**：
1. 找到最早的包含 V2 delta 的楼层（`firstV2MessageIndex`，当前代码 L61 已记录）
2. 从模板生成初始表数据（调用 `parseTableTemplateJson_ACU` 或 `materializeDataFromSheetGuide_ACU`，类似 `seedGreetingLocalDataFromTemplate_ACU` 的逻辑）
3. 累加该楼层及之前所有 V2 delta（如果同一楼层有 delta 的话），生成完整的 checkpoint 数据
4. 在该楼层写入 checkpoint 到 `tablePersistenceV2`
5. 删除该楼层的 delta（从 `tablePersistenceV2` 中移除 `delta`/`deltas` 字段，保留 `checkpoint`）
6. 后续楼层的 delta 保留不动（它们以新 checkpoint 为 base 继续回放）

**具体修改**：

在 `reconstructTablesFromChatDeltas_ACU` 中，当 `sawV2 = true && sawV2Checkpoint = false` 且 `legacyResult.checkpoint === null`（无旧快照）时：

```typescript
// 当前代码 L94-111：尝试旧快照迁移
const legacyResult = buildLegacyCheckpointFromChat_ACU(...);

if (!legacyResult.checkpoint || legacyResult.checkpointMessageIndex === undefined) {
  // 当前直接返回 data（无 checkpoint）
  // 改为：尝试从模板建表 + 累加 delta 生成 checkpoint
  if (sawV2 && firstV2MessageIndex !== undefined) {
    // 1. 从模板生成初始数据
    const templateData = parseTableTemplateJson_ACU({ stripSeedRows: false });
    let seedData: TableDataObject_ACU | null = templateData
      ? buildTemplateBaseStateDataForLocalStorage_ACU(templateData)
      : null;

    // 2. 累加 firstV2MessageIndex 及之前的 delta
    if (seedData) {
      for (let i = 0; i <= firstV2MessageIndex; i++) {
        const msg = chat[i];
        if (!msg || msg.is_user) continue;
        const layer = readTablePersistenceLayerV2_ACU(msg, context.isolationKey);
        if (!layer) continue;
        for (const delta of getTablePersistenceDeltasV2_ACU(layer)) {
          seedData = applyTableDelta_ACU(seedData, delta);
        }
      }

      // 3. 在 firstV2MessageIndex 写入 checkpoint
      const targetMsg = chat[firstV2MessageIndex];
      if (targetMsg && !targetMsg.is_user && hasAnySheet_ACU(seedData)) {
        const newCheckpoint: TableCheckpointV2_ACU = {
          kind: 'checkpoint',
          version: 2,
          checkpointId: `delta-anchor-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          createdAt: new Date().toISOString(),
          source: 'legacy-migration',  // 或新增 source 类型
          isolationKey: context.isolationKey,
          messageIndexHint: firstV2MessageIndex,
          data: cloneJson_ACU(seedData),
        };

        // 4. 写入 checkpoint，删除该楼层的 delta
        const existingLayer = readTablePersistenceLayerV2_ACU(targetMsg, context.isolationKey);
        const nextLayer: TablePersistenceLayerV2_ACU = {
          version: 2,
          checkpoint: newCheckpoint,
          // 不保留 delta/deltas
        };
        writeTablePersistenceLayerV2_ACU(targetMsg, context.isolationKey, nextLayer);

        // 5. 继续回放 firstV2MessageIndex + 1 到 endExclusive 的 delta
        data = cloneJson_ACU(seedData);
        for (let i = firstV2MessageIndex + 1; i < endExclusive; i++) {
          const msg = chat[i];
          if (!msg || msg.is_user) continue;
          const layer = readTablePersistenceLayerV2_ACU(msg, context.isolationKey);
          for (const delta of getTablePersistenceDeltasV2_ACU(layer)) {
            data = applyTableDelta_ACU(data, delta);
          }
        }

        checkpoint = newCheckpoint;
        checkpointMessageIndex = firstV2MessageIndex;
        changed = true;
      }
    }
  }
  // 如果模板也为空，则回退到当前逻辑（返回 data 无 checkpoint）
}
```

**注意事项**：
- `parseTableTemplateJson_ACU` 需要导入到 `table-delta-reconstruct.ts`（或从调用方传入模板数据）
- 或者更好的方案：从 `context` 中传入 `templateSheetKeys`，用 `materializeDataFromSheetGuide_ACU` 生成初始数据
- `migrateContentNullToRowId` 需要在 seedData 上执行（D1）
- 新 checkpoint 的 `source` 字段可以用 `'legacy-migration'`（语义一致：补齐缺失的 checkpoint）或新增 `'delta-anchor'` 类型

**验收标准**：
- 孤立 V2 delta 场景下，自动从模板建表 + 累加 delta 生成 checkpoint
- checkpoint 写入最早 V2 delta 所在楼层
- 该楼层的 delta 被删除（避免重复回放）
- 后续楼层的 delta 保留，以新 checkpoint 为 base 回放
- 如果模板为空或无法建表，回退到当前逻辑（不生成 checkpoint）

#### A2. 移除迁移后的旧快照删除逻辑

**文件**：`src/service/table/table-delta-migration.ts`

**修改内容**：
- `migrateLegacyCheckpointToRootMessage_ACU` 中删除以下代码段（L308-310）：
  ```typescript
  for (const message of chat) {
    clearCurrentIsolationLegacyTableSnapshots_ACU(message, isolationKey, isolationConfig);
  }
  ```
- 迁移只是"追加写入 checkpoint"，不是"搬迁并删除"
- 旧格式字段保留在原消息中，只是不再被读取

**验收标准**：
- 迁移后所有旧格式数据仍保留在原消息中
- 下次读取时，由于已有 V2 checkpoint（`sawV2Checkpoint = true`），不进入迁移路径

#### A3. 确认幂等性：已有 checkpoint 不再迁移

**文件**：`src/service/table/table-delta-reconstruct.ts`

**修改内容**：
- L63-L83：已有 `sawV2Checkpoint` 检查，直接返回 → **已满足**
- A1b 新增的逻辑也需要幂等检查：如果 `firstV2MessageIndex` 那一楼已有 checkpoint，跳过
- 但由于 `sawV2Checkpoint` 在扫描阶段就会设为 `true`，不会进入 A1b 的分支 → **天然幂等**

**验收标准**：
- 对同一聊天多次调用不会产生重复 checkpoint
- 已迁移过的聊天不会再次触发迁移

### 阶段 B：迁移时机确认与优化

#### B1. 确认迁移时机已覆盖「楼层更新」场景

**分析结论**：

当前懒迁移已在所有数据读取路径上触发：
- `updateReadableLorebookEntry_ACU`（L55）：非 SQL 模式 → `mergeAllIndependentTables_ACU` → 包含懒迁移
- `refreshMergedDataAndNotify_ACU`（L566）：→ `mergeAllIndependentTables_ACU` → 包含懒迁移
- 事件监听 `MESSAGE_DELETED` / `MESSAGE_SWIPED`（init.ts L388-407）：→ `refreshMergedDataAndNotifyWithUI_ACU` → 包含懒迁移
- `loadOrCreateJsonTableFromChatHistory_ACU`（table-service.ts L428）：→ `mergeAllIndependentTables_ACU`
- `SqlTableService.loadFromChat`（sql-table-service.ts L69）：→ `mergeAllIndependentTablesWithMeta_ACU`

**结论**：迁移时机已覆盖「填表前」和「楼层更新时」。无需新增触发点。

**验收标准**：
- AI 回复后世界书刷新时自动触发迁移（如果尚未迁移）
- 迁移只执行一次，后续读取不重复触发

#### B2. 确认 rollup 逻辑与迁移逻辑的衔接

**分析结论**：

`rollupCheckpointBeforePurge_ACU`（L142-217）：
- 在保留边界楼层调用 `reconstructTablesFromChatDeltas_ACU` 重建数据
- 生成新 checkpoint 并写入边界消息
- 删除超出窗口的旧层
- **该逻辑不需要改动**

`rollupCheckpointBeforePurge_ACU` 内部调用了 `reconstructTablesFromChatDeltas_ACU`（L170），`allowLegacyMigration: true` 参数意味着 rollup 过程中也可能触发旧快照迁移或 A1b 场景——这是正确行为，确保 rollup 前的数据完整。

**验收标准**：
- rollup 逻辑不受迁移重构影响
- rollup 时如果需要迁移，使用新的迁移逻辑

### 阶段 C：移除非迁移路径的旧快照读取

#### C1. 移除 `chat-scope-guide.ts` 中的旧快照读取

**文件**：`src/service/template/chat-scope/chat-scope-guide.ts`

**修改内容**：
- `buildHistoricalGuideDataFromChat_ACU`（L106-121）：当前同时读取 `independentData` 和旧格式数据
- 改为只读取 `tablePersistenceV2` 中的数据：
  - 移除 `readLegacyIndependentData_ACU` / `readLegacyStandardData_ACU` / `readLegacySummaryData_ACU` 调用
  - 移除 `isLegacyMatchForIsolation_ACU` 检查
  - 保留 `readIsolatedTagData_ACU` 中的 `independentData` 读取（这是 V2 隔离数据，非旧格式）
  - 或更好方案：改用 `reconstructTablesFromChatDeltas_ACU` 获取合并后数据，从中提取指导表
- 注意：移除旧读取后，如果数据尚未迁移，需确保迁移在指导表构建之前触发（B1 已确认覆盖）

**验收标准**：
- 指导表构建不再直接读取旧格式数据
- 如果数据尚未迁移，通过合并路径触发迁移后读取 V2 数据

#### C2. 简化 `messageHasCurrentIsolationLocalTableLayer_ACU` 中的旧快照检查

**文件**：`src/service/table/table-delta-migration.ts`

**修改内容**：
- L209-231 的函数当前同时检查 V2 层和旧格式
- 在 A1 修改后，`resolveLegacyCheckpointAnchorMessageIndex_ACU` 不再被迁移路径使用
- `collectCurrentIsolationLocalTableMessageIndices_ACU` 可能仍被 rollup 等使用——需确认
- 策略：保留该函数（它用于枚举有数据的消息，不仅服务于迁移），但在迁移路径上不再依赖它

**验收标准**：
- 迁移路径不再依赖该函数的旧格式检查
- 该函数本身可以保留（不影响非迁移逻辑）

#### C3. 保留 `clearCurrentIsolationLegacyTableSnapshots_ACU` 的写入路径调用

**结论**：以下两处调用**保留**，不修改：
- `table-service.ts` L286：保存时清理当前消息旧格式 — 写入新 V2 delta 时清理同消息旧格式冗余
- `helpers-data-merge.ts` L394-398：模板种子写入时清理旧格式 — 同上

这两处是"写入新格式时清理同消息旧格式"，与"迁移后删除所有旧快照"不同。保留此行为避免同一消息上同时存在 V2 和旧格式数据导致的冗余。

**验收标准**：
- 写入新 V2 数据时仍清理同消息的旧格式（避免数据冗余）
- 迁移操作本身不再删除任何消息的旧格式数据（A2 已处理）

#### C4. 清理前端 API 输出路径中的旧格式数据暴露

**文件**：`src/data/repositories/chat-message-data-repo.ts`、`src/presentation/bootstrap/api-groups/core-data-api.ts`

**修改内容**：
- 确认前端 API 输出路径是否直接暴露旧格式数据
- 如果有，改为从 V2 层获取
- `purgeSheetKeysFromMessage_ACU` 保留但确保也清理 V2 层中的对应 sheet

**验收标准**：
- 前端 API 不再返回旧格式表格数据
- 所有数据输出统一通过 V2 路径

### 阶段 D：SQL 模式兼容

#### D1. 确保迁移时 `migrateContentNullToRowId` 在 checkpoint 写入前执行

**文件**：`src/service/table/table-delta-migration.ts`、`src/service/table/table-delta-reconstruct.ts`

**修改内容**：
- **A1 场景**（旧快照迁移）：`buildLegacyCheckpointFromChat_ACU` 构建的 checkpoint.data 中可能包含 `content[0][0] === null` 的旧格式 → 在 `migrateLegacyCheckpointToMessage_ACU` 写入前对 checkpoint.data 执行 `migrateContentNullToRowId`
- **A1b 场景**（模板建表 + delta）：模板数据本身已是正确格式，但旧版 delta apply 后可能产生 `null` 占位列 → 对 seedData 执行 `migrateContentNullToRowId`
- 导入 `migrateContentNullToRowId` 到 `table-delta-migration.ts` 或 `table-delta-reconstruct.ts`

**验收标准**：
- 迁移后 checkpoint 中的数据 `content[0][0]` 为 `"row_id"` 而非 `null`
- SQL 模式加载迁移数据不会因格式不匹配而丢表

#### D2. 确保迁移时表结构不受 DDL 格式变化影响

**分析结论**：
- `buildLegacyCheckpointFromChat_ACU` 已有 `templateSheetKeySet` 过滤 + 无匹配时回退不过滤 → **保留此行为**
- A1b 场景中从模板建表，天然与 DDL 一致
- 迁移不会因模板变化而丢失已有数据

**验收标准**：
- SQL 模式加载迁移数据后，所有旧表数据均可正常读写

### 阶段 E：原生模式适配

#### E1. 原生模式迁移路径验证

**结论**：
- 原生模式与 SQL 模式共享同一套 `reconstructTablesFromChatDeltas_ACU` 合并路径
- A1、A1b、A2 的修改对原生模式透明
- 无需额外适配代码，仅需回归验证

**验收标准**：
- 原生模式下三种场景的迁移均正常执行
- 迁移后数据读写正常

---

## 三、实施顺序

```
A1 → A1b → A2 → A3 → B1 → B2 → C1 → C2 → C3 → C4 → D1 → D2 → E1
│                   │                                    │
└── 核心迁移逻辑 ───┘                                    │
         │                                               │
         └── 旧读取路径移除 ── 兼容性验证 ────────────────┘
```

- **A1**：旧快照迁移楼层修改（核心，独立）
- **A1b**：孤立 delta 场景新增（核心，可与 A1 并行但建议顺序执行）
- **A2**：移除旧快照删除逻辑（核心，依赖 A1）
- **A3**：幂等性确认（验证性任务）
- **B1-B2**：确认性任务
- **C1-C4**：旧读取路径移除，依赖 B
- **D1-D2**：SQL 兼容，可与 C 并行
- **E1**：原生模式验证，依赖 A+D

---

## 四、风险与回滚策略

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| A1b 模板建表与 delta apply 后数据不正确 | 中 | 高 | 对 seedData 执行 `migrateContentNullToRowId`；回归验证 |
| A1b 删除最早 V2 delta 楼层的 delta 后数据丢失 | 低 | 极高 | 已累加到 checkpoint 中，但需确保 apply 顺序正确 |
| 指导表构建丢失旧数据（C1 移除旧读取后） | 中 | 高 | 确保迁移在指导表构建之前触发（B1 已确认） |
| 移除旧读取后，未迁移的老数据无法加载 | 高 | 极高 | 保留 `buildLegacyCheckpointFromChat_ACU` 作为迁移扫描的最后入口 |

**回滚策略**：
1. 迁移不删除旧格式数据 → **天然可回滚**（删除 V2 checkpoint 即可回到旧格式读取）
2. A1b 场景中删除的 delta 已累加到 checkpoint 中 → 如需回滚，可从 checkpoint 重新生成 delta（但更简单的方式是直接删除 checkpoint，让系统回到旧快照读取路径）
3. `buildLegacyCheckpointFromChat_ACU` 内部扫描逻辑保留，作为迁移的唯一起点
