
# 填表架构重构：AI反馈合并前置

## 问题根因

当前架构中，每个分组独立走完 `replaceCurrentData → AI调用 → parseAndApply → 持久化` 全流程。
分组之间通过 `replaceCurrentData` 互相覆盖全局状态（`currentJsonTableData_ACU`、SQLite engine），
导致数据污染、并发 dispose、空壳覆盖等问题。

## 核心思路

**分组只影响 AI 请求的并发度，不影响后续任何步骤。**

具体做法：
1. 所有组的 AI 请求并发发出，收集所有 AI 响应
2. 将所有 AI 响应的 `<tableEdit>` 内容合并为**一个统一的编辑文本**
3. 在**单一状态**上执行 SQL 建表 → applyEdits（只执行一次）
4. 持久化只做一次

## 当前流程（手动更新）

```
阶段1: 准备AI请求（prepareAiCallOnly=true）→ preparedCalls[]
阶段2: 并发AI生成 → generationResult.responses[]
阶段3: 串行按组处理：
  for each group:
    processBatch(group, {deferredResponses: groupResponses, deferPersistence: true})
      → buildBatchMergeBase → replaceCurrentData(!!)  ← 污染源
      → executeCardUpdateCore:
          → parseAndApplyTableEdits  ← 修改 currentJsonTableData_ACU
          → 返回 deferredCommit(beforeData, afterData)
阶段4: commitMergedDeferredCommits(deferredCommits[])
```

## 新流程

```
阶段1: 准备AI请求（不变）→ preparedCalls[]
阶段2: 并发AI生成（不变）→ generationResult.responses[]
阶段3 [NEW]: 合并所有组的AI响应为一个统一编辑文本
  - 收集所有 responses[].aiResponse
  - 拼接为一个字符串（或逐个解析提取 <tableEdit> 块后重组）
阶段4 [NEW]: 单次执行 parseAndApply
  - 建表（只一次）
  - applyEdits 合并后的编辑文本（只一次）
  - 捕获 beforeData / afterData（只一对）
阶段5 [NEW]: 单次持久化
  - persistTablesToChatMessage（只一次）
```

## 关键改动点

### 1. `orchestrateManualUpdate_ACU`（update-orchestrator.ts）

**当前**：阶段3按组串行调用 `processBatch`（每组走 `replaceCurrentData → parseAndApply → deferredCommit`）
**新**：阶段3收集所有AI响应文本 → 阶段4调用一次 `executeCardUpdateCore_ACU` 传入合并后的AI响应

### 2. `executeAutoUpdatePlan_ACU`（update-scheduler.ts）

**当前**：串行/并发按组调用 `ops.processUpdates`（每组独立走全流程）
**新**：收集所有AI响应 → 单次执行 parseAndApply → 单次持久化

### 3. `processUpdatesBatch_ACU`（update-orchestrator.ts）

**当前**：每 batch 做 `replaceCurrentData`，然后 `executeCardUpdateCore`
**新**：在非 deferPersistence 模式下保持原有行为；在 deferPersistence 模式下：
  - 阶段1（prepareAiCallOnly）：不变，收集 preparedCalls
  - 阶段2：收集 deferredResponses（AI响应）
  - **不再按组执行 parseAndApply**
  - 返回 `{ preparedAiCalls, deferredResponses }`，不返回 deferredCommits

### 4. 新增函数：`mergeDeferredResponses_ACU`

将多个 DeferredAiResponse 的 aiResponse 文本合并为一个字符串。

策略：提取每个响应中的所有 `<tableEdit>...</tableEdit>` 块，拼接到一个字符串中。

### 5. 新增函数：`executeMergedResponses_ACU`

接收合并后的 AI 响应文本，在当前状态上执行一次 parseAndApply，返回 beforeData/afterData。

## 实现步骤

### Step 1: 新增 `mergeDeferredResponses_ACU`

```typescript
export function mergeDeferredResponses_ACU(responses: DeferredAiResponse_ACU[]): string {
    if (responses.length === 0) return '';
    if (responses.length === 1) return responses[0].aiResponse;
    
    // 提取所有 <tableEdit> 块并拼接
    const allEdits: string[] = [];
    for (const resp of responses) {
        const text = resp.aiResponse || '';
        // 提取 <tableEdit>...</tableEdit> 块
        const regex = /<tableEdit>[\s\S]*?<\/tableEdit>/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            allEdits.push(match[0]);
        }
    }
    return allEdits.join('\n\n');
}
```

### Step 2: 新增 `executeMergedResponses_ACU`

```typescript
export async function executeMergedResponses_ACU(
    mergedAiResponse: string,
    targetSheetKeys: string[] | null,
    saveTargetIndex: number,
): Promise<{ success: boolean; beforeData: any; afterData: any; modifiedKeys: string[]; error?: string }> {
    // 1. 确保 SQLite 表已创建（_ensureTablesFromTemplate）
    // 2. 克隆 beforeData
    // 3. parseAndApplyTableEdits(mergedAiResponse, ...)
    // 4. 克隆 afterData
    // 5. 返回 { beforeData, afterData, modifiedKeys }
}
```

### Step 3: 重构 `orchestrateManualUpdate_ACU`

```diff
  // 阶段1+2: 不变（准备AI请求 + 生成AI响应）
  
- // 阶段3: 按组串行应用
- for (groupOffset ...) {
-     const applyResult = await processBatch(...);
-     deferredCommits.push(...applyResult.deferredCommits);
- }
- 
- // 阶段4: 合并提交
- const commitResult = await commitMergedDeferredCommits_ACU(deferredCommits);
+ // 阶段3: 合并所有AI响应
+ const mergedResponse = mergeDeferredResponses_ACU(generationResult.responses);
+ 
+ // 阶段4: 单次执行 parseAndApply
+ const executeResult = await executeMergedResponses_ACU(
+     mergedResponse,
+     allSheetKeys,  // 所有组的 sheetKeys 的并集
+     primarySaveTargetIndex,
+ );
+ 
+ // 阶段5: 单次持久化
+ if (executeResult.success) {
+     await persistTablesToChatMessage_ACU({
+         targetMessageIndex: primarySaveTargetIndex,
+         targetSheetKeys: executeResult.modifiedKeys,
+         beforeData: executeResult.beforeData,
+         afterData: executeResult.afterData,
+     });
+ }
```

### Step 4: 重构 `executeAutoUpdatePlan_ACU`

同样思路：收集所有AI响应 → 合并 → 单次执行 → 单次持久化。

## 风险与边界条件

1. **不同组的 sheetKeys 可能不重叠**：合并 AI 响应后 parseAndApply 能正确处理不相关的表
   - `parseAndApplyTableEdits` 本身是按 sheetKey 路由的，不同表的编辑不会互相干扰 ✅

2. **不同组可能有不同的 saveTargetIndex**：当前架构允许每组保存到不同楼层
   - 新架构下：所有组的编辑在同一个 currentJsonTableData_ACU 上执行，
     合并后的数据保存到**每个组各自的目标楼层**（与当前 commitMergedDeferredCommits 逻辑一致）
   - 或者更简化：保存到统一的最远楼层（减少复杂度）

3. **重试逻辑**：当前每组有独立的重试
   - 新架构下：合并后如果 parseAndApply 失败，需要整体重试（或标记失败的组）
   - 由于 AI 响应已经生成完毕，parseAndApply 很少失败（主要是 SQL 语法问题）

4. **进度报告**：当前按组报告进度
   - 新架构：阶段2按组报告AI生成进度，阶段4报告单次应用进度
