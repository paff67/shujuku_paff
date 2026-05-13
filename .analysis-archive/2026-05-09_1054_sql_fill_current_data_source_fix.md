<analysis>
任务：检查自动/手动填表在 SQL 与原生模式下，到底以什么来源作为“当前表格数据”，并修复旧聊天迁移后仍显示为空/填表基底为空的问题。

已确认事实：
1. 自动填表入口：`executeAutoUpdatePlan_ACU` -> `processUpdates_ACU` -> `processUpdatesBatch_ACU` -> `executeCardUpdateCore_ACU`。
2. 手动填表入口：`handleManualUpdate_ACU` -> `orchestrateManualUpdate_ACU` -> `processUpdates_ACU` -> `processUpdatesBatch_ACU` -> `executeCardUpdateCore_ACU`。
3. 每批填表前，`processUpdatesBatch_ACU` 会调用 `buildBatchMergeBase_ACU` 以指导表/模板生成基底，然后调用 `loadBatchBaseData_ACU` 从聊天记录重建该批开始楼层之前的数据，最后 `_set_currentJsonTableData_ACU(mergedBatchData)`。
4. 提示词构造 `prepareAIInput_ACU` 完全直接读取 `currentJsonTableData_ACU`，不读取 `ITableStorageProvider.getCurrentData()`。
5. 原生 DSL 编辑解析 `parseAndApplyTableEdits_ACU` 直接修改 `currentJsonTableData_ACU`。
6. SQL 编辑解析只有在 SQL 内容分支中才调用 `getStorageProvider().applyEdits()`，由 `SqlTableService` 执行 SQL 并同步回 `currentJsonTableData_ACU`。
7. `refreshMergedDataAndNotify_ACU` 当前绕过存储 provider，直接调用 `mergeAllIndependentTables_ACU` 并写入 `currentJsonTableData_ACU`；在 SQL 模式下，这会造成 provider 内存库与全局 JSON 视图不是同一个读取抽象。
8. 启动/切卡/滑动等位置虽然在 SQL 模式下调用了 `reloadStorageProvider()`，但随后又调用 `refreshMergedDataAndNotifyWithUI_ACU()`，后者进入 `refreshMergedDataAndNotify_ACU`，可能再次用直连 merge 覆盖全局状态。

四象限来源图：
- 自动 + 原生：批处理每批从 `reconstructTablesFromChatDeltas_ACU` 重建到 `currentJsonTableData_ACU`，提示词和 DSL 应用都使用这个全局对象。
- 手动 + 原生：手动前先调用刷新函数，之后仍进入同一批处理；提示词和 DSL 应用都使用 `currentJsonTableData_ACU`。
- 自动 + SQL：批处理提示词仍使用 `currentJsonTableData_ACU`；SQL 写入时才使用 `getStorageProvider().applyEdits()`。如果 provider 未按同一批基底重载，SQL 写入的 SQLite 状态可能与提示词基底不一致。
- 手动 + SQL：手动前刷新函数先绕过 provider 写全局状态；清空场景会 `reloadStorageProvider()`，但随后刷新仍可能覆盖全局状态；批处理提示词仍读全局状态，SQL 写入读 provider。

根因判断：
当前系统存在两个“当前数据源”：
1. 全局 JSON：`currentJsonTableData_ACU`，用于提示词、原生 DSL、UI 与世界书刷新。
2. SQL provider：`SqlTableService` 的 SQLite engine/committedSnapshot，用于 SQL 执行与导出。

这两个源在刷新链路和批处理链路没有统一。能跑不等于设计合格，这里明显是双写源风险：读提示词用 A，写 SQL 用 B，保存快照又用 A/B 混合结果。旧聊天迁移时，哪怕 checkpoint 已经生成，如果刷新链路或批处理链路绕过 provider 或以模板 key 限制过滤旧 sheet，用户仍会看到“当前表格数据为空”。

拟定修复方向：
1. 新增统一刷新工具，让 `refreshMergedDataAndNotify_ACU` 在 SQL 模式下优先通过 `reloadStorageProvider()`/provider `loadFromChat()` 获取当前数据，再用 `getCurrentData()` 同步全局 JSON，禁止直连 merge 覆盖 SQL provider 状态。
2. 批处理 SQL 模式下，在每批 `loadBatchBaseData_ACU` 重建完批基底并写入 `currentJsonTableData_ACU` 后，必须让 SQL provider 与该批基底同步，否则提示词看到的是批基底，SQL 执行的数据库却还是全局最新或旧 provider 内存态。
3. 若短期不新增 provider 批基底加载接口，则 SQL 模式批处理前应重建 provider 并确认全局数据；但这无法处理“按 batch firstMessageIndexExclusive 的历史基底”，因此更可靠的是增加 provider 方法或专门的 `loadFromTableData` 同步入口。当前 `ITableStorageProvider` 没有该接口，强行类型逃逸会污染抽象，不合格。
4. 更小且稳的修复：在 `executeCardUpdateCore_ACU` 开始前对 SQL 模式调用 `getStorageProvider().getCurrentData()` 只能同步 provider->JSON，不能把批基底写入 provider，方向错误。
5. 推荐修复：扩展 `ITableStorageProvider` 增加 `loadFromTableData(data, options?)` 或 `replaceCurrentData(data)`，Native 实现设置全局 JSON，SQL 实现重建 SQLite/SyncBridge 并加载该 JSON，同时标记 committed snapshot。批处理设置 `currentJsonTableData_ACU` 后调用该接口，使四象限都以同一批基底为源。

影响范围：
- `src/shared/table-storage-provider.ts`
- `src/service/table/native-table-service-adapter.ts`
- `src/service/table/sql-table-service.ts`
- `src/service/table/update-orchestrator.ts`
- `src/service/worldbook/pipeline.ts`
- 相关测试：`tests/service/table/update-orchestrator.test.ts`、`tests/service/table/sql-table-service.test.ts`、`tests/service/worldbook/pipeline.test.ts`

降级检查：
不接受回退到原生模式，不接受 build:nocheck，不接受绕过类型系统的 any 私有方法调用作为正式修复。修复必须保持 SQL 模式严格走 provider，原生模式行为兼容。
</analysis>

---

<decision_point>
issue: 目标测试中 tests/service/table/sql-table-service.test.ts 的 replaceCurrentData 回归用例失败。失败点不是生产实现无法重建 SQLite，而是测试断言把 currentJsonTableData_ACU 预期为 SQLite 导出后的数值类型；实际 replaceCurrentData(data) 先按传入的批次 JSON 快照同步全局 JSON 视图，因此 row_id 和 quantity 保持旧聊天快照中的字符串 "9"、"1"。SQLite 查询结果本身已返回数值 9、1，说明 SQLite 引擎重建成功。这个问题在侦察/分析阶段没有预见到，是因为当时没有验证 SyncBridge.loadFromTableData 与全局 JSON 同步之间的类型归一化时机。
impact: YES。影响范围限定在新增测试断言与 replaceCurrentData 的语义定义。如果草率把生产代码改成导出 SQLite 后再覆盖全局 JSON，可能改变提示词看到的旧聊天原始快照类型，造成填表上下文与历史快照不完全一致；如果只改测试，也必须确认这不是掩盖实现缺陷。
context_update: analysis 中“replaceCurrentData 用批次 JSON 快照替换 provider 数据源”的语义需要精确定义为：SQLite provider 必须加载该快照到 SQL 引擎，同时全局 JSON 视图应保持批次基底快照内容，用于提示词构建；SQL 查询结果允许按 SQLite 类型系统返回数值。edge_cases 增加“旧聊天 JSON 中数字可能以字符串保存，提示词视图不应被 SQLite 类型归一化意外改写”。
options:
  - option_a:
      description: 修改生产实现，在 replaceCurrentData(data) 后立即从 SQLite 导出数据并覆盖 currentJsonTableData_ACU，使 JSON 视图与 SQLite 类型完全一致。
      approach_evaluation: 可维护性 2/5，因为 replaceCurrentData 的输入语义从“替换为批次基底”变成“替换为 SQLite 归一化后的派生数据”，调用方很难判断提示词看到的是原始历史快照还是派生快照；健壮性 2/5，因为旧聊天快照字符串数字会被无声改变，可能影响 AI prompt 中表格数据表达；可扩展性 2/5，因为未来如果 SyncBridge 增加类型推断规则，prompt 数据会随 SQL 导出策略变化而变化。
      edge_cases: 旧历史中的字符串数字、空字符串、前导零编码、row_id 字符串等可能被 SQLite 类型系统改写；表格提示词与原始 checkpoint 内容不再一致。
      affected_scope_delta: 需要变更 src/service/table/sql-table-service.ts，并调整 tests/service/table/sql-table-service.test.ts。
  - option_b:
      description: 保持生产实现不变，修正测试断言：SQL 查询结果断言数值类型，currentJsonTableData_ACU 断言保持传入批次 JSON 快照的字符串类型。该方案明确区分“SQL 引擎执行视图”和“提示词 JSON 快照视图”。
      approach_evaluation: 可维护性 5/5，因为测试语义与方法职责一致，replaceCurrentData 的调用方可以稳定理解为“把当前批次基底作为当前数据源”；健壮性 5/5，因为它同时验证 SQLite 旧数据已清除并加载新快照，以及全局 JSON 视图未被 SQL 类型系统意外污染；可扩展性 5/5，因为未来 SQL 导出类型规则变化不会破坏 prompt 基底保持原始快照的契约。
      edge_cases: 旧聊天快照中数字为字符串时，prompt 视图保持字符串；SQLite 查询仍按列亲和性返回数值；旧内存库数据必须被清除。
      affected_scope_delta: 仅需变更 tests/service/table/sql-table-service.test.ts 的新增用例断言。
  - option_c:
      description: 修改 replaceCurrentData 新增参数控制是否导出 SQLite 归一化 JSON，例如 replaceCurrentData(data, { normalizeJsonView: true })，测试使用默认行为或显式行为。
      approach_evaluation: 可维护性 3/5，因为给接口加入目前没有调用方真实需要的分支，会增加抽象复杂度；健壮性 3/5，因为多模式语义增加调用错误风险；可扩展性 4/5，因为未来确实可能支持不同视图，但当前需求没有证据需要这条分支。
      edge_cases: 调用方忘记传参数时可能得到非预期类型；provider 接口所有实现与 mocks 都要同步扩展；native provider 没有 SQL 归一化语义，会出现接口含义不均衡。
      affected_scope_delta: 需要变更 src/shared/table-storage-provider.ts、src/service/table/sql-table-service.ts、src/service/table/native-table-service-adapter.ts、src/service/table/update-orchestrator.ts 相关 mocks 和测试。
recommendation: 推荐 option_b。三维评估综合最优：可维护性 5/5、健壮性 5/5、可扩展性 5/5。测试失败暴露的是断言语义错误，不是实现应当改变。生产目标是让 SQL provider 与 batch prompt base 使用同一份“当前批次基底”；把 JSON prompt 视图强制改成 SQLite 导出视图反而会引入历史数据类型污染。
execution_plan_update: 原 execution_plan 中“修复数据来源不一致问题并补回归测试”继续执行，但新增一步：修正 tests/service/table/sql-table-service.test.ts 的 replaceCurrentData 用例，使其分别断言 SQLite 查询结果类型归一化与 currentJsonTableData_ACU 保持传入批次快照。随后重新运行目标测试、typecheck、build。
deviation_audit:
  original_plan_excerpt: 修复数据来源不一致问题并补回归测试；运行目标测试、类型检查与正式构建；验收并交付。
  current_proposal: 不改生产实现，修正新增测试中错误的 JSON 视图类型预期，然后继续执行目标测试、类型检查与构建。
  diff_summary: 新增了对测试失败原因的处理步骤；未删减原修复范围；未跳过验证；未用 shell 修改源代码。
  deviation_motive_check:
    - 措辞替换规则逐类检查：未命中需要自我剖析的降级措辞。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。原方案目标是统一 SQL provider 与批次基底；当前方案保持该目标，并修正测试对 JSON 类型归一化的错误假设。
    - 偏离是否导致 affected_scope 缩小？→ NO。生产 affected_scope 已完成，当前只修正新增测试断言，不砍掉任何必要文件。
  self_dissection: 未触发。当前不是为了回避实现而改测试，而是测试断言与已定义的 replaceCurrentData 语义冲突；SQLite 查询断言仍保留对核心行为的验证。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_b 在三维评分上均为 5/5，且避免把 SQLite 类型系统副作用扩散到 prompt JSON 视图。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。新增边界“旧聊天字符串数字不应被 prompt 视图无声改写”会通过修正后的断言覆盖。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。选择测试修正的依据是职责语义和失败证据：SQLite 查询已证明引擎重建成功，失败仅发生在 JSON 视图类型预期。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。生产文件与测试文件仍在覆盖范围内，后续会继续跑目标测试、类型检查和构建。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。pipeline.test.ts 的 never 编辑器诊断已通过实际 vitest 运行确认不阻断当前测试；后续 typecheck 若失败再按真实错误处理。
  - options 是否包含至少三个方案？ → YES。已列出 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。后续修改继续使用 edit_file。
  - deviation_audit 是否触发了 self_dissection？ → NO。未触发偷懒判定。
</decision_point>

---

<output_quality_review>
task_summary: 修复 SQL 模式自动/手动填表时“当前表格数据”来源不一致的问题，使批处理提示词基底、SQLite provider 内存库、刷新/世界书视图在 SQL 模式下走统一 provider 语义，避免旧聊天迁移后 checkpoint 已存在但填表仍看到空表或 SQL 写入基底错位。
deliverables:
  - src/shared/table-storage-provider.ts：扩展 ITableStorageProvider，新增 replaceCurrentData(data) 契约，用于把当前批次 JSON 基底写入活动存储 provider。
  - src/service/table/native-table-service-adapter.ts：实现 replaceCurrentData，原生模式保持写入 currentJsonTableData_ACU 的既有语义。
  - src/service/table/sql-table-service.ts：实现 replaceCurrentData，重建 SQLite engine/SyncBridge，加载批次 JSON 快照，同步 currentJsonTableData_ACU，并刷新 committed snapshot，防止 SQL applyEdits 基于旧 provider 状态执行。
  - src/service/table/update-orchestrator.ts：在 processUpdatesBatch_ACU 每批 loadBatchBaseData_ACU 后，SQL 模式调用 getStorageProvider().replaceCurrentData(mergedBatchData)，让 prompt 数据与 SQL 执行数据源一致；原生模式保留 _set_currentJsonTableData_ACU。
  - src/service/worldbook/pipeline.ts：SQL 模式刷新优先 reloadStorageProvider/getStorageProvider().getCurrentData()，避免 refreshMergedDataAndNotify_ACU 绕过 SQL provider 直接 merge 覆盖全局 JSON。
  - tests/service/table/update-orchestrator.test.ts：新增 SQL 批处理回归，验证每批提示词前 provider 必须被替换为历史批基底。
  - tests/service/table/sql-table-service.test.ts：新增 replaceCurrentData 回归，验证 SQLite 旧内存库清除、新批次快照加载、JSON prompt 视图保持传入快照类型。
  - tests/service/worldbook/pipeline.test.ts：补齐 SQL mode/provider mock，覆盖 pipeline 新依赖。
  - dist/index.bundle.js：npm run build 生成的正式 JS bundle。

# 量化指标总览
metrics:
  total_files_modified: 9 — 修改/生成的文件包括 5 个源码/接口文件、3 个测试文件、1 个构建产物。
  execution_plan_coverage: 5/5 = 100% — 已完成侦察来源、分析绕过点、修复 provider 数据源一致性、目标/全量验证、验收归档流程。
  edge_cases_handled: 5/5 = 100% — 覆盖旧聊天 legacy/checkpoint 数据作为批基底、SQL provider 与 prompt JSON 不一致、手动/自动共用批处理链路、世界书刷新绕过 provider、旧聊天字符串数字不被 SQLite 类型系统污染 prompt 视图。
  confidence_assessment: HIGH — 目标测试、typecheck、正式 build、全量测试均通过；架构护栏 0 违规。已知测试 stderr 为既有用例验证降级/异常路径的日志，不构成本次失败。

# 产物实质性检查
substance_check:
  - 产物中是否存在"形式完整但实质空洞"的内容？
    → NO。replaceCurrentData 接口直接改变 SQL/native provider 的运行时数据同步方式；update-orchestrator 的 SQL 分支直接改变填表前 provider 数据源；pipeline 的 SQL 分支直接改变刷新来源；新增测试会在对应逻辑被移除或绕回旧路径时失败。
  - 产物是否能被其目标对象（被测代码/被重构模块/被修复的bug）的变化所"击穿"？
    → YES。若移除 processUpdatesBatch_ACU 中的 replaceCurrentData 调用，update-orchestrator 新回归会失败；若 SqlTableService.replaceCurrentData 不重建 SQLite，sql-table-service 新回归会查到旧数据或查不到新数据；若 pipeline 缺少 provider mock/SQL 分支处理，pipeline 测试会在导入或运行阶段暴露错误。
  - 实质性比率: 8/8 = 100% — 除构建产物外，所有源码/测试改动都有直接行为价值；构建产物是用户要求可试用 JS 的必要输出。

# 覆盖完整性检查
completeness_check:
  - 是否存在被跳过的模块/函数/路径？
    → NO。自动与手动填表共用 processUpdatesBatch_ACU，核心路径已覆盖；SQL 与 native provider 都实现接口；刷新/世界书绕过点已处理；测试覆盖核心 provider 替换与 SQL 服务重建。
  - 产物覆盖的范围是否与 execution_plan 中 affected_scope 完全一致？
    → YES。affected_scope 列出的 src/shared/table-storage-provider.ts、src/service/table/native-table-service-adapter.ts、src/service/table/sql-table-service.ts、src/service/table/update-orchestrator.ts、src/service/worldbook/pipeline.ts、tests/service/table/update-orchestrator.test.ts、tests/service/table/sql-table-service.test.ts、tests/service/worldbook/pipeline.test.ts 均已处理。
  - 核心业务逻辑是否都有直接验证（不依赖间接覆盖）？
    → YES。SQL 批处理 provider 替换由 update-orchestrator 测试直接验证；SQLite replaceCurrentData 重建由 sql-table-service 测试直接验证；pipeline 新依赖由 pipeline 测试导入和执行覆盖；全量测试覆盖没有引入跨模块回归。
  - affected_scope 覆盖率: 8/8 = 100%

# 价值密度检查
value_density_check:
  - 产物中高价值内容（验证核心逻辑/处理复杂场景）与低价值内容（验证trivial行为）的比例是多少？
    → 高价值:低价值 = 8:0，高价值占比 100%。新增测试不是检查 getter/setter，而是验证 SQL/native 数据源一致性、批次历史基底、SQLite 重建和类型边界。
  - 是否存在"用数量掩盖质量"的模式——大量 trivial 产物掩盖了核心逻辑缺少验证的事实？
    → NO。新增测试数量不多，但分别打在 bug 的两个核心断点：批处理 provider 替换和 SQL provider 重建。

# 需求对齐检查
alignment_check:
  - 产物满足的是用户的字面需求还是本质需求？
    → 满足本质需求。用户问“自动/手动填表在 SQL 及原生模式下到底以什么来源当作当前表格数据”，并要求解决仍为空。修复不是继续在 checkpoint 迁移上打补丁，而是处理真实根因：SQL 模式填表 prompt 读 currentJsonTableData_ACU，SQL 写入读 SqlTableService，二者未在批次基底上同步。
  - "如果这是别人交给我的，我会接受吗？"
    → YES。因为它有明确根因、最小但完整的抽象扩展、直接回归测试、全量测试、typecheck、正式构建与架构护栏验证。唯一不漂亮的是 pipeline SQL 刷新会多一次 provider/getCurrentData 路径调用，存在轻微冗余，但不破坏正确性，且比继续绕过 provider 更可靠。
</output_quality_review>
