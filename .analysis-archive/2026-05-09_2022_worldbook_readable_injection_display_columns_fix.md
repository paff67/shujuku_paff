<analysis>
context: 用户反馈“表格编辑器里数据正常且有数据，但注入世界书条目时格式出现问题，很多表只剩 # 表名，数据没了”。侦察确认世界书全局可读条目的生成链路在 [`updateReadableLorebookEntry_ACU`](src/service/worldbook/pipeline.ts:18)：SQLite 模式下通过 [`getStorageProvider().getCurrentData()`](src/service/worldbook/pipeline.ts:49) 获取当前表格数据，随后调用 [`formatJsonToReadable_ACU`](src/service/runtime/helpers-data-merge.ts:231) 生成 Markdown。该格式化函数目前对所有普通表执行 [`table.content[0].slice(1)`](src/service/runtime/helpers-data-merge.ts:268) 和 [`row.slice(1)`](src/service/runtime/helpers-data-merge.ts:277)，隐含假设第一列永远是 row_id。这个假设在项目主体 schema 中通常成立：[`schema-mapper.ts`](src/data/sqlite/schema-mapper.ts:75) 的 fallback DDL 把 row_id 作为第一列，[`resultToContent`](src/data/sqlite/schema-mapper.ts:179) 会把 SQL 查询结果列还原为 content 表头，并把 row_id 映射为 row_id；表格编辑器和 CRUD 也大量依赖第一列 row_id。但侦察同时发现 [`validateDDLTextAgainstHeaders_ACU`](src/shared/ddl-utils.ts:176) 在 DDL 校验中允许传入 headers 不含 row_id 并进行兼容比较，且外部导入、旧数据或某些格式化数据源可能已经移除了 row_id。如果传给世界书格式化器的 content 表头不含 row_id，当前盲目 slice(1) 会删除第一列真实业务字段；如果某张表只有一列真实业务字段，输出就会退化成只剩标题或空 Markdown 表。这与用户贴出的“# 主角信息”“# 主角技能表”等只剩标题高度吻合。另一个相关风险在 [`updateReadableLorebookEntry_ACU`](src/service/worldbook/pipeline.ts:73) 内部的 [`hasAnyNonEmptyCell_ACU`](src/service/worldbook/pipeline.ts:73)：它从列索引 1 开始扫描非空单元格，同样假设第一列必定是 row_id。若 content 不含 row_id，它会忽略第一列真实数据，可能误判数据库为空或跳过自定义导出。SQLite provider 本身的 [`SqlTableService.getCurrentData`](src/service/table/sql-table-service.ts:183) 会通过 [`SyncBridge.exportToTableData`](src/data/sqlite/sync-bridge.ts:73) 导出数据，导出时 [`resultToContent`](src/data/sqlite/schema-mapper.ts:179) 正常会包含 SQL 结果列；所以当前更明确的缺陷不是 SQLite 持久化丢数据，而是世界书注入链路对“显示列起点”的判断过硬。现有测试 [`helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts:587) 只覆盖“row_id 存在时应隐藏 row_id”，没有覆盖“row_id 不存在时不得删除第一列真实业务字段”，测试缺口明显。
needs: 本次修复的本质目标不是把世界书条目“凑到有内容”，而是让世界书注入链路以与实际 content 结构一致的方式选择显示列：当首列确认为 row_id 时隐藏 row_id；当首列不是 row_id 时必须保留第一列真实字段；当表没有可显示表头或没有可显示数据时不能输出误导性的空标题块；非空数据判断也必须使用同一套显示列起点规则，避免格式化器认为有数据而 pipeline 判空器认为没数据，或反过来。必须补充直接击穿该缺陷的单元测试，确保以后有人再写盲目 slice(1) 时测试失败。
key_challenges: 第一，项目中大量模块依赖 row_id 第一列，不能全局改变 content 结构，也不能把 row_id 显示到世界书可读条目里，否则会污染用户提示词和既有测试。第二，世界书格式化器和 pipeline 判空器现在各自写了列偏移逻辑，如果只修一个，会产生注入内容和数据库空判定不一致。第三，特殊表“重要人物表 / 总结表 / 总体大纲”会被 [`formatJsonToReadable_ACU`](src/service/runtime/helpers-data-merge.ts:247) 提取到独立字段，不能因为普通表修复破坏这些专用注入路径。第四，部分表可能是 header-only 模板壳，当前函数会输出 `# 表名` 后没有任何表格，用户看到的正是这种劣质结果；修复必须避免制造空标题噪音，但不能误删确实有一列表头和一列数据的表。
confidence: HIGH
  - 侦察已定位完整主链路：[`refreshMergedDataAndNotify_ACU`](src/service/worldbook/pipeline.ts:555) → [`updateReadableLorebookEntry_ACU`](src/service/worldbook/pipeline.ts:18) → [`formatJsonToReadable_ACU`](src/service/runtime/helpers-data-merge.ts:231)。
  - 已确认直接风险代码：格式化器和判空器都硬编码从列 1 开始。
  - 已确认现有测试只验证 row_id 存在场景，缺少 row_id 缺失/已隐藏场景。
  - 未完全证明用户运行时传入的具体表格 content 是否缺 row_id，但修复方向是消除硬假设，且不破坏 row_id 存在时的既有行为，因此工程风险可控。
approach: 三维评估综合最优的方案是在 [`helpers-data-merge.ts`](src/service/runtime/helpers-data-merge.ts:231) 中增加可复用的显示列解析与可显示单元判断函数，让 [`formatJsonToReadable_ACU`](src/service/runtime/helpers-data-merge.ts:231) 基于表头判断是否隐藏 row_id；同时在 [`pipeline.ts`](src/service/worldbook/pipeline.ts:73) 使用同一语义修正非空数据判断。测试覆盖 row_id 存在、row_id 不存在且第一列有真实数据、单列真实表不得被格式化为空、header-only 空壳不得输出孤立标题。
  三维评分（每个维度 1-5 分，5 为最优）：
  - 可维护性: 5/5 — 把“可读输出应从哪一列开始”的判断集中为命名函数，比散落 `.slice(1)` 更容易审查；调用点只表达业务意图，不继续复制硬编码偏移。
  - 健壮性: 5/5 — 覆盖 row_id 存在、row_id 缺失、空表头、header-only、单列真实数据、null/undefined 单元格等边界；不会因为某一数据源预先隐藏 row_id 就误删第一列。
  - 可扩展性: 4/5 — 后续如果需要支持 `_row_id` 或“行号”等别名，只需要扩展显示列解析函数；本次不扩大为多别名隐藏，是为了避免把真实业务列误判为行标识。
edge_cases:
  - 当 content[0][0] 精确为字符串 row_id（忽略大小写和首尾空白）时，世界书 Markdown 应隐藏 row_id 列，保持现有提示词输出不出现内部行号。
  - 当 content[0][0] 不是 row_id，例如 `['人物名称', '性别']` 时，世界书 Markdown 必须从第 0 列开始输出，不能删除“人物名称”。
  - 当表只有一个真实业务列且没有 row_id，例如 `['技能名称']` + `['格斗']` 时，输出必须包含 `| 技能名称 |` 和 `| 格斗 |`，不能只剩 `# 主角技能表`。
  - 当表只有 row_id 表头或没有可显示表头时，不应输出孤立的 `# 表名` 空块，因为这会让用户误以为注入表数据被清空。
  - 当数据行短于表头时，应按现有 join 行为输出已有单元格，不因缺列抛错。
  - 当单元格为 null、undefined、空字符串时，非空判断不能把它们算作有效业务数据；数字 0 和 boolean false 属于有效业务值，不能被误判为空。
  - 当表设置 `exportConfig.enabled=true` 或 `exportConfig.injectIntoWorldbook=false` 时，仍按既有逻辑跳过全局可读条目，不能因为本次修复改变导出配置语义。
  - 特殊表“重要人物表 / 总结表 / 总体大纲”仍应从全局 readableText 中分离出来，返回给专用条目更新函数。
affected_scope: 
  - [`src/service/runtime/helpers-data-merge.ts`](src/service/runtime/helpers-data-merge.ts)
  - [`src/service/worldbook/pipeline.ts`](src/service/worldbook/pipeline.ts)
  - [`tests/service/runtime/helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts)
  - [`tests/service/worldbook/pipeline.test.ts`](tests/service/worldbook/pipeline.test.ts)
execution_plan:
  - step_1: 修改 [`src/service/runtime/helpers-data-merge.ts`](src/service/runtime/helpers-data-merge.ts)，在 [`formatJsonToReadable_ACU`](src/service/runtime/helpers-data-merge.ts:231) 附近增加用于判断 row_id 显示起点的导出函数，例如 `getReadableContentStartColumn_ACU(headerRow)` 和 `hasReadableRowCellData_ACU(row, startColumn)`；仅当首列表头规范化后等于 row_id 时返回 1，否则返回 0。
  - step_2: 修改 [`formatJsonToReadable_ACU`](src/service/runtime/helpers-data-merge.ts:231)，把表头和行数据的 `.slice(1)` 替换为基于 `getReadableContentStartColumn_ACU` 的切片；在追加 `# 表名` 前先计算可显示 headers 和 rows，并且只有存在可显示表头时才输出该表，避免 header-only/无显示列表生成孤立标题块。
  - step_3: 修改 [`src/service/worldbook/pipeline.ts`](src/service/worldbook/pipeline.ts)，引入共享的显示列判断函数，把 [`hasAnyNonEmptyCell_ACU`](src/service/worldbook/pipeline.ts:73) 中从 `c = 1` 开始扫描的硬编码替换为基于当前表头解析出的 startColumn，保证注入判空和 Markdown 格式化语义一致。
  - step_4: 修改 [`tests/service/runtime/helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts)，补充回归测试：row_id 存在时仍隐藏 row_id；row_id 不存在时保留第一列；单列真实业务表不再只剩标题；只有 row_id 或无可显示表头的空壳表不输出孤立标题。
  - step_5: 修改 [`tests/service/worldbook/pipeline.test.ts`](tests/service/worldbook/pipeline.test.ts)，补充或调整 pipeline 判空测试，使首列为真实业务列且含有效数据的表不会被误判为空，确保会继续更新 readable entry 和 custom exports。
  - step_6: 运行目标测试、类型检查、构建和全量测试：先运行 `npx vitest run tests/service/runtime/helpers-data-merge.test.ts tests/service/worldbook/pipeline.test.ts`，再运行 `npm run typecheck`、`npm run build`、`npm test`。
degradation_check:
  - 方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。三维评分为可维护性 5/5、健壮性 5/5、可扩展性 4/5；方案修复共享语义而不是只在一个调用点打补丁。
  - 是否遗漏了已知边界条件？ → NO。已覆盖 row_id 存在、row_id 缺失、单列真实表、header-only 空壳、空单元格、特殊表和 exportConfig 跳过逻辑。
  - 是否因改动量大而想缩减方案？ → NO。虽然涉及 formatter、pipeline 和两组测试，但这是同一缺陷的完整影响范围，不能只改 formatter。
  - 是否打算跳过某些文件？ → NO。affected_scope 中列出的 4 个文件都在 execution_plan 中覆盖。
  - execution_plan是否覆盖affected_scope所有文件？ → YES。step_1/step_2 覆盖 helpers-data-merge，step_3 覆盖 pipeline，step_4 覆盖 helpers-data-merge.test，step_5 覆盖 pipeline.test。
  - context是否充分？是否有未读但可能相关的文件？ → NO。主链路、格式化器、SQLite 导出和现有测试均已读取；其他 `.slice(1)` 调用分布在总结、剧情、模板助手等模块，但用户症状定位为世界书全局注入，且本次共享函数可为后续扩展提供基础，不需要扩大到无关模块造成风险。
  - 是否有发现了但被我判断为"无关紧要"而跳过的问题？ → NO。发现 [`injection-engine-entries.ts`](src/service/worldbook/injection-engine-entries.ts) 和 [`injection-engine-custom.ts`](src/service/worldbook/injection-engine-custom.ts) 也存在 `.slice(1)`，但用户贴出的内容来自全局 readable entry；专用条目路径若后续出现相同症状应另行按完整链路处理，当前不盲改，避免破坏特殊表索引逻辑。
  - execution_plan中是否有步骤计划使用 shell 命令（sed/awk/perl）修改源代码？ → NO。源代码修改使用标准编辑工具；shell 只用于测试、类型检查、构建。
</analysis>
---
<decision_point>
issue: 标准编辑工具保存后报告 [`tests/service/runtime/helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts:1066) 存在既有 TypeScript 类型提示：`checkpoint?.data.sheet_0.content` 被推断为 `Mate_ACU | Sheet_ACU`，其中 `Mate_ACU` 没有 `content`。这个提示并非当前修改的 [`formatJsonToReadable_ACU`](src/service/runtime/helpers-data-merge.ts:231) 直接引起，但它会影响后续 typecheck 判断，如果不记录就继续执行，后面看到类型检查失败时容易把原因混在一起。
impact: YES。它不改变当前世界书注入修复方案的可行性，但影响验收阶段的错误归因。当前 execution_plan 仍应继续修改 formatter、pipeline 和对应测试；若 typecheck 最终仍报该既有测试类型错误，必须在同一任务内处理或明确证明它与本次改动无关且在修改前已存在。由于工具只报告“New problems detected after saving”，但该行与当前编辑文件无直接依赖，当前不应偏离主线去修不相关测试，避免扩大改动范围。
context_update: 
  - confidence 仍为 HIGH，因为核心缺陷链路未变。
  - affected_scope 暂不新增 [`tests/service/runtime/helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts) 之外的文件；该文件本来已在 affected_scope 内，后续如果 typecheck 实证失败，可在同一测试文件内修正类型断言。
  - execution_plan 暂不变；继续按原计划完成主修复和测试，然后用 typecheck 验证是否需要处理该提示。
options:
  - option_a:
      description: 立即转去修复 [`tests/service/runtime/helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts:1066) 的既有类型提示，再回到世界书注入修复。
      approach_evaluation: 可维护性 3/5，因为会打断当前高风险链路并扩大上下文；健壮性 4/5，因为可提前清理 typecheck 风险；可扩展性 3/5，因为该类型问题与当前世界书注入语义无直接关系，容易把两个问题耦合进同一修改段。
      edge_cases: 如果该提示是编辑器缓存或既有宽松类型导致，提前修复可能制造无关 diff；如果后续没有 typecheck 失败，这一步就是不必要改动。
      affected_scope_delta: 可能新增对 [`tests/service/runtime/helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts:1066) 附近非本次测试段落的修改。
  - option_b:
      description: 记录该提示但继续完成原 execution_plan；在目标测试和 typecheck 阶段用实际命令输出判断是否需要修复。
      approach_evaluation: 可维护性 5/5，因为保持当前任务边界清晰，只在验证证据出现时处理额外类型问题；健壮性 5/5，因为不会忽略提示，且后续 typecheck 会给出确定结果；可扩展性 4/5，因为把错误归因和主修复隔离，后续维护者能看懂为什么没有立刻改无关行。
      edge_cases: 如果 typecheck 失败，必须重新进入 decision_point 或按既定 scope 在同文件修复，不能把失败当噪声；如果目标测试失败，则优先处理与本次改动直接相关的失败。
      affected_scope_delta: 无新增文件，保持原 affected_scope。
  - option_c:
      description: 忽略该提示并继续，不在决策链中记录。
      approach_evaluation: 可维护性 1/5，因为后续错误归因会混乱；健壮性 1/5，因为违反遇到非预期结果需分析的流程；可扩展性 1/5，因为维护者无法追溯为什么保存后出现的类型提示未处理。
      edge_cases: 后续 typecheck 失败时需要重新侦察，浪费上下文且容易误判。
      affected_scope_delta: 无新增文件，但质量风险增加。
recommendation: 选择 option_b。三维评估显示 option_b 在可维护性 5/5、健壮性 5/5、可扩展性 4/5 上综合最优；它既不忽略工具提示，也不为了一个尚未被 typecheck 证实的既有类型提示偏离当前高风险世界书注入链路。
execution_plan_update: 原 execution_plan 保持不变；在 step_6 的验证阶段增加错误归因要求：如果 `npm run typecheck` 报 [`tests/service/runtime/helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts:1066) 或相关类型错误，则先确认是否由本次新增测试/导出类型触发，再在同一文件内做最小类型修正并重新运行 typecheck。
deviation_audit:
  original_plan_excerpt: 
    - step_6: 运行目标测试、类型检查、构建和全量测试：先运行 `npx vitest run tests/service/runtime/helpers-data-merge.test.ts tests/service/worldbook/pipeline.test.ts`，再运行 `npm run typecheck`、`npm run build`、`npm test`。
  current_proposal: 
    - step_6: 运行目标测试、类型检查、构建和全量测试：先运行 `npx vitest run tests/service/runtime/helpers-data-merge.test.ts tests/service/worldbook/pipeline.test.ts`，再运行 `npm run typecheck`、`npm run build`、`npm test`；如果 `npm run typecheck` 报 [`tests/service/runtime/helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts:1066) 或相关类型错误，则先确认是否由本次新增测试/导出类型触发，再在同一文件内做最小类型修正并重新运行 typecheck。
  diff_summary: 
    - 新增了对已观察到类型提示的错误归因要求。
    - 未删减任何原验证命令。
    - 未缩小 affected_scope。
  deviation_motive_check:
    - **措辞替换规则逐类检查**：未命中任何一类降级措辞；recommendation 基于三维评分，没有使用“务实”“折中”“更实际”等伪理性化措辞。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。原方案验证步骤仍完整保留，新增错误归因要求提升健壮性。
    - 偏离是否导致 affected_scope 缩小？→ NO。没有砍掉任何文件或测试。
  self_dissection: 不触发。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_b 为 5/5、5/5、4/5，优于 option_a 的 3/5、4/5、3/5 和 option_c 的 1/5、1/5、1/5。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。新增了 typecheck 阶段的错误归因要求。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。选择 option_b 的依据是错误证据尚未由 typecheck 证实，贸然修无关段会降低可维护性；后续验证若失败必须处理。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。原 affected_scope 不变，step_6 增加验证分支。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。该提示已记录并纳入 step_6 验证归因。
  - options 是否包含至少三个方案？ → YES。包含 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。后续源码修改仍使用标准编辑工具，shell 仅用于测试和构建。
  - deviation_audit 是否触发了 self_dissection？ → NO。没有缩小范围或降低评分。
</decision_point>
---
<decision_point>
issue: 保存新增 formatter 测试后，工具报告多个 TypeScript 提示：[`tsconfig.json`](tsconfig.json:19) 的 `baseUrl` 在 TypeScript 7.0 将弃用，以及 [`tests/service/runtime/helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts) 中若干既有测试对象缺少 `Sheet_ACU` 必填字段、`updateConfig.uiSentinel`、以及 `checkpoint?.data.sheet_0.content` 联合类型访问问题。这些提示集中在旧测试段落，并非新增的 formatter 用例本身；新增用例使用的是 `formatJsonToReadable_ACU(jsonData: Record<string, any>)`，不会要求 `Sheet_ACU` 完整结构。
impact: YES。提示可能在后续 `npm run typecheck` 中变成失败，也可能是编辑器对全项目既有类型债务的实时提示。它不改变当前世界书注入修复的技术方案，但要求后续验证阶段明确区分“新增修复引入的问题”和“既有测试类型债务”。如果现在把所有既有类型债务纳入本次修复，范围会从世界书注入链路扩散到 TypeScript 配置和大量旧测试结构，风险不成比例。
context_update:
  - affected_scope 暂不新增 [`tsconfig.json`](tsconfig.json)，因为 `baseUrl` 弃用提示与用户的世界书注入空表问题无关，且修改编译配置属于全项目行为变更。
  - [`tests/service/runtime/helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts) 已在 affected_scope 内，但当前新增用例不触发 `Sheet_ACU` 完整结构约束；旧段落若在 typecheck 中失败，需要在验证阶段单独处理。
  - execution_plan 继续执行 step_5 pipeline 测试和 step_6 验证；后续如果 typecheck 实证失败，再按最小必要范围处理。
options:
  - option_a:
      description: 立即修复所有工具报告的 TypeScript 提示，包括 [`tsconfig.json`](tsconfig.json:19) 的弃用配置和 [`tests/service/runtime/helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts) 的旧测试类型结构。
      approach_evaluation: 可维护性 2/5，因为把编译配置迁移和旧测试类型债务混入世界书注入修复，提交意图会变脏；健壮性 3/5，因为可能消除未来 typecheck 风险，但也可能引入全项目配置副作用；可扩展性 2/5，因为后续追溯困难，无法清楚判断哪部分是用户问题修复。
      edge_cases: TypeScript 7.0 弃用并不等于当前构建失败；贸然添加 `ignoreDeprecations` 或改 baseUrl 可能改变模块解析。旧测试对象补全结构也可能导致无关测试语义变化。
      affected_scope_delta: 新增 [`tsconfig.json`](tsconfig.json) 和 [`tests/service/runtime/helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts) 多个旧段落。
  - option_b:
      description: 只确认新增 formatter 用例是否需要类型修正；对旧段落和 [`tsconfig.json`](tsconfig.json) 提示先记录，继续完成 pipeline 测试与验证命令，根据实际命令失败再处理。
      approach_evaluation: 可维护性 5/5，因为保持修复范围围绕世界书注入链路；健壮性 5/5，因为没有忽略提示，后续通过 typecheck 实证处理；可扩展性 4/5，因为错误归因清晰，若构建环境升级触发 `baseUrl` 问题，可单独任务处理配置迁移。
      edge_cases: 如果 `npm run typecheck` 失败，必须处理失败项，不能以“旧问题”为借口交付；如果仅编辑器提示但命令通过，不应制造无关 diff。
      affected_scope_delta: 无新增文件，保持原计划。
  - option_c:
      description: 因为出现多个类型提示，停止新增测试，只保留源码修复。
      approach_evaluation: 可维护性 1/5，因为缺少回归测试，未来很容易恢复盲目 `.slice(1)`；健壮性 1/5，因为没有验证用户核心症状；可扩展性 1/5，因为无测试保护的修复难以维护。
      edge_cases: 当前修复看似可用，但无法防止同类格式化退化再次出现。
      affected_scope_delta: 缩小测试范围，删除原计划 step_4/step_5 的实质保障。
recommendation: 选择 option_b。三维评估显示 option_b 在可维护性 5/5、健壮性 5/5、可扩展性 4/5 上综合最优；它保留完整测试与验证，又避免把 TypeScript 配置迁移和旧测试类型债务混入当前用户问题。
execution_plan_update: 原 execution_plan 保持不变；step_6 已包含 typecheck。补充要求：如果目标测试或 typecheck 指向本次新增 formatter 用例或本次新增导出函数，则立即修；如果指向旧段落或 [`tsconfig.json`](tsconfig.json:19)，先判断是否阻塞本次验证命令，阻塞则做最小修正并记录，未阻塞则不扩大改动范围。
deviation_audit:
  original_plan_excerpt:
    - step_4: 修改 [`tests/service/runtime/helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts)，补充回归测试：row_id 存在时仍隐藏 row_id；row_id 不存在时保留第一列；单列真实业务表不再只剩标题；只有 row_id 或无可显示表头的空壳表不输出孤立标题。
    - step_5: 修改 [`tests/service/worldbook/pipeline.test.ts`](tests/service/worldbook/pipeline.test.ts)，补充或调整 pipeline 判空测试，使首列为真实业务列且含有效数据的表不会被误判为空，确保会继续更新 readable entry 和 custom exports。
    - step_6: 运行目标测试、类型检查、构建和全量测试：先运行 `npx vitest run tests/service/runtime/helpers-data-merge.test.ts tests/service/worldbook/pipeline.test.ts`，再运行 `npm run typecheck`、`npm run build`、`npm test`。
  current_proposal:
    - step_4、step_5、step_6 继续执行；额外记录 TypeScript 提示归因规则：本次新增用例/导出导致的错误立即修，旧段落或配置弃用提示只有在实际验证命令阻塞时才做最小修正。
  diff_summary:
    - 未删除任何测试步骤。
    - 未跳过 pipeline 测试。
    - 未新增 `tsconfig.json` 配置迁移步骤。
    - 增加了验证阶段的错误归因约束。
  deviation_motive_check:
    - **措辞替换规则逐类检查**：未命中降级措辞；没有使用“先这样”“应该够用”“更实际”等表达。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。原测试和验证仍完整执行，新增归因约束提升可维护性。
    - 偏离是否导致 affected_scope 缩小？→ NO。没有缩小；只是暂不扩大到 [`tsconfig.json`](tsconfig.json)。
  self_dissection: 不触发。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_b 为 5/5、5/5、4/5，优于 option_a 和 option_c。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。新增 TypeScript 提示已纳入验证归因；若命令失败必须处理。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。没有删减测试和验证；只是避免无证据扩大到全项目配置迁移。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。原 affected_scope 不变，step_4/step_5/step_6 继续执行。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。提示已记录；是否处理取决于验证命令是否阻塞。
  - options 是否包含至少三个方案？ → YES。包含 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。源码继续用标准编辑工具；命令只用于测试和构建。
  - deviation_audit 是否触发了 self_dissection？ → NO。没有降低测试覆盖或缩小计划。
</decision_point>
---
<decision_point>
issue: 追加 `<output_quality_review>` 到 [`.analysis-cache.md`](.analysis-cache.md) 时，`edit_file` 使用的 `old_string` 为 `</decision_point>\n`，文件中存在两个完全相同的 `</decision_point>`，导致 occurrence count mismatch。问题不在验收内容，而在定位字符串不够唯一。
impact: YES。影响归档链完整性；如果不修正，就无法把验收报告逐字追加到缓存，也无法按流程归档。它不影响已完成的代码修复和测试结果。
context_update:
  - execution_plan 的代码与测试步骤已完成，当前只影响验收持久化步骤。
  - `.analysis-cache.md` 目前包含 analysis 和两个 decision_point，缺少 output_quality_review。
  - 必须使用更精确的 old_string 定位最后一个 decision_point 结尾，不能用替换所有 occurrence，也不能用 shell 拼接绕过编辑工具。
options:
  - option_a:
      description: 将 `expected_replacements` 改为 2，把验收报告追加到两个 `</decision_point>` 后面。
      approach_evaluation: 可维护性 1/5，因为会污染决策链，在第一个 decision_point 后错误插入验收；健壮性 1/5，因为归档结构损坏；可扩展性 1/5，因为未来读取归档会误解事件顺序。
      edge_cases: 两处插入会产生两个 output_quality_review 或破坏 decision_point 分隔结构。
      affected_scope_delta: 仍只涉及 [`.analysis-cache.md`](.analysis-cache.md)，但内容结构错误。
  - option_b:
      description: 使用最后一个 decision_point 的尾部唯一上下文作为 old_string，只在第二个 `</decision_point>` 后追加验收报告。
      approach_evaluation: 可维护性 5/5，因为保留 analysis → decision_point → decision_point → output_quality_review 的正确顺序；健壮性 5/5，因为精确匹配避免误插入；可扩展性 5/5，因为后续归档结构清晰。
      edge_cases: old_string 必须包含最后一个 decision_point 的末尾若干行，确保只匹配一次；若上下文仍不唯一，应先读取尾部再构造更长匹配。
      affected_scope_delta: 无新增文件，仅修正 [`.analysis-cache.md`](.analysis-cache.md) 追加方式。
  - option_c:
      description: 使用命令行追加验收报告到 [`.analysis-cache.md`](.analysis-cache.md) 末尾。
      approach_evaluation: 可维护性 1/5，因为违反“源/缓存编辑必须用标准编辑工具”的约束；健壮性 2/5，因为可能编码/换行出错；可扩展性 1/5，因为不可审查且不可追踪。
      edge_cases: Windows shell 对中文、反引号、管道符的转义容易破坏 Markdown 内容。
      affected_scope_delta: 无新增文件，但工具行为违规。
recommendation: 选择 option_b。三维评估显示 option_b 在可维护性 5/5、健壮性 5/5、可扩展性 5/5 上综合最优；它修正工具参数而不是绕过工具链。
execution_plan_update: 验收持久化步骤改为：用最后一个 decision_point 的唯一尾部上下文作为 `old_string`，将 `<output_quality_review>` 追加到 [`.analysis-cache.md`](.analysis-cache.md) 末尾；随后归档。
deviation_audit:
  original_plan_excerpt:
    - 验收报告输出后，将其追加写入 `.analysis-cache.md`，然后将该文件移动到 `.analysis-archive/` 文件夹并改名为 `{YYYY-MM-DD}_{HHmm}_{任务简述}.md`，永久保留。
  current_proposal:
    - 验收报告输出后，使用唯一尾部上下文将其追加写入 `.analysis-cache.md`，然后归档。
  diff_summary:
    - 仅改变追加时的匹配定位方式。
    - 不改变验收内容。
    - 不跳过归档。
  deviation_motive_check:
    - **措辞替换规则逐类检查**：未命中降级措辞；没有用“简单”“省事”等理由绕过工具。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。修正后更精确，评分不下降。
    - 偏离是否导致 affected_scope 缩小？→ NO。仍完成缓存和归档。
  self_dissection: 不触发。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_b 三维均为 5/5，明显优于污染内容的 option_a 和违规命令追加的 option_c。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。已处理多处相同 `</decision_point>` 的匹配歧义。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。选择依据是结构正确性和工具合规，不是省步骤。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。仍覆盖 [`.analysis-cache.md`](.analysis-cache.md) 和归档动作。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。匹配失败已分析并修正。
  - options 是否包含至少三个方案？ → YES。包含 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。明确拒绝 option_c，继续使用编辑工具。
  - deviation_audit 是否触发了 self_dissection？ → NO。没有降低方案质量。
</decision_point>
---
<output_quality_review>
task_summary: 修复世界书全局可读条目注入时因盲目跳过第一列导致表格内容变空的问题，并让世界书判空逻辑与 Markdown 格式化逻辑使用同一套显示列起点规则。
deliverables:
  - 修改 [`src/service/runtime/helpers-data-merge.ts`](src/service/runtime/helpers-data-merge.ts)：新增 `getReadableContentStartColumn_ACU` 和 `hasReadableRowCellData_ACU`，并重写 `formatJsonToReadable_ACU` 的显示列选择与空壳表过滤逻辑。
  - 修改 [`src/service/runtime/helpers-remaining.ts`](src/service/runtime/helpers-remaining.ts)：重新导出新增的显示列判断函数，供世界书 pipeline 使用。
  - 修改 [`src/service/worldbook/pipeline.ts`](src/service/worldbook/pipeline.ts)：将世界书非空数据判断改为基于 `getReadableContentStartColumn_ACU` 和 `hasReadableRowCellData_ACU`，避免首列真实业务字段被忽略。
  - 修改 [`tests/service/runtime/helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts)：新增 row_id 缺失、单列真实业务表、空壳表、空白单元格、数字 0/boolean false 等 formatter 回归测试。
  - 修改 [`tests/service/worldbook/pipeline.test.ts`](tests/service/worldbook/pipeline.test.ts)：新增 pipeline 判空测试，验证无 row_id 的首列真实数据不会被判空，只有 row_id 的空壳表会被按空处理。

# 量化指标总览
metrics:
  total_files_modified: 5 — 修改 3 个源码文件和 2 个测试文件。
  execution_plan_coverage: 6/6 = 100% — step_1 到 step_6 全部完成，未跳过目标测试、类型检查、构建或全量测试。
  edge_cases_handled: 8/8 = 100% — analysis 中列出的 row_id 存在、row_id 缺失、单列真实表、空壳表、短行/空值、数字与布尔值、exportConfig 跳过、特殊表分离均已覆盖或保持既有逻辑。
  confidence_assessment: HIGH — 目标测试、typecheck、build、全量测试均通过，无已知阻塞项。
    - HIGH: 所有产物经过验证，无已知遗漏。

# 产物实质性检查
substance_check:
  - 产物中是否存在"形式完整但实质空洞"的内容？
    → NO。源码改动改变了实际运行行为：[`formatJsonToReadable_ACU`](src/service/runtime/helpers-data-merge.ts:255) 不再无条件 `.slice(1)`，而是根据 `row_id` 是否真实存在决定显示起点；[`updateReadableLorebookEntry_ACU`](src/service/worldbook/pipeline.ts:73) 的非空判断也改为同源规则。测试不是空壳：如果恢复盲目 `.slice(1)`，新增的“表头不含 row_id 时保留第一列真实业务字段”和“单列真实业务字段不会输出为空表”会失败。
  - 产物是否能被其目标对象（被测代码/被重构模块/被修复的bug）的变化所"击穿"？
    → YES。若 [`getReadableContentStartColumn_ACU`](src/service/runtime/helpers-data-merge.ts:231) 错误地总返回 1，无 row_id 的 formatter 测试会失败；若 [`hasReadableRowCellData_ACU`](src/service/runtime/helpers-data-merge.ts:237) 错误忽略数字 0 或 boolean false，对应测试会失败；若 [`pipeline.ts`](src/service/worldbook/pipeline.ts:81) 不再调用共享起点函数，pipeline mock 断言会失败。
  - 实质性比率: 5/5 = 100% — 5 个修改文件均有运行行为、导出链路或回归保护价值。

# 覆盖完整性检查
completeness_check:
  - 是否存在被跳过的模块/函数/路径？
    → NO。当前用户症状来自全局 readable entry，已覆盖 [`formatJsonToReadable_ACU`](src/service/runtime/helpers-data-merge.ts:255) 和 [`updateReadableLorebookEntry_ACU`](src/service/worldbook/pipeline.ts:18) 两个关键路径。专用条目模块 [`injection-engine-entries.ts`](src/service/worldbook/injection-engine-entries.ts) 与自定义导出模块 [`injection-engine-custom.ts`](src/service/worldbook/injection-engine-custom.ts) 也存在 `.slice(1)`，但不是用户贴出的全局 Markdown 块来源；本次不盲改，避免破坏专用表索引逻辑。
  - 产物覆盖的范围是否与 execution_plan 中 affected_scope 完全一致？
    → YES。analysis affected_scope 的 4 个文件全部覆盖，并额外修改 [`helpers-remaining.ts`](src/service/runtime/helpers-remaining.ts) 以维持导出链路完整；这是必要配套，不是范围漂移。
  - 核心业务逻辑是否都有直接验证（不依赖间接覆盖）？
    → YES。formatter 逻辑由 [`helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts:608) 至 [`helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts:677) 直接验证；pipeline 判空逻辑由 [`pipeline.test.ts`](tests/service/worldbook/pipeline.test.ts:758) 至 [`pipeline.test.ts`](tests/service/worldbook/pipeline.test.ts:796) 直接验证；构建和全量测试验证没有破坏现有集成。
  - affected_scope 覆盖率: 4/4 = 100%，加上必要导出文件为 5 个实际交付文件。

# 价值密度检查
value_density_check:
  - 产物中高价值内容（验证核心逻辑/处理复杂场景）与低价值内容（验证trivial行为）的比例是多少？
    → 高价值:低价值 = 7:1，高价值占比 87.5%。高价值项包括无 row_id 保留首列、单列业务表不为空、空壳表不输出孤立标题、空白单元格过滤、0/false 有效数据、pipeline 非空判定、pipeline 空壳清理。低价值项只有既有 row_id 隐藏行为的保留断言，但它是兼容性基线，不是凑数。
  - 是否存在"用数量掩盖质量"的模式——大量 trivial 产物掩盖了核心逻辑缺少验证的事实？
    → NO。新增测试数量不多，但每个都对应一个会导致世界书空表或误判的实际失败模式。

# 需求对齐检查
alignment_check:
  - 产物满足的是用户的字面需求还是本质需求？
    → 满足本质需求。用户字面上说“注入世界书条目格式出现问题，直接空了，数据也没了”；本质问题是注入格式化链路误判/误切显示列，而不是编辑器或持久化丢数据。本次修复让世界书注入正确保留无 row_id 数据源的首列真实业务字段，并避免空壳表生成误导性空标题。
  - "如果这是别人交给我的，我会接受吗？"
    → YES。理由：改动范围准确、共享逻辑避免 formatter 与 pipeline 分叉、边界测试能击穿核心缺陷，并已通过 `npx vitest run tests/service/runtime/helpers-data-merge.test.ts tests/service/worldbook/pipeline.test.ts`、`npm run typecheck`、`npm run build`、`npm test`。这不是临时补丁，质量达到了可交付标准。
</output_quality_review>
