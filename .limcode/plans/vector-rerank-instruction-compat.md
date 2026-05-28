## TODO LIST

<!-- LIMCODE_TODO_LIST_START -->
- [x] 为向量配置新增 rerankInstruction 默认提示词、类型字段与 normalize 兼容，并区分缺失字段与用户清空  `#p1`
- [x] 在 runtime 内联 Rerank 与 vector-rerank-gateway 请求体中默认兼容非空 instruction 字段  `#p2`
- [x] 在新版向量 API 配置表单中新增重排指令默认显示、编辑、清空关闭与保存  `#p3`
- [x] 补充 gateway 与 UI 配置保存测试，覆盖默认启用、修改保存、清空关闭，必要时补 runtime 请求体测试  `#p4`
- [x] 执行 typecheck、定向测试与必要构建，并区分既有诊断与本次回归  `#p5`
<!-- LIMCODE_TODO_LIST_END -->

# 向量 Rerank 指令参数默认启用兼容实施计划

## 1. 计划来源与目标边界

来源：助手直接需求与补充要求：
- 初始需求：给向量的 Rerank 功能加上指令参数兼容，指明要跟当前用户输入及关键词相关的条目降序排列。
- 补充要求：默认启用，并将上述要求作为默认提示词在 UI 里显示填写，用户也可以自行修改。

目标：
- Rerank 请求体兼容可选 `instruction` 参数。
- `instruction` 默认启用：旧配置缺失字段时自动得到默认提示词，并在新版 UI 中显示。
- 默认提示词明确表达助手的要求：按“当前用户输入及关键词相关性”对候选条目降序排列。
- 用户可以在 UI 中修改该提示词；用户主动清空时不发送 `instruction`，作为兼容不支持该字段的服务的逃生口。
- 保持现有 `query = 用户输入 + 关键词`、embedding 预筛、TopK、最近固定写入、最终 rowOrder 注入规则不变。

非目标：
- 不重构整个向量召回链路。
- 不改变关键词生成提示词逻辑。
- 不改变最终注入条目的 rowOrder 恢复排序规则。
- 不强制所有 Rerank 服务支持 instruction；默认发送，但允许用户清空关闭。

## 2. 已确认现状

已读取并确认：
- `src/service/vector/summary-vector-index-runtime.ts`
  - `queryText` 当前由 `userInput` 与 `keywords.join('，')` 拼接。
  - `rerankCandidates_ACU(config, queryText, candidates)` 内联发起 Rerank 请求，请求体当前只有 `model/query/documents`。
- `src/data/gateways/vector-rerank-gateway.ts`
  - 存在独立 `createRerankScores_ACU`，但当前未被运行时调用。
  - 请求接口当前无 `instruction`。
- `src/service/vector/vector-memory-config.ts`
  - `VectorMemoryConfig_ACU` 与 normalize 流程已有 `rerankEndpoint/rerankApiKey/rerankModel`，无 `rerankInstruction`。
- `src/shared/defaults.ts`
  - 默认配置有 Rerank 三字段，无指令默认值。
- `src/presentation-v2/composables/useVectorApiConfig.ts` 与 `src/presentation-v2/pages/VectorIndexPage.vue`
  - 新版向量 API 设置页只保存 endpoint/model/apiKey。
- 测试现状：
  - 无 Rerank 请求体测试。
  - `tests/presentation-v2/api/vector-api-config.test.ts` 覆盖配置保存。

## 3. 关键设计决策

1. 新增配置字段：`rerankInstruction: string`。
2. 默认提示词写入 `defaultVectorMemoryConfig_ACU.rerankInstruction`，建议使用：
   `请根据当前用户输入及关键词，判断每个候选纪要条目的相关性，并将最相关的条目按相关性从高到低降序排列。优先选择能够直接回答、延续或补全当前用户输入意图的条目。`
3. 默认启用的实现方式：
   - 旧配置没有 `rerankInstruction` 字段时，`normalizeVectorMemoryConfig_ACU` 使用默认提示词补齐。
   - UI `refresh()` 读取 normalize 后配置，因此默认提示词会直接显示在 Rerank 设置区域。
   - 用户保存修改后的文本；若用户清空，则保存空字符串，运行时不发送 `instruction`。
4. Rerank 请求体只在 `instruction.trim()` 非空时附带 `instruction`。
5. `query` 保留当前 `queryText`，因为 embedding 与 rerank 都依赖用户输入 + 关键词语义。
6. runtime 内联 Rerank 与独立 gateway 同步兼容字段，避免未来调用 gateway 时出现两套协议。助手，这种双实现本来就不优雅，继续让它们漂移只是在给维护者埋雷。

## 4. 实施步骤

### P1 配置模型与默认值

修改：
- `src/shared/defaults.ts`
  - 在 `rerankModel` 附近新增 `rerankInstruction`，值为默认提示词。
- `src/service/vector/vector-memory-config.ts`
  - `VectorMemoryConfig_ACU` 新增 `rerankInstruction: string`。
  - `normalizeVectorMemoryConfig_ACU` 新增字段归一化：缺失时使用默认提示词；字符串存在时 trim，允许空字符串。

验收：
- 旧配置缺失该字段时，读取后 UI 能显示默认提示词。
- 用户主动保存空字符串后，normalize 不应重新强行填回默认值，否则用户无法关闭 instruction。

### P2 Rerank 请求构造兼容 instruction

修改：
- `src/service/vector/summary-vector-index-runtime.ts`
  - 构造 Rerank body：`model/query/documents` 保持不变。
  - 读取 `config.rerankInstruction`，trim 后非空则加入 `instruction`。
  - 保持 Rerank 失败时回退 embedding 排序。
- `src/data/gateways/vector-rerank-gateway.ts`
  - `VectorRerankRequest_ACU` 新增 `instruction?: string`。
  - `createRerankScores_ACU` 非空 instruction 写入请求体。

验收：
- 默认配置下请求体包含 `instruction`。
- 用户清空指令后请求体不包含 `instruction`。
- 响应解析、排序降序逻辑不变。

### P3 UI 与保存链路

修改：
- `src/presentation-v2/composables/useVectorApiConfig.ts`
  - `VectorApiForm`、`createEmptyForm`、`refresh`、`save` 增加 `rerankInstruction`。
  - 保存时 trim 文本。
- `src/presentation-v2/pages/VectorIndexPage.vue`
  - 在 Rerank fieldset 中新增“重排指令”控件。
  - 默认显示配置中的提示词。
  - 加 hint：默认启用；清空后不向 Rerank 服务发送 instruction，可用于兼容不支持该字段的服务。
  - 若现有 `AcuInput` 不支持 textarea，不为了这一个字段扩展抽象，使用普通 `<textarea>` 并沿用局部样式。

验收：
- 打开页面即可看到默认提示词。
- 修改后保存，刷新仍回显修改值。
- 清空后保存，刷新仍为空，不被默认值覆盖。

### P4 测试覆盖

新增/修改：
- 新增 `tests/data/gateways/vector-rerank-gateway.test.ts`
  - mock `fetch`，断言 instruction 非空时写入请求体。
  - 断言 instruction 为空时不写入字段。
- 修改 `tests/presentation-v2/api/vector-api-config.test.ts`
  - refresh 初始值包含默认/现有 `rerankInstruction`。
  - 合法配置保存时断言 `rerankInstruction` 被 trim 后写回。
  - 增加清空保存用例，确保空字符串能保留，不被默认值强制覆盖。
- 视 mock 成本新增 `tests/service/vector/summary-vector-index-runtime.test.ts`
  - 覆盖 runtime 内联 Rerank 请求体默认包含 instruction。

验收命令：
- `npm run typecheck`
- `npm test -- tests/data/gateways/vector-rerank-gateway.test.ts tests/presentation-v2/api/vector-api-config.test.ts`
- 必要时 `npm run build:nocheck`

已知诊断：当前工作区已有 `jquery` 类型定义缺失与 `baseUrl` 弃用诊断。执行验收时必须区分既有环境问题与本次新增问题，别把旧伤说成新事故，也别把新事故藏进旧伤里。

## 5. 风险与回滚

风险：
- 部分 Rerank 服务不接受未知 `instruction` 字段，默认启用后可能返回 400。
  - 缓解：UI 明确提示可清空关闭；运行时已有失败回退到 embedding 排序。
- normalize 若处理不当，会导致用户清空后又被默认值填回。
  - 缓解：区分“字段不存在”和“字段存在但为空字符串”。这是本次最容易写错的点，别用一行 `|| default` 把用户意图吃掉。
- runtime 与 gateway 双实现继续增加维护成本。
  - 缓解：本次同步字段与测试；后续单独计划统一 runtime 调用 gateway。

回滚：
- 删除 `rerankInstruction` 默认值、类型字段、normalize、UI 字段、请求体附加逻辑和相关测试即可回到旧行为。
- 已保存配置中残留的 `rerankInstruction` 在旧代码下不会被读取，副作用可控。

## 6. 自检

这版计划已经吸收“默认启用 + UI 默认提示词可改”的补充要求。质量比上一版更接近可交付，但仍有一个技术债没有处理：runtime 内联 Rerank 与 gateway 并存。为了控制变更范围，本计划不做重构；如果助手之后想把这块做干净，应另开计划把 runtime 迁移到 `createRerankScores_ACU`。
