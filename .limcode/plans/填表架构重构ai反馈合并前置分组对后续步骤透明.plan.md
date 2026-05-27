<!-- LIMCODE_SOURCE_ARTIFACT_START -->
{"type":"design","path":".limcode/design/填表架构重构ai反馈合并前置分组对后续步骤透明.md","contentHash":"sha256:abf803f013b964aaf5cf2ef5d0cb92614155a0cf1f4746826558bc4839b180f8"}
<!-- LIMCODE_SOURCE_ARTIFACT_END -->

## TODO LIST

<!-- LIMCODE_TODO_LIST_START -->
- [x] 定义并实现批次执行帧构建逻辑：按 group.indices + group.batchSize 拆分为 round，round 内保留各 group 的上下文差异  `#step_1`
- [x] 重构手动填表编排：每个 round 基于当前快照准备 prompt，round 内组并发生成，合并应用并持久化后刷新，再进入下一 round  `#step_2`
- [x] 重构自动填表编排：保留自动表级参数产生的 updateGroups，同样按 round 串行执行并在 round 内并发不同组  `#step_3`
- [x] 调整进度 toast 与 batch 计数语义：显示上下文批次 round 进度，避免把 preparedCall 数量误当批次总数  `#step_4`
- [x] 保留并校正 SQL apply 失败重试：重试仅针对当前 round，注入错误后重新生成当前 round 响应，不跨批污染  `#step_5`
- [x] 验证与回归：TypeScript 编译、bundle 构建、静态检查关键并发点，必要时补充测试或日志验证方案  `#step_6`
<!-- LIMCODE_TODO_LIST_END -->

# 填表架构重构：AI反馈合并前置

> **来源设计**: `.limcode/design/填表架构重构ai反馈合并前置分组对后续步骤透明.md`

## 目标

将分组填表架构从「每组独立走全流程」改为「所有组的 AI 响应先合并，再统一执行一次 parseAndApply，再统一持久化」。
分组仅影响 AI 请求的并发度，对后续所有步骤完全透明。

## 当前架构问题

```
每个组独立：replaceCurrentData → AI调用 → parseAndApply → deferredCommit
                          ↑ 污染源：覆盖 currentJsonTableData_ACU 和 SQLite engine
最后：commitMergedDeferredCommits
```

问题：
1. `replaceCurrentData` 每组执行一次，覆盖前序组的结果
2. SQLite engine 被并发 dispose，导致建表失败
3. 空壳数据通过指导表写入 chat_override，永久污染模板

## 新架构

```
阶段1: 准备 AI 请求（不变）→ preparedCalls[]
阶段2: 并发 AI 生成（不变）→ responses[]
阶段3 [NEW]: 提取+合并所有 AI 响应的编辑内容
阶段4 [NEW]: 单次建表 + 单次 parseAndApply + 单次捕获 before/after
阶段5 [NEW]: 单次持久化
```

## 影响范围

- `src/service/table/update-orchestrator.ts` — 主要改动文件
- `src/service/table/update-scheduler.ts` — 自动更新路径适配
- `src/presentation/triggers/update-process.ts` — processUpdates 回调签名可能微调

## 任务拆解

### Task 1: 新增 `extractEditsFromAiResponse_ACU` 和 `mergeAiEditContents_ACU`

**文件**: `src/service/table/update-orchestrator.ts`

新增两个辅助函数：

```typescript
/**
 * 从单个 AI 响应中提取编辑内容（去掉 <tableEdit> 标签和注释标记）。
 * 返回原始编辑文本，不执行。
 */
function extractEditsFromAiResponse_ACU(aiResponse: string): string | null {
    const extracted = extractTableEditInner_ACU(aiResponse, { allowNoTableEditTags: true });
    if (!extracted?.inner) return null;
    return extracted.inner.replace(/<!--|-->/g, '').trim();
}

/**
 * 合并多个 AI 响应的编辑内容为一个统一文本。
 * SQL 模式：用分号+换行分隔多段 SQL。
 * 原生模式：用换行分隔多段指令。
 */
function mergeAiEditContents_ACU(editBlocks: string[]): string {
    if (editBlocks.length === 0) return '';
    if (editBlocks.length === 1) return editBlocks[0];
    // 统一用双换行分隔（SQL 和原生模式都能处理）
    return editBlocks.filter(s => s.trim()).join('\n\n');
}
```

**验收标准**: 函数能正确提取 `<tableEdit>` 内部内容并合并。无副作用。

### Task 2: 新增 `applyMergedEdits_ACU`

**文件**: `src/service/table/update-orchestrator.ts`

新增核心函数，执行合并后的编辑：

```typescript
/**
 * 在当前状态上执行合并后的 AI 编辑。
 * - SQLite 模式：_ensureTablesFromTemplate 建表 → provider.applyEdits(sql)
 * - 原生模式：直接调用 parseAndApplyTableEdits_ACU（传入包装后的 <tableEdit>）
 * 返回 beforeData / afterData / modifiedKeys。
 */
async function applyMergedEdits_ACU(
    mergedEditContent: string,
    updateMode: string,
    targetSheetKeys: string[] | null,
): Promise<{
    success: boolean;
    beforeData: TableDataObject_ACU | null;
    afterData: TableDataObject_ACU | null;
    modifiedKeys: string[];
    error?: string;
}>
```

**关键逻辑**:
1. 克隆 `currentJsonTableData_ACU` 作为 beforeData
2. SQLite 模式：`_ensureTablesFromTemplate`（如果表不存在）→ `provider.applyEdits(mergedEditContent)`
3. 原生模式：将 mergedEditContent 包装在 `<tableEdit>...</tableEdit>` 中，调用 `parseAndApplyTableEdits_ACU`
4. 克隆 `currentJsonTableData_ACU` 作为 afterData
5. 收集 modifiedKeys（从 applyEdits 返回值或从 targetSheetKeys 推导）

**验收标准**: 
- 单组场景：行为与原有 `executeCardUpdateCore_ACU` 一致
- 多组场景：所有组的编辑内容被正确执行
- 不调用 `replaceCurrentData`（不覆盖全局状态）
- 不修改指导表、不触发 persistTablesToChatMessage

### Task 3: 重构 `orchestrateManualUpdate_ACU` — 手动更新路径

**文件**: `src/service/table/update-orchestrator.ts`

**当前** L1268-1314：按组串行 `processBatch` → 每组产生 deferredCommit → `commitMergedDeferredCommits`

**改为**：
```
// L1268 开始的新逻辑：
// 1. 从 generationResult.responses 中提取所有 AI 响应的编辑内容
const allEditBlocks: string[] = [];
for (const resp of generationResult.responses) {
    const edits = extractEditsFromAiResponse_ACU(resp.aiResponse);
    if (edits) allEditBlocks.push(edits);
}
if (allEditBlocks.length === 0) {
    // 没有 AI 响应包含有效编辑 → 报错
}
const mergedEdits = mergeAiEditContents_ACU(allEditBlocks);

// 2. 单次执行编辑
const applyResult = await applyMergedEdits_ACU(
    mergedEdits,
    'standard',   // 手动更新模式
    allTargetSheetKeys,  // 所有组的 sheetKeys 并集
);

// 3. 单次持久化
if (applyResult.success) {
    // isFirstTimeInit 检测 + 模板补全（保持原有逻辑）
    // ...
    await persistTablesToChatMessage_ACU({
        targetMessageIndex: primarySaveTargetIndex,
        targetSheetKeys: applyResult.modifiedKeys,
        beforeData: applyResult.beforeData,
        afterData: applyResult.afterData,
        trackAsUpdate: true,
    });
}
```

**验收标准**:
- 手动更新 3 个分组 → AI 响应并发生成 → 编辑内容合并 → 单次执行 → 单次保存
- 不再调用 `replaceCurrentData`
- 不再产生 `deferredCommits`
- 不再需要 `commitMergedDeferredCommits_ACU`
- 进度报告仍然按阶段（preparing → calling_ai → merging → applying → saving → complete）

### Task 4: 重构 `executeAutoUpdatePlan_ACU` — 自动更新路径

**文件**: `src/service/table/update-scheduler.ts`

**当前** L246-290：按组并发/串行 `ops.processUpdates`（每组走完整流程）

**改为**：
1. 阶段1：按组收集 preparedCalls（调用 `ops.processUpdates` 只传 `prepareAiCallOnly: true`）
2. 阶段2：并发 AI 生成（新增 `generateDeferredResponsesForPreparedCalls_ACU` 调用）
3. 阶段3：提取+合并 AI 编辑内容
4. 阶段4：单次 `applyMergedEdits_ACU`
5. 阶段5：单次 `ops.persistTables(...)`（新增操作接口）

**需要调整 `AutoUpdateOperations` 接口**：
```typescript
interface AutoUpdateOperations {
    loadAllChatMessages: () => Promise<void>;
    processUpdates: (...) => Promise<BatchUpdateResult>;  // 保留
    refreshData: () => Promise<void>;
    purgeOldLayerData: () => Promise<void>;
    // 新增：
    applyMergedEdits: (mergedEdits: string, updateMode: string, sheetKeys: string[] | null) => Promise<ApplyMergedResult>;
    persistMergedResult: (result: ApplyMergedResult) => Promise<void>;
}
```

或者更简洁——**让 `ops.processUpdates` 返回 `preparedAiCalls`，新增 `ops.applyAndPersist`**。

**验收标准**:
- 自动更新 3 个分组 → AI 响应并发 → 编辑合并 → 单次执行 → 单次保存
- 不再调用 `replaceCurrentData`
- 不再产生 `deferredCommits`

### Task 5: 清理废弃代码

**文件**: `src/service/table/update-orchestrator.ts`

清理不再需要的代码：
- `commitMergedDeferredCommits_ACU` — 如果不再被任何调用方使用，标记为废弃或删除
- `processUpdatesBatch_ACU` 中的 `deferredCommits` 分支 — 简化
- `replaceRuntimeTableDataForDeferredApply_ACU` — 如果不再被调用，标记废弃

**注意**：保留 `deferredCommits` 和 `commitMergedDeferredCommits_ACU` 的定义以防其他调用方依赖，
但在新架构中不再使用它们。

**验收标准**: 所有调用路径都走新的合并前置流程，废弃代码被注释标注或移除。

### Task 6: 回归验证

1. **单组场景**：行为与原有完全一致（AI 响应只有一个，合并等于不合并）
2. **多组场景**：所有组的编辑都被正确应用
3. **SQL 模式**：多段 SQL 顺序执行，表不存在时自动建表
4. **原生模式**：多段指令顺序执行
5. **失败场景**：AI 生成失败 → 不执行编辑 → 不保存 → 状态不变
6. **中止场景**：用户中止 → AI 生成中断 → 不执行编辑
7. **打包验证**：`npx tsc --noEmit` 零警告 + `npx rollup -c` 成功

## 风险控制

| 风险 | 影响 | 缓解 |
|------|------|------|
| 合并后 SQL 语法冲突 | 执行失败 | 每段 SQL 独立 `splitSqlStatements` 后逐条执行 |
| 不同组的目标楼层不同 | 数据写入位置错误 | 统一保存到最远楼层（当前已有此语义） |
| 原生模式多段指令冲突 | 行覆盖 | 按 AI 响应顺序执行，后执行的覆盖先执行的（与当前行为一致） |
| `extractTableEditInner_ACU` 只取最后一个块 | 丢失编辑 | 在 `extractEditsFromAiResponse_ACU` 中处理，不依赖标签合并 |

## 回滚策略

保留原有 `commitMergedDeferredCommits_ACU` 和 `deferredCommits` 代码路径。
新架构通过 feature flag 或条件分支切换。
如果新架构出现问题，恢复使用旧的按组串行执行路径。
