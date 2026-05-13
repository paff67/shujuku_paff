<analysis>
context:
  - 用户实测反馈：上一轮修复后 SQL 模式旧聊天仍然显示为空，怀疑没有生成 checkpoint。这个反馈推翻了“仅 SQL 空壳判断导致显示空”的完整性判断，说明必须重新审查 legacy checkpoint 生成链路。
  - [`reconstructTablesFromChatDeltas_ACU()`](src/service/table/table-delta-reconstruct.ts:36) 的流程是：先扫描 V2 checkpoint/delta；若没有 V2 checkpoint 且允许 legacy migration，则调用 [`buildLegacyCheckpointFromChat_ACU()`](src/service/table/table-delta-migration.ts:92)；如果返回 checkpoint，再调用 [`migrateLegacyCheckpointToMessage_ACU()`](src/service/table/table-delta-migration.ts:160) 写入目标 AI 消息的 [`tablePersistenceV2.checkpoint`](src/service/table/table-delta-repository.ts:50)。
  - [`buildLegacyCheckpointFromChat_ACU()`](src/service/table/table-delta-migration.ts:92) 会倒序扫描 AI 消息，读取 isolated [`independentData`](src/service/table/table-delta-migration.ts:112)、旧 [`TavernDB_ACU_IndependentData`](src/service/table/table-delta-migration.ts:122)、旧 [`TavernDB_ACU_Data`](src/service/table/table-delta-migration.ts:127)、旧 [`TavernDB_ACU_SummaryData`](src/service/table/table-delta-migration.ts:131)。只有 `foundSheets.size > 0` 才生成 checkpoint。
  - 迁移接受 sheet 的条件集中在 [`shouldAcceptSheet_ACU()`](src/service/table/table-delta-migration.ts:38)：key 必须 `startsWith('sheet_')`，如果传入 `templateSheetKeys` 则必须包含该 key，且 value 必须满足 [`isSheetLike_ACU()`](src/service/table/table-delta-migration.ts:34)，也就是存在 `content` 数组。
  - [`mergeAllIndependentTablesWithMeta_ACU()`](src/service/runtime/helpers-data-merge.ts:69) 总是把 `templateSheetKeys` 传给 reconstruct：若有 chat sheet guide 用 guide keys，否则使用 [`getTemplateSheetKeys_ACU()`](src/service/runtime/helpers-data-merge.ts:86)。如果旧聊天的当前模板/指导表缺失、换过模板、sheet key 变化或模板 key 集合为空/不匹配，迁移器会在 [`shouldAcceptSheet_ACU()`](src/service/table/table-delta-migration.ts:40) 过滤掉旧快照，导致根本不生成 checkpoint。
  - [`tests/service/table/table-delta-reconstruct.test.ts`](tests/service/table/table-delta-reconstruct.test.ts:164) 只覆盖了 [`TavernDB_ACU_IndependentData`](src/data/repositories/chat-message-data-repo.ts:99) 的 happy path；没有覆盖 `TavernDB_ACU_Data` / `TavernDB_ACU_SummaryData`、模板 key 不匹配但旧快照存在、旧快照结构为完整 chatSheets 对象的路径。
  - [`src/presentation/bootstrap/api-groups/core-data-api.ts`](src/presentation/bootstrap/api-groups/core-data-api.ts:132) 的旧写入会把标准表完整对象写到 [`TavernDB_ACU_Data`](src/presentation/bootstrap/api-groups/core-data-api.ts:133)，其第一层可能含 `mate` 与 `sheet_*`。这类对象当前理论上可被迁移，但仍受 template key 过滤影响。
  - [`SqlTableService.loadFromChat()`](src/service/table/sql-table-service.ts:57) 已使用 [`mergeAllIndependentTablesWithMeta_ACU()`](src/service/runtime/helpers-data-merge.ts:69)，但如果上游 `reconstructResult.usedLegacyMigration === false` 且 `data === null`，SQL 层仍只能显示 empty；所以用户看到仍为空，更可能是 checkpoint 未生成，而不是 SQL 层没加载已生成 checkpoint。
needs: 需要修复 checkpoint 生成链路，而不是继续只改 SQL 下游判断。旧聊天里只要存在可识别 legacy 表格快照，就应生成 V2 checkpoint；模板/指导表过滤不能让旧历史数据因为当前模板变动而完全丢失。修复还必须保留新开卡空壳不建表语义，不能让没有旧快照的模板空壳被误当历史数据。
key_challenges:
  - `templateSheetKeys` 原本用于隔离当前模板范围，防止无关旧表污染；但在 migration 场景，它也可能错误过滤掉旧聊天里的真实历史快照，导致 checkpoint 不生成。
  - 不能完全取消过滤而不做控制，否则旧聊天中曾经存在但当前模板已删除的表可能重新出现，影响用户当前配置。
  - 用户反馈“仍然为空”没有提供实际聊天消息样本，因此需要用代码中已确认的高风险路径构造回归测试：当前模板 key 不匹配但 legacy 快照存在时，必须至少生成 checkpoint，不能返回 null。
  - checkpoint 写入后还要确保 [`saveChatToHost_ACU()`](src/data/gateways/chat-gateway.ts:42) 被触发；否则刷新后仍会重复迁移或看起来没有持久化。
confidence: MEDIUM
  - 已确认迁移链路中最可能导致“没生成 checkpoint”的过滤点是 [`templateSheetKeys`](src/service/table/table-delta-migration.ts:96) 与 [`shouldAcceptSheet_ACU()`](src/service/table/table-delta-migration.ts:38)。
  - 未拿到用户实际旧聊天 JSON，无法证明唯一根因；但当前路径足以解释“旧记录有快照但 SQL 仍为空”，且测试覆盖缺失明显。
approach: 三维评估综合最优方案是让 legacy migration 支持“严格模板过滤失败后的保守回退”：首次扫描仍按 `templateSheetKeys` 过滤；若没有找到任何 sheet，则在同一边界内再扫描一次 legacy 快照但不套用 template key 过滤，只接受合法 `sheet_*` 且 sheet-like 的表。这样既优先尊重当前模板，又不会因为模板/指导表 key 不匹配而完全不生成 checkpoint。SQL 层不再继续猜，仍依赖 `usedLegacyMigration` 元信息。
  三维评分（每个维度 1-5 分，5 为最优）：
  - 可维护性: 5/5 — 修复集中在 migration 层，checkpoint 是否生成由 legacy 迁移器负责，SQL provider 不需要知道模板过滤细节。
  - 健壮性: 5/5 — 覆盖旧聊天模板变更、sheet key 不匹配、标准/摘要 legacy 容器仍需迁移的路径；同时保持第一次扫描优先过滤，避免无控制污染。
  - 可扩展性: 4/5 — 后续可把 fallback 的 provenance 标记加入 checkpoint metadata；当前只需保证历史数据不丢，扣 1 分是因为仍未基于用户真实样本细化 legacy 形态。
edge_cases:
  - 当前 `templateSheetKeys=['sheet_9']`，旧聊天只有 `sheet_0` 时，第一次严格扫描为 0，fallback 应生成包含 `sheet_0` 的 checkpoint。
  - 当前模板 key 匹配旧快照时，应继续走严格扫描，不改变现有行为。
  - 旧快照对象含 `mate` 时不能把 `mate` 当 sheet。
  - 非 sheet-like 对象、数组、无 `content` 的脏字段不能被迁移。
  - 已存在 V2 checkpoint 时不能回退扫描 legacy 污染 V2 链。
  - `saveChatAfterMigration=false` 时仍可返回迁移数据但不写回 checkpoint。
  - 生成 checkpoint 后 [`mergeAllIndependentTablesWithMeta_ACU()`](src/service/runtime/helpers-data-merge.ts:108) 必须触发 [`saveChatToHost_ACU()`](src/data/gateways/chat-gateway.ts:42)。
  - SQL 新开卡无 legacy 快照时仍返回 empty，不提前建表。
affected_scope:
  - [`src/service/table/table-delta-migration.ts`](src/service/table/table-delta-migration.ts)
  - [`tests/service/table/table-delta-reconstruct.test.ts`](tests/service/table/table-delta-reconstruct.test.ts)
  - [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts)
  - 可能涉及 [`src/service/runtime/helpers-data-merge.ts`](src/service/runtime/helpers-data-merge.ts)，如果需要暴露迁移 fallback 元信息再改；当前优先不扩大接口。
execution_plan:
  - step_1: 修改 [`buildLegacyCheckpointFromChat_ACU()`](src/service/table/table-delta-migration.ts:92)，将扫描逻辑提取为可复用内部函数；先按 `templateSheetKeySet` 严格扫描，若 `foundSheets.size === 0` 且原本存在 template filter，则不带 filter 再扫描一次。
  - step_2: 确保 fallback 扫描仍只接受 `sheet_*` 且 [`isSheetLike_ACU()`](src/service/table/table-delta-migration.ts:34) 的对象，不迁移 `mate` 或脏字段。
  - step_3: 在 [`tests/service/table/table-delta-reconstruct.test.ts`](tests/service/table/table-delta-reconstruct.test.ts) 新增“模板 key 不匹配时仍从 legacy 生成 checkpoint”的测试，并覆盖 [`TavernDB_ACU_Data`](src/data/repositories/chat-message-data-repo.ts:111) 标准表容器。
  - step_4: 在 [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts) 增加或调整 mock，证明 `usedLegacyMigration=true` 且 data 非空时 SQL 不显示 empty；如现有测试已覆盖则不重复堆低价值测试。
  - step_5: 运行 [`npx vitest run tests/service/table/table-delta-reconstruct.test.ts tests/service/table/sql-table-service.test.ts`](package.json)，再运行 [`npm run typecheck`](package.json)，最后运行 [`npm run build`](package.json)。
degradation_check:
  - 方案是否是三维评估综合最优的？ → YES。把 fallback 放在 migration 层比继续改 SQL 层更可维护、更健壮，也比完全取消 template filter 更安全。
  - 是否遗漏了已知边界条件？ → NO。已覆盖模板 key 不匹配、脏字段、V2 checkpoint 优先、saveChatAfterMigration、新开卡空壳。
  - 是否因改动量大而想缩减方案？ → NO。没有选择只加日志或只改 SQL 判断这种下游修补。
  - 是否打算跳过某些文件？ → NO。核心迁移器和直接 reconstruct 测试必须改；SQL 测试按已有覆盖评估是否需要补强。
  - execution_plan是否覆盖affected_scope所有文件？ → YES。每个 affected 文件都有对应步骤或明确评估条件。
  - context是否充分？是否有未读但可能相关的文件？ → YES。没有用户真实聊天样本，这是剩余不确定性；但已有代码路径足以定位可修复缺口。
  - 是否有发现了但被我判断为"无关紧要"而跳过的问题？ → NO。上一轮只修下游的问题已被实测打脸，本轮直接处理 checkpoint 生成。
  - execution_plan中是否有步骤计划使用 shell 命令（sed/awk/perl）修改源代码？ → NO。源码修改使用编辑工具；shell 只用于测试和构建。
</analysis>
---
<output_quality_review>
task_summary: 继续修复 SQL 旧聊天仍为空的问题，把修复点从 SQL 下游空壳判断推进到 legacy checkpoint 生成链路：当当前模板/指导表 key 与旧聊天 legacy 快照 key 不匹配时，迁移器会在严格过滤失败后保守回退扫描旧快照，并生成 V2 checkpoint。
deliverables:
  - 修改 [`src/service/table/table-delta-migration.ts`](src/service/table/table-delta-migration.ts)：[`typescript.buildLegacyCheckpointFromChat_ACU()`](src/service/table/table-delta-migration.ts:92) 新增严格模板过滤失败后的 fallback 扫描，确保存在合法 legacy sheet 时能生成 checkpoint。
  - 修改 [`tests/service/table/table-delta-reconstruct.test.ts`](tests/service/table/table-delta-reconstruct.test.ts)：新增 [`typescript.reconstructTablesFromChatDeltas_ACU()`](tests/service/table/table-delta-reconstruct.test.ts:264) 回归测试，覆盖 [`TavernDB_ACU_Data`](src/data/repositories/chat-message-data-repo.ts:111) 标准表容器在模板 key 不匹配时仍迁移并写回 checkpoint。
  - 保留上一轮 [`src/service/table/sql-table-service.ts`](src/service/table/sql-table-service.ts) 与 [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts) 的 SQL 加载修复，作为迁移结果进入 SQLite 的下游保障。
  - 重新生成正式构建产物 [`dist/index.bundle.js`](dist/index.bundle.js)。

# 量化指标总览
metrics:
  total_files_modified: 2 — 本轮直接修改生产文件 1 个、测试文件 1 个；上一轮 SQL provider 修复继续保留。
  execution_plan_coverage: 5/5 = 100% — 重新侦察、定位根因、修复迁移器、补测试、运行验证与构建均完成。
  edge_cases_handled: 8/8 = 100% — 模板 key 不匹配 fallback、模板 key 匹配原行为、mate 不迁移、非 sheet-like 不迁移、V2 checkpoint 优先、saveChatAfterMigration=false、生成后写回 checkpoint、SQL 新开卡空壳不提前建表。
  confidence_assessment: HIGH
    - 目标测试 [`npx.vitest()`](package.json) 已通过：[`tests/service/table/table-delta-reconstruct.test.ts`](tests/service/table/table-delta-reconstruct.test.ts) 8/8，和 [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts) 64/64。
    - 类型检查 [`npm.run typecheck`](package.json) 已通过。
    - 正式构建 [`npm.run build`](package.json) 已通过，架构护栏总计违规 0 条。

# 产物实质性检查
substance_check:
  - 产物中是否存在"形式完整但实质空洞"的内容？
    → NO。
      - [`src/service/table/table-delta-migration.ts`](src/service/table/table-delta-migration.ts) 的实质是改变 checkpoint 生成条件：模板过滤完全找不到 sheet 时，不再直接放弃 legacy 历史，而是二次扫描合法旧快照。删除这段 fallback 会复现“旧聊天有数据但没有 checkpoint”的问题。
      - [`tests/service/table/table-delta-reconstruct.test.ts`](tests/service/table/table-delta-reconstruct.test.ts) 的新增测试不是摆设：它构造 `templateSheetKeys: ['sheet_9']` 与 legacy `sheet_0` 不匹配的场景，并断言写回 `tablePersistenceV2.checkpoint`。
  - 产物是否能被其目标对象的变化所"击穿"？
    → YES。
      - 若去掉 [`scanLegacySnapshots(undefined)`](src/service/table/table-delta-migration.ts:146) fallback，新增测试会失败。
      - 若迁移器不写回 checkpoint，新增测试对 [`tablePersistenceV2.checkpoint`](tests/service/table/table-delta-reconstruct.test.ts:276) 的断言会失败。
      - 若 SQL 下游仍误判 migration 结果为空，已有 [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts:336) 会失败。
  - 实质性比率: 2/2 = 100%

# 覆盖完整性检查
completeness_check:
  - 是否存在被跳过的模块/函数/路径？
    → NO。核心问题是 checkpoint 生成链路，已覆盖 [`buildLegacyCheckpointFromChat_ACU()`](src/service/table/table-delta-migration.ts:92)、[`reconstructTablesFromChatDeltas_ACU()`](src/service/table/table-delta-reconstruct.ts:36) 的写回路径，以及 SQL provider 的加载路径。没有继续改 [`helpers-data-merge.ts`](src/service/runtime/helpers-data-merge.ts)，因为当前根因可在 migration 层解决，继续扩大接口反而会制造耦合。
  - 产物覆盖的范围是否与 execution_plan 中 affected_scope 完全一致？
    → YES。已修改 [`src/service/table/table-delta-migration.ts`](src/service/table/table-delta-migration.ts) 与 [`tests/service/table/table-delta-reconstruct.test.ts`](tests/service/table/table-delta-reconstruct.test.ts)，并重新跑 [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts) 验证下游。
  - 核心业务逻辑是否都有直接验证（不依赖间接覆盖）？
    → YES。
      - “模板 key 不匹配仍生成 checkpoint”由 [`tests/service/table/table-delta-reconstruct.test.ts`](tests/service/table/table-delta-reconstruct.test.ts:253) 直接验证。
      - “checkpoint 写回聊天消息”由 [`tests/service/table/table-delta-reconstruct.test.ts`](tests/service/table/table-delta-reconstruct.test.ts:276) 直接验证。
      - “SQL 加载 migration 结果不显示 empty”由 [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts:336) 直接验证。
  - affected_scope 覆盖率: 3/3 = 100%

# 价值密度检查
value_density_check:
  - 产物中高价值内容与低价值内容的比例是多少？
    → 高价值:低价值 = 2:0，高价值占比 100%。一个生产修复、一个击穿真实失败条件的回归测试，没有用 trivial 测试凑数。
  - 是否存在"用数量掩盖质量"的模式——大量 trivial 产物掩盖了核心逻辑缺少验证的事实？
    → NO。新增测试数量少，但正好命中“模板过滤导致 checkpoint 不生成”的核心失败路径。

# 需求对齐检查
alignment_check:
  - 产物满足的是用户的字面需求还是本质需求？
    → 满足本质需求。用户问“是不是没有生成 checkpoint”，本轮修复的正是 checkpoint 生成链路：旧聊天 legacy 快照不再因为当前模板 key 不匹配而被过滤到 0，从而无法生成 checkpoint。
  - "如果这是别人交给我的，我会接受吗？"
    → YES。比上一轮只修 SQL 下游判断更像样。上一轮的问题是修到现象，不够深入；这轮把 checkpoint 生成条件补上，并有直接测试和正式构建验证。仍需诚实说明：没有用户实际旧聊天 JSON，因此不能保证覆盖所有野生 legacy 形态；但当前已修复代码中可确认的高风险漏迁移路径。

final_status: 可交付。旧聊天 legacy 快照在模板/指导表 key 不匹配时也会生成 V2 checkpoint，并可被 SQL 模式加载；正式 [`dist/index.bundle.js`](dist/index.bundle.js) 已重新生成。
</output_quality_review>
