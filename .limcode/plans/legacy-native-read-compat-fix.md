## TODO LIST

<!-- LIMCODE_TODO_LIST_START -->
- [x] 构造真实样本驱动的旧 native 复现测试：根元数据 chat_metadata.sheets + AI 消息顶层 TavernDB_ACU_Data，确认当前读取链路在哪一层丢失数据  `#legacy_native_fix_1`
- [x] 确认运行时聊天数组来源是否包含导入 JSONL 的消息级 TavernDB_ACU_Data，以及是否被 V2 checkpoint、模板 seed 或清理路径遮蔽  `#legacy_native_fix_2`
- [x] 按复现结果实施最小兼容修复：优先修消息级 TavernDB_ACU_Data 读取/迁移链路；仅在无消息级数据时把 chat_metadata.sheets 转换作为保护性 fallback  `#legacy_native_fix_3`
- [x] 补充 migration、helpers 合并入口、native provider、SQLite provider 回归测试，覆盖样本 uid sheet key、summary/outline、模板元数据不误当历史行  `#legacy_native_fix_4`
- [x] 运行定向 vitest、关键回归、tsc、rollup，并处理失败  `#legacy_native_fix_5`
- [x] 调用验收专家复查，重点审查是否真正覆盖用户样本、标准 legacy、V2 优先级与 chat_metadata fallback 边界  `#legacy_native_fix_6`
- [x] 验收通过后归档 analysis、覆盖 index.js、提交、打 tag spv4.6.4、推送发布  `#legacy_native_fix_7`
<!-- LIMCODE_TODO_LIST_END -->

# 旧原生模式记录读取兼容修复计划

## 0. 计划来源与当前边界

**计划来源**：助手直接需求与真实旧聊天样本。用户反馈：合并外部 pull request 后，旧原生模式聊天记录无法读取；用户明确表示没有使用数据隔离功能，隔离码始终为空；随后提供真实 JSONL 样本 `娇妻沦为仇敌性奴 - 2025-10-29@00h25m09s.jsonl`。

**当前模式约束**：Plan Mode。本文档只修订实施计划，不修改业务代码。必须等待助手确认计划后才能进入实现。

**第三次纠偏**：上一轮根据样本第 1 行 `chat_metadata.sheets` 过快得出“旧记录完全是 chat_metadata.sheets 格式”的判断。继续沿着这个方向硬修，会把模板元数据当成历史表格主数据，漏洞明显得像是故意排给事故看的。重新读取样本后，证据更精确：

- 第 1 行 `chat_metadata.sheets` 存在旧式 sheet 元数据、表头、source note 与模板配置，但它主要像“聊天级模板/元数据”。
- 第 2、4、6、8 行 AI 消息存在顶层 `TavernDB_ACU_Data`，且其中包含完整历史 `content` 行，例如 `全局数据表`、`主角信息`、`重要人物表`、`总结表`、`总体大纲` 等。
- 因此主修复方向不能直接变成“只转换 chat_metadata.sheets”。真正要先复现的是：**样本里这种顶层 `TavernDB_ACU_Data` 为什么在当前加载链路中仍未被迁移/合并/展示。**

---

## 1. 已确认源码与样本证据

### 1.1 源码没有读取 `chat_metadata.sheets` 的实现路径

搜索结果：

- `chat_metadata`：源码中无读取实现；仅样本文件和 `@types/iframe/exported.sillytavern.d.ts` 的 `chatMetadata` 类型说明命中。
- `cellHistory` / `hashSheet`：仅真实样本命中，源码无转换器。
- `sheets`：源码大量命中的是当前 `chatSheets` / sheet 业务对象，不是 SillyTavern 根 `chat_metadata.sheets` 读取路径。

结论：如果只剩 `chat_metadata.sheets`，当前代码确实读不到；但这不是样本中历史数据的唯一来源。

### 1.2 样本第 1 行 `chat_metadata.sheets` 是旧式元数据结构

样本第 1 行包含：

- `chat_metadata.sheets[]`
- sheet uid：`sheet_vxHmOjru`、`sheet_ZCsAnd6o`、`sheet_lTSbFKaY` 等
- `hashSheet`：二维 cell uid 矩阵
- `cellHistory`：包括 `type: "sheet_origin"` 和 `type: "column_header"`
- `config`、`template`、`selected_sheets`

这部分可转换为当前 `Sheet_ACU` 的一部分字段：

- `uid`、`name`、`config`
- `sourceData`：来自 `sheet_origin.data.note/initNode/deleteNode/updateNode/insertNode`
- `content[0]`：由 `column_header.data.value` 组成，首列补 `null` 或后续迁移为 `row_id`

但样本第 1 行没有历史数据行，只有表头和模板元数据。把它作为主数据会得到空表，正好复现“历史表格变空模板”的灾难。

### 1.3 样本 AI 消息存在完整顶层 `TavernDB_ACU_Data`

样本第 2、4、6、8 行 AI 消息包含顶层：

```json
"TavernDB_ACU_Data": {
  "sheet_dCudvUnH": { "name": "全局数据表", "content": [[null, "主角当前所在地点", ...], [null, "老旧公寓楼三楼家门口", ...]] },
  "sheet_DpKcVGqg": { "name": "主角信息", "content": [[null, "人物名称", ...], [null, "陈默", ...]] },
  "sheet_3NoMc1wI": { "name": "总结表", "content": [[null, "时间跨度", "纪要", "编码索引"], ...] },
  "sheet_PfzcX5v2": { "name": "总体大纲", "content": [[null, "大纲", "编码索引"], ...] },
  "mate": { "type": "chatSheets", "version": 1 }
}
```

这些 sheet key 虽然不是 `sheet_0` / `sheet_1`，但都以 `sheet_` 开头，按 `table-delta-migration.ts` 的 `shouldAcceptSheet_ACU()` 理论上应被接受。

### 1.4 当前 migration 层理论上会读取 `TavernDB_ACU_Data`

`src/service/table/table-delta-migration.ts:126-140` 在隔离匹配后会依次读取：

```ts
const legacyIndependent = readLegacyIndependentData_ACU(message);
mergeIndependentSnapshot_ACU(data, foundSheets, legacyIndependent, activeTemplateSheetKeySet);
readModifiedKeys_ACU(message).forEach(key => modifiedKeys.add(key));
readUpdateGroupKeys_ACU(message).forEach(key => updateGroupKeys.add(key));

mergeLegacyContainer_ACU(data, foundSheets, readLegacyStandardData_ACU(message) as Record<string, unknown> | null, {
  templateSheetKeySet: activeTemplateSheetKeySet,
  summaryOnly: false,
});
mergeLegacyContainer_ACU(data, foundSheets, readLegacySummaryData_ACU(message) as Record<string, unknown> | null, {
  templateSheetKeySet: activeTemplateSheetKeySet,
  summaryOnly: true,
});
```

而 `mergeLegacyContainer_ACU()` 接受 `sheet_` 前缀且 `content` 为数组的 sheet-like 对象。

这造成一个新的关键矛盾：**样本中的消息级 `TavernDB_ACU_Data` 看起来符合当前 reader；如果用户现场仍读不到，丢失点很可能不在 `readLegacyStandardData_ACU()` 本身，而在扫描入口、V2 优先级、模板过滤、provider load 时序、或加载后被初始化覆盖。**

---

## 2. 当前根因判断

### 2.1 已撤回的错误主因

1. **撤回**：“隔离开启 identity 过滤”是用户现场主因。用户明确无隔离，源码也显示隔离关闭时无 identity 应匹配。
2. **撤回**：“旧记录完全是 `chat_metadata.sheets`，当前 `TavernDB_ACU_*` reader 完全不会命中”。样本 AI 消息明明有顶层 `TavernDB_ACU_Data`，忽略它就是读证据读一半。

### 2.2 当前可靠判断

主根因尚未能在不运行测试的情况下最终确认，但已被收敛为以下链路之一：

#### 方向 A：provider / helper 实际扫描的 chat 不含消息级 `TavernDB_ACU_Data`

`mergeAllIndependentTablesWithMeta_ACU()` 读取 `getChatArray_ACU()`。如果 JSONL 导入后宿主将根 metadata 与消息数组分离，或 provider reload 时 chat 尚未准备好，就会扫描不到带顶层数据的 AI 消息。

#### 方向 B：已有 V2 checkpoint 或模板 seed 抢先返回/覆盖

`reconstructTablesFromChatDeltas_ACU()` 对 V2 checkpoint 有优先级。如果存在空 checkpoint、模板 seed checkpoint 或错误 checkpoint，就可能阻止 legacy fallback，导致旧数据不再参与合并。

#### 方向 C：模板 sheet key 过滤导致样本 uid sheet 被全部过滤

`buildLegacyCheckpointFromChat_ACU()` 首轮会使用 `templateSheetKeys` 过滤；样本消息里的数据 sheet key 如 `sheet_dCudvUnH`，而 `chat_metadata.sheets` 的模板 uid 是 `sheet_vxHmOjru` 等，二者不一致。源码已有 fallback：首轮 `foundSheets.size === 0 && templateSheetKeySet` 时会不带模板过滤重扫。但必须用样本 fixture 验证 fallback 在真实入口是否生效。

#### 方向 D：加载后又被新开卡/模板初始化覆盖

`loadOrCreateJsonTableFromChatHistory_ACU()`、native adapter、SQLite provider 入口如果把“未读到旧数据”解释为新聊天，可能初始化模板并覆盖展示结果。这个方向能解释用户看到“初始化为空模板”。

#### 方向 E：只剩 `chat_metadata.sheets` 的极端旧格式未覆盖

如果某些旧聊天只有根 `chat_metadata.sheets`，无消息级 `TavernDB_ACU_Data`，当前源码确实无读取路径。这个应作为保护性 fallback，而不是优先于消息级数据的主路径。

---

## 3. 修复原则

1. **消息级历史数据优先**：只要任一 AI 消息存在有效 `TavernDB_ACU_Data` / `TavernDB_ACU_IndependentData` / `TavernDB_ACU_SummaryData`，必须优先使用它们。
2. **`chat_metadata.sheets` 只能作为 fallback**：仅当消息级 legacy 与 V2 都没有有效 sheet 时，才考虑从根 metadata 转换表头/模板基底。否则会把历史行降级为空模板。
3. **不全局放宽隔离匹配**：用户现场无隔离，修复不应引入跨隔离串读。
4. **不 monkey patch bundle**：必须源码修复、测试、类型检查、构建、验收、归档、打包发布。
5. **V2 有效 checkpoint 优先级不破坏**：只有空/错误 checkpoint 或模板 seed 空壳遮蔽 legacy 时才允许 fallback。
6. **修复最小化**：优先修读取/迁移链路，不重构表格模型，不引入无关抽象。

---

## 4. 实施阶段拆解

### 阶段 A：样本驱动复现测试

目标：不用猜，直接把真实样本结构压进测试，锁定丢失层级。

#### A1. migration 层 fixture

在 `tests/service/table/table-delta-reconstruct.test.ts` 或新增相邻测试中构造：

1. `chat[0]` 模拟 JSONL 根 metadata：包含 `chat_metadata.sheets`，但不是 AI 消息。
2. 后续 AI 消息包含顶层 `TavernDB_ACU_Data`，sheet key 使用样本风格 `sheet_dCudvUnH`、`sheet_DpKcVGqg`、`sheet_3NoMc1wI`。
3. `content[0][0] === null`，验证迁移后变为 `row_id`，数据行首列变为字符串 id。
4. context 为 `{ enabled: false, code: '' }`。

验收：`reconstructTablesFromChatDeltas_ACU()` 返回非空数据，包含历史行，不是只有表头。

#### A2. 模板 key 不匹配 fallback 测试

构造 `templateSheetKeys` 为 `chat_metadata.sheets` 的 uid（如 `sheet_vxHmOjru`），消息级数据为另一组 uid（如 `sheet_dCudvUnH`）。

验收：首轮模板过滤失败后，无过滤重扫必须找回消息级数据。

#### A3. summary/outline 分流测试

样本里 `总结表`、`总体大纲` 也在 `TavernDB_ACU_Data` 内。测试必须确认：

- 非 summary 表通过 `summaryOnly: false` 合并；
- summary/outline 表通过 `summaryOnly: true` 合并；
- 最终 checkpoint 同时包含两类表。

#### A4. `chat_metadata.sheets` fallback 测试

构造只有根 `chat_metadata.sheets`、没有消息级 `TavernDB_ACU_Data` 的聊天。

验收：如果实现 fallback，结果只能产生表头/源数据，不得伪造历史行；并且当消息级数据存在时，fallback 不得覆盖消息级数据。

### 阶段 B：定位丢失入口

基于 A 阶段结果分支处理。

#### B1. migration 层失败

如果 `reconstructTablesFromChatDeltas_ACU()` 对样本结构失败，修复点在：

- `readLegacyStandardData_ACU()` 是否接受样本字段；
- `mergeLegacyContainer_ACU()` 是否误过滤；
- `templateSheetKeySet` fallback 是否未生效；
- `isSummaryOrOutlineTable_ACU()` 是否导致 summary/outline 丢失。

#### B2. migration 层通过，helper/provider 失败

如果 migration 单测通过，但 `mergeAllIndependentTablesWithMeta_ACU()` / provider 失败，修复点转向：

- `getChatArray_ACU()` 实际返回内容；
- `foundCount` 与 guide/template 空壳判断；
- `loadOrCreateJsonTableFromChatHistory_ACU()` 是否误走初始化；
- `SqlTableService.loadFromChat()` 是否只看 V2 或迁移后的空状态。

#### B3. V2 checkpoint 遮蔽 legacy

如果存在空/模板 seed V2 checkpoint 抢先返回，则修复 `src/service/table/table-delta-reconstruct.ts`：

- 有效 V2 checkpoint 保持最高优先级；
- 无任何 sheet 的 checkpoint 不得永久阻止 legacy fallback；
- 模板 seed 若只有空表而更早 legacy 有历史行，应允许 legacy 补齐或替代；
- 必须测试有效 V2 不被旧 legacy 污染。

#### B4. 根 metadata fallback 缺失

如果确有旧聊天只有 `chat_metadata.sheets`，新增独立转换函数，建议放在 `src/service/table/table-delta-migration.ts` 或同目录 helper：

- 输入：根 message / chat metadata 的 `sheets` 数组；
- 输出：`TableDataObject_ACU` 兼容片段；
- 映射：
  - sheet key 保留原 `uid`，只要求 `startsWith('sheet_')`；
  - `sourceData` 来自 `sheet_origin.data`；
  - `content[0] = [null, ...column_header.data.value]`；
  - `config` 可保留到 sheet 或映射为现有字段时需验证类型；
  - 缺失 `updateConfig` / `exportConfig` 时使用当前默认构造逻辑，不能塞半截对象。
- 限制：不伪造数据行，不覆盖消息级数据。

### 阶段 C：provider 与展示入口回归

补充或强化测试：

1. `mergeAllIndependentTablesWithMeta_ACU()`：样本风格旧消息返回 `data` 非空，`foundSheetCount > 0`，不是 guide/template 空壳。
2. `loadOrCreateJsonTableFromChatHistory_ACU()` 或 `NativeTableServiceAdapter.loadFromChat()`：返回 merged/loaded，不走初始化空模板。
3. `SqlTableService.loadFromChat()`：旧 native 数据可导入 SQLite，并至少能查询到 `主角信息`、`总结表` 的历史行。
4. 新开卡/空聊天仍不提前建表。
5. 有效 V2 checkpoint 仍优先，不被更早 legacy 覆盖。

### 阶段 D：隔离开启 orphan fallback 保护项

这是附带要求，不是主修复。

仅在主修复完成后，单独评估：隔离开启时，如果当前隔离无数据、无 V2、无 tag data，但存在无 identity 的旧 legacy，是否允许一次性 orphan fallback。

控制条件必须很严：

- 只在当前隔离完全无数据时触发；
- 不覆盖已有当前隔离数据；
- 打日志提示是 legacy orphan fallback；
- 有测试证明不会跨隔离污染。

### 阶段 E：验证与验收

执行顺序：

1. 定向测试：
   - `npx vitest run tests/service/table/table-delta-reconstruct.test.ts`
   - `npx vitest run tests/service/table/table-service.test.ts`
   - `npx vitest run tests/service/table/native-table-service-adapter.test.ts`
   - `npx vitest run tests/service/table/sql-table-service.test.ts`
2. 必要时新增 helper/runtime 定向测试。
3. 全量或关键回归：`npx vitest run`
4. 类型检查：`npx tsc --noEmit`
5. 构建：`npx rollup -c`
6. 调用验收专家复查。
7. 根据验收意见修正并再次复查，直到无阻塞。

### 阶段 F：归档与发布

验收通过后：

1. 归档 `.analysis-cache.md` 到 `.analysis-archive/YYYY-MM-DD_HHMM_旧原生模式读取兼容修复.md`。
2. 清理或更新 `.analysis-cache.md`。
3. `npx rollup -c`。
4. 覆盖 `dist/index.bundle.js` 到 `index.js`。
5. 提交，建议 message：`spv4.6.4: 修复旧原生模式记录读取兼容`。
6. 打 tag：`spv4.6.4`。
7. 推送 main 与 tag。

---

## 5. 验收标准

修复必须满足：

1. 用户样本结构：根 `chat_metadata.sheets` + AI 消息顶层 `TavernDB_ACU_Data` 可读取历史表格数据。
2. 展示结果不是空模板，至少保留样本中的历史行：`主角信息`、`重要人物表`、`总结表`、`总体大纲`。
3. 样本 uid 风格 `sheet_dCudvUnH` 等非连续编号 sheet key 可正常迁移。
4. `content[0][0] === null` 的旧格式迁移为 `row_id`，数据行首列稳定补 id。
5. 模板 key 与数据 key 不一致时，不因模板过滤丢失全部旧数据。
6. 如实现 `chat_metadata.sheets` fallback，只在无消息级数据时触发，不覆盖历史行，不伪造数据行。
7. 标准顶层 legacy object 仍可读取。
8. 空/错误 V2 checkpoint 不永久遮蔽有效 legacy；有效 V2 checkpoint 仍优先。
9. native provider 返回 loaded/merged，不误初始化。
10. SQLite provider 能导入旧 native 数据。
11. 新开卡/空聊天不提前建表。
12. 不引入跨隔离串读。
13. 定向测试、关键回归、类型检查、rollup 构建通过。
14. 验收专家无阻塞意见。

---

## 6. 风险与回滚策略

| 风险 | 影响 | 控制措施 |
|---|---|---|
| 把 `chat_metadata.sheets` 当主数据 | 历史行被降级为空表头，用户问题继续存在 | 消息级 `TavernDB_ACU_Data` 优先；metadata 仅 fallback |
| 只测 migration，不测 provider | 单测通过但 UI 仍初始化为空模板 | 必须覆盖 helpers/native/SQLite 入口 |
| 模板 key 过滤过严 | 样本 uid sheet 被全过滤 | 保留并测试无过滤重扫 fallback |
| 空 checkpoint fallback 过宽 | V2 数据被旧 legacy 污染 | 只对无 sheet/空壳 checkpoint 放行；有效 V2 优先测试 |
| metadata 转换塞半截 sheet | UI/SQL 读取字段缺失导致运行时异常 | 复用现有默认构造逻辑，补齐必要字段 |
| orphan fallback 跨隔离串读 | 隔离用户数据污染 | 作为独立保护项，严格条件触发 |

**回滚策略**：

1. 修复只增加读取兼容或纠正 fallback，不删除旧字段。
2. 不采用 monkey patch。
3. 发布异常可回退提交/tag 并重建 `index.js`。
4. 如涉及 checkpoint 写入，必须保持旧字段不被提前删除，确保回滚仍可读。

---

## 7. 自我审查

这版计划修正了一个危险偏差：真实样本不是单纯 `chat_metadata.sheets`，消息级 `TavernDB_ACU_Data` 才包含历史行。继续把 metadata 转换当主修复，只会制造“能显示表头但历史仍丢”的假修复。

当前计划仍有一个硬缺口：尚未通过测试运行确认丢失点到底在 migration、helper/provider、V2 优先级还是初始化覆盖。所以下一步必须先写样本驱动复现测试，而不是直接往 reader 里塞转换器。能列修复方向不等于已经知道该修哪里，助手，别把路线图当成诊断报告。
