# SQL 填表 prompt 前 provider 当前视图同步修复验收

## 背景

用户反馈：SQL 模式下自动/手动填表时，prompt 中“当前表格数据”仍显示为空，但世界书和表格编辑器显示有数据。

这说明问题不再是旧聊天记录 checkpoint 是否生成，也不只是 SQL provider 是否能加载数据，而是填表 prompt 所读取的数据源与 SQL/editor/worldbook 当前视图之间仍存在不同步。

## 侦察结论

- `src/service/ai/prompt-builder/prompt-prepare.ts` 的 `prepareAIInput_ACU()` 直接读取全局 `currentJsonTableData_ACU`。
- SQL 模式下，`formatTableForSqliteMode()` 通过 `table.content.slice(1)` 输出当前数据；若只有表头，就输出 `-- (该表格为空，请进行初始化。)`。
- `src/service/table/update-orchestrator.ts` 的 `processUpdatesBatch_ACU()` 在每批填表前会构建 `mergedBatchData`，并调用 `loadBatchBaseData_ACU()` 尝试加载历史批基底。
- SQL 分支原逻辑只执行：

```ts
await getStorageProvider().replaceCurrentData(mergedBatchData as TableDataObject_ACU);
```

随后直接进入 `executeUpdate()`，没有显式把 provider 导出的当前视图同步回 `currentJsonTableData_ACU`。

## 根因

SQL/editor/worldbook 使用或可刷新到 provider 当前视图，但 prompt 构造仍依赖全局 JSON。

当 SQL provider 内部已能导出非空数据，而全局 JSON 仍停留在 header-only 结构时，prompt 会继续显示空表。

这不是 SQL 执行层问题，而是 `processUpdatesBatch_ACU()` 在 prompt 前缺少 provider → global JSON 的同步屏障。

## 修改内容

### 1. 修复 `processUpdatesBatch_ACU()` SQL 分支

文件：`src/service/table/update-orchestrator.ts`

修改点：SQL 模式下调用 provider 替换批基底后，立即调用 `provider.getCurrentData()`，并把结果写入全局 `currentJsonTableData_ACU`。

行为：

- provider 返回非空当前视图：写回 `_set_currentJsonTableData_ACU(providerCurrentData)`。
- provider 返回 null：回退写入 `mergedBatchData` 并记录 warning。

这样 `executeUpdate()` 内部的 prompt 构造会读取 provider 导出的真实当前视图，而不是旧的空表结构。

### 2. 补充回归测试

文件：`tests/service/table/update-orchestrator.test.ts`

修改点：

- 扩展 `getStorageProvider()` mock，加入 `getCurrentData()`。
- 强化既有 SQL batch 测试，断言 provider 当前视图被读取且全局 JSON 被同步。
- 新增回归用例：`SQL 模式下 provider 导出视图有数据时，执行填表前全局 JSON 不得停留在空表结构`。

该用例模拟：

- 模板基底只有表头。
- SQL provider 导出的当前视图包含数据行。
- `executeUpdate()` 被调用前，全局 `mockCurrentJsonTableData.sheet_0.content` 必须包含数据行。

### 3. 修复测试隔离问题

目标测试第一次运行时，`orchestrateManualUpdate_ACU — 表级 API 预设覆盖` 两个用例失败。

原因：前置 SQL 测试对 `parseTableTemplateJson_ACU()` 使用 `mockReturnValue()` 固定了返回值，`vi.clearAllMocks()` 不会恢复 mock implementation，导致后续 describe 依赖污染后的模板输入。

修复：在该 describe 的 `beforeEach()` 中显式设置 `parseTableTemplateJson_ACU()` 返回测试所需模板，避免跨用例污染。

## 验证结果

### 目标测试

命令：

```bash
npx vitest run tests/service/table/update-orchestrator.test.ts tests/service/ai/prompt-prepare-sql-mode.test.ts tests/service/table/sql-table-service.test.ts
```

结果：

- 3 个测试文件通过。
- 131 个测试通过。

### 类型检查

命令：

```bash
npm run typecheck
```

结果：通过。

### 正式构建与架构护栏

命令：

```bash
npm run build
```

结果：

- 生成 `dist/index.bundle.js`。
- 架构护栏总计违规：0 条。

### 全量测试

命令：

```bash
npm test
```

结果：

- 100 个测试文件通过。
- 2651 个测试通过。

## 非阻塞诊断说明

保存测试文件时，编辑器报告 `tsconfig.json` 中 `compilerOptions.baseUrl` 在 TypeScript 7.0 将弃用。

处理结论：

- 该诊断不是本次业务修复引入。
- 命令行 `npm run typecheck` 已通过。
- 不把无关配置变更混入本次 SQL 数据源修复，以避免扩大回归范围。

## 验收结论

本次修复解决的是 SQL 填表 prompt 前全局 JSON 与 provider 当前视图不同步的问题。

现在 SQL 模式每批填表前会形成明确同步链：

1. 构建/加载批次基底。
2. 用批次基底替换 SQL provider。
3. 从 provider 导出当前 JSON 视图。
4. 写回 `currentJsonTableData_ACU`。
5. 再进入 prompt/AI 填表流程。

因此，若世界书和表格编辑器可见的 provider 当前视图包含数据，填表 prompt 不应再停留在空表结构。
