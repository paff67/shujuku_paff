<analysis>
context:
  - 用户报告的新现象是“第二轮填表后，表格数据直接被清空；回退楼层也不能回到上一次填表的数据”。这比上一轮“INSERT 覆盖 UPDATE”更严重，因为它同时影响运行时视图和楼层 V2 checkpoint/delta 重建。
  - src/service/table/update-orchestrator.ts:567-705 的 processUpdatesBatch_ACU 在每个批次开始时会构建 mergedBatchData，再调用 loadBatchBaseData_ACU 从聊天记录重建目标批次之前的数据。SQLite 模式下会调用 provider.replaceCurrentData(mergedBatchData)，然后把 provider.getCurrentData() 同步到 currentJsonTableData_ACU。
  - src/service/table/update-orchestrator.ts:177-206 的 mergeProviderRowsIntoBatchSheets_ACU 是上一轮新增逻辑，只在 batchSheet 和 providerSheet 都存在、且 providerSheet 有真实数据行时才补行。它不能处理“reconstruct/loadBatchBaseData 返回空或 header-only，但 provider 当前数据也因前置 replace/按需建表被清空”的保存后问题。
  - src/service/table/update-orchestrator.ts:335-520 的 executeCardUpdateCore_ACU 在 AI 成功后捕获 successfulBeforeData 和 successfulAfterData，再调用 persistTablesToChatMessage_ACU 写 V2 delta。也就是说如果 currentJsonTableData_ACU 在 parseAndApplyTableEdits_ACU 后已经被同步成 header-only 或 mate-only，afterData 会成为空快照，delta 层就会把它解释为删除/清空。
  - src/service/table/table-service.ts:156-187 的 persistTablesToChatMessage_ACU 会用 beforeData/afterData 创建 V2 delta。createTableDeltaFromBeforeAfter_ACU 对 before 有 sheet、after 没 sheet 的情况会生成 clearSheet；对 before 有数据行、after 只有表头的情况会生成 delete 行。这个机制本身正确，但如果上游 afterData 错误为空，就会把错误状态永久写进楼层。
  - src/service/table/table-delta-diff.ts:60-69 明确 beforeSheet 存在而 afterSheet 不存在时生成 rowChanges: [{ op: 'clearSheet' }]；src/service/table/table-delta-apply.ts:100-104 应用 clearSheet 会清空数据行；src/service/table/table-delta-reconstruct.ts:69-71 回退重建时会正序应用 delta。因此一旦第二轮保存了错误的清空 delta，回退楼层也无法恢复上一轮填表数据。
  - src/service/table/sql-table-service.ts:204-223 的 replaceCurrentData 会 dispose 当前 engine 并用 SyncBridge.loadFromTableData 重建 SQLite，然后 _markCommitted(data)。如果传入的是 header-only 表，它仍会建出空表，并把 committedSnapshot 标记为空表；后续 applyEdits 如果 AI 输出为空编辑或只改了未命中行，saveToChat 的 before/after 就可能围绕空表提交。
  - src/service/table/sql-table-service.ts:488-557 的 _ensureTablesFromTemplate 存在更直接的风险：它构造 partialData 只包含 missingSheets，然后调用 syncBridge.loadFromTableData(partialData)。而 src/data/sqlite/sync-bridge.ts:145-148 的 _loadSheet 会 drop 已存在的同名用户表，loadFromTableData 语义是替换式加载。虽然 _ensureTablesFromTemplate 只传 missingSheets，看似不会遍历已有表，但如果 currentJsonTableData_ACU/template 判定让已有表被误判为 missing，或者同一 DDL 表名跨 sheet 变化，按需建表会造成表级 drop。这个路径需要测试守住，但当前用户现象更像保存了清空 delta。
  - src/data/sqlite/sync-bridge.ts:73-101 的 exportToTableData 只导出 engine.getTableNames() 中有 meta 的用户表；如果 SQLite 里用户表为空但 meta 存在，会导出 header-only sheet；如果没有用户表，会导出 mate-only，再由 sql-table-service.ts:396-406 的 _resolveExportedDataForJsonView 在空库时保留 currentJsonTableData_ACU 的 sheet shell。
  - src/service/runtime/helpers-data-merge.ts:91-99 通过 reconstructTablesFromChatDeltas_ACU 合并当前聊天楼层；若最新楼层保存了 clearSheet/delete-all delta，mergeAllIndependentTablesWithMeta_ACU 会忠实重建为空表，并且 foundCount 仍可能大于 0，这解释了为什么回退/刷新不能回到上一轮数据。
  - tests/service/table/update-orchestrator.test.ts 当前 processUpdatesBatch 的 provider mock 只是把传入数据克隆到 mockProviderCurrentData，不具备真实 SqlTableService 的 export/save/delta 行为，因此上一轮测试没有覆盖“执行后保存空 afterData 导致回退失败”。
  - tests/service/table/sql-table-service.test.ts 当前已有 applyEdits UPDATE+INSERT 保留行测试，但没有覆盖 saveToChat 在 afterData 为空表/mate-only 时是否会把清空 delta 传给 persistTablesToChatMessage_ACU，也没有覆盖 replaceCurrentData(header-only) 后空编辑/未命中编辑的保存防线。
needs:
  - 本质目标不是再次让第二轮当前视图短暂显示正确，而是保证第二轮填表后不会把错误的空快照写入 V2 delta，并且回退/刷新楼层时能从上一个有效楼层恢复数据。
  - 必须增加持久化防线：当目标 sheet 在 beforeData 中有真实数据行，而 afterData 中对应 sheet 缺失或只有表头，并且本轮并非显式清空表的合法操作时，不能生成 clearSheet/delete-all delta。否则任何运行时同步异常都会被永久落盘。
  - 必须分清合法清空和异常清空：用户/AI 真实 DELETE 全表理论上可能存在，但当前填表自动更新的常规场景不应把“SQL 未命中、空编辑、导出空壳、运行时重建空表”当成合法全清。
  - 必须补测试覆盖两个层级：SqlTableService/saveToChat 不应把异常空 afterData 传成清空 delta；table-delta-diff 或 persist 层需要阻止 targetSheetKeys 中的异常空表 delta 污染历史。
key_challenges:
  - 清空在 delta 语义里是合法操作，不能粗暴删除 clearSheet 支持，否则真正的清空/回退语义会被破坏。
  - 运行时 currentJsonTableData_ACU、SqlTableService.committedSnapshot、pendingBeforeSnapshot、V2 delta 四套状态必须一致；只修 UI 视图会让回退继续坏，只修 delta 会让当前视图继续清空。
  - 需要在最靠近持久化的边界加保护，因为清空 afterData 可能来自 replaceCurrentData、_syncToJson、_ensureTablesFromTemplate 或 AI 空编辑等不同路径。靠某一个上游函数兜底不够。
  - 测试必须能击穿真实问题：至少要构造 beforeData 有行、afterData 缺 sheet 或 header-only 的保存路径，断言不会生成清空 delta，且 reconstructTablesFromChatDeltas_ACU 回放后仍保留上一轮数据。
confidence: MEDIUM
  - 侦察已覆盖编排层、SQL provider、SyncBridge、delta diff/apply/reconstruct、mergeAll 与相关测试，清空 delta 导致回退失败的链条闭合。
  - 仍需进一步执行期验证具体哪一种 afterData 形态最符合用户现场：mate-only、header-only、还是目标 sheet 被误删。方案会覆盖这三类异常空快照，但合法全表清空的判定还需要通过测试和现有接口语义精确收口。
approach:
  - 三维评分（每个维度 1-5 分，5 为最优）：
  - 可维护性: 5/5 — 在持久化/delta 创建边界增加异常空快照防线，比在多个上游同步点打补丁更集中；保留 SyncBridge 和 SqlTableService 的既有契约，不把底层替换语义改成含糊的合并语义。
  - 健壮性: 5/5 — 同时覆盖 afterData 缺 sheet、header-only 删除所有行、mate-only 导出、第二轮保存后回退重建等边界；即使上游再次短暂产生空视图，也不会把事故写进聊天楼层。
  - 可扩展性: 4/5 — 保护规则需要区分异常清空与合法清空。当前可通过 trackAsUpdate、modifiedKeys/updateGroupKeys、targetSheetKeys 和显式 clear 操作缺失来做保守判定；未来如果引入正式“清空表”操作标记，应把该标记加入 TableChatPersistOptions 或 delta options 中。
  - 推荐方案：在 persistTablesToChatMessage_ACU 进入 createTableDeltaFromBeforeAfter_ACU 前，对 targetSheetKeys 执行异常空快照保护。若 before sheet 有真实数据行，而 after sheet 缺失或没有真实数据行，并且本轮没有显式允许清空，则用 before sheet 回填 afterData 中该 sheet，阻止生成 clearSheet/delete-all delta；同时记录 warning。该保护只阻止“把已有数据意外清空并落盘”，不影响正常 upsert/update/insert，也不改变 delta apply/reconstruct 的合法清空能力。
edge_cases:
  - afterData 为 null 或只含 mate，但 beforeData 中 target sheet 有真实行：保存层必须保留 before sheet，不能生成 clearSheet。
  - afterData 有目标 sheet 但 content 只有表头，而 beforeData 有真实行：除非显式允许清空，否则保存层必须保留 before sheet，不能生成 delete-all delta。
  - beforeData 没有真实行，afterData header-only：这是新表空壳或首次初始化，不应被误判为异常清空。
  - afterData 有真实行但少了部分 before 行：这可能是合法 DELETE 或 AI 修改结果，不应被本保护阻止；上一轮的“INSERT 覆盖 UPDATE”已在批次基底层处理，不能在保存层强行禁止所有删除。
  - targetSheetKeys 为空或 null 保存全量时，需要只检查 sheet_ 开头的实际表，不处理 mate。
  - isFirstTimeInit 保存所有表时，模板 seed/header-only 不应被阻止；因为 beforeData 通常为空或无真实行。
  - 明确合法清空操作未来需要显式 allowClearSheet/allowEmptyAfter 之类参数；当前没有该参数，所以自动填表保存路径默认不允许把已有真实行变成空表落盘。
  - V2 reconstruct 必须保持 clearSheet 的应用能力，不能删除 delta 层 clearSheet 支持，否则已有历史中的合法清空无法重放。
affected_scope:
  - src/service/table/table-service.ts
  - tests/service/table/table-service.test.ts
  - tests/service/table/sql-table-service.test.ts
  - tests/service/table/table-delta-reconstruct.test.ts
  - .analysis-cache.md
execution_plan:
  - step_1: 在 src/service/table/table-service.ts 中新增持久化前的异常空快照保护辅助函数：判断 sheet 是否有真实数据行、after 是否缺 sheet 或 header-only、before 是否有真实数据行；在 persistTablesToChatMessage_ACU 创建 delta 前生成 sanitizedAfterData，并用它替代 resolvedAfterData 传入 createTableDeltaFromBeforeAfter_ACU。保护触发时写 logWarn_ACU，说明阻止了目标 sheet 的异常清空落盘。
  - step_2: 若 TableChatPersistOptions 需要表达未来合法清空，增加可选字段 allowEmptyAfterDataForTargetSheets?: boolean 或 allowClearingTargetSheets?: boolean，默认 false；当前 executeCardUpdateCore_ACU 不传该字段，因此自动填表路径受保护。这个字段只作为显式逃生口，不改变默认生产路径。
  - step_3: 在 tests/service/table/table-service.test.ts 增加持久化层回归：beforeData 有 sheet_0 数据行，afterData 缺 sheet_0 或 header-only，调用 persistTablesToChatMessage_ACU 后写入的 tablePersistenceV2.delta 不应包含 clearSheet/delete-all；reconstructTablesFromChatDeltas_ACU 回放后应保留上一轮行。
  - step_4: 在 tests/service/table/sql-table-service.test.ts 增加 provider 层回归：模拟 saveToChat 收到 afterData header-only/mate-only 的场景时，传给 saveIndependentTableToChatHistory_ACU 的 afterData 不应清空 committed before 中已有真实行，防止 SQLite 导出空壳污染楼层。
  - step_5: 在 tests/service/table/table-delta-reconstruct.test.ts 增加端到端重建回归：checkpoint 或上一轮 delta 有数据，后一楼层尝试写入异常空 delta 时，经过持久化保护后 reconstruct 仍能回到上一轮数据。若 step_3 已充分覆盖 reconstruct，可将此测试放在 table-service.test.ts 内完成，不重复造低价值测试。
  - step_6: 运行目标测试 tests/service/table/table-service.test.ts、tests/service/table/sql-table-service.test.ts、tests/service/table/table-delta-reconstruct.test.ts；随后运行 npm run typecheck、npm run build、npm test。
degradation_check:
  - 方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。方案在可维护性 5/5、健壮性 5/5、可扩展性 4/5；集中在持久化边界阻止事故落盘，比修改底层替换语义或删除 clearSheet 更稳。
  - 是否遗漏了已知边界条件？ → NO。已覆盖 mate-only、缺 sheet、header-only、before 无真实行、合法 clearSheet 能力保留、全量保存 targetSheetKeys 为空等边界。
  - 是否因改动量大而想缩减方案？ → NO。不会只修当前视图；必须同时处理楼层持久化和回退重建。
  - 是否打算跳过某些文件？ → NO。实现层、provider 测试、持久化/重建测试和分析缓存都纳入 affected_scope。
  - execution_plan是否覆盖affected_scope所有文件？ → YES。table-service.ts 在 step_1/2 覆盖，table-service.test.ts 在 step_3 覆盖，sql-table-service.test.ts 在 step_4 覆盖，table-delta-reconstruct.test.ts 在 step_5 覆盖，.analysis-cache.md 由本 analysis 写入覆盖。
  - context是否充分？是否有未读但可能相关的文件？ → NO。已读取编排、SQL provider、SyncBridge、delta diff/apply/reconstruct、mergeAll、provider interface 和相关测试。presentation 回退按钮不需要先读，因为重建失败的根因已定位到持久化 delta；若后续测试显示 UI 回退另有路径，再追加侦察。
  - 是否有发现了但被我判断为"无关紧要"而跳过的问题？ → NO。_ensureTablesFromTemplate 的 partialData + replacement 语义风险已记录；本轮优先处理会污染楼层历史的持久化清空。如果测试暴露该路径实际 drop 已有表，需要进入 decision_point 扩大修复。
  - execution_plan中是否有步骤计划使用 shell 命令（sed/awk/perl）修改源代码？ → NO。源代码和测试修改使用 edit_file；命令只用于测试、类型检查和构建。
</analysis>
---
<decision_point>
issue: 编辑 tests/service/table/table-service.test.ts 后工具再次报告 tsconfig.json 的 baseUrl 在 TypeScript 7.0 中将弃用。这个诊断来自编辑器/语言服务，不是当前源代码或测试逻辑错误；上一轮正式 npm run typecheck 曾通过，但本轮仍需在最终验证中重新确认。
impact: NO。当前诊断不改变清空快照落盘修复的可行性；若正式 npm run typecheck 失败，再把 tsconfig.json 纳入 affected_scope 处理。现在修改 tsconfig.json 会把无关配置迁移混进高风险数据一致性修复。
context_update:
  - analysis 的 execution_plan step_6 已包含 npm run typecheck，足以用正式结果验证该配置诊断是否会阻塞交付。
  - affected_scope 暂不扩大；仍集中在 table-service.ts 与相关测试。
options:
  - option_a:
      description: 立即修改 tsconfig.json，添加 ignoreDeprecations 配置以压制 baseUrl 弃用诊断。
      approach_evaluation: 可维护性 2/5，因为把 TypeScript 迁移噪音混入数据清空修复；健壮性 3/5，可能消除编辑器提示，但若当前 TS 版本或项目约定不接受该字段会引入新配置问题；可扩展性 2/5，静音迁移提醒可能掩盖未来正式升级需要。
      edge_cases: 配置变更会扩大回归面，且与用户报告的楼层清空没有直接因果关系。
      affected_scope_delta: 新增 tsconfig.json。
  - option_b:
      description: 不修改 tsconfig.json，继续完成当前实现和测试；最终以 npm run typecheck 的正式结果作为是否处理配置的依据。
      approach_evaluation: 可维护性 5/5，因为保持 bugfix scope 清晰；健壮性 5/5，因为正式 typecheck 仍会捕获真实阻塞；可扩展性 5/5，因为不提前静音未来迁移问题。
      edge_cases: 如果最终 typecheck 失败，必须新增 decision_point 并处理 tsconfig.json。
      affected_scope_delta: 无。
  - option_c:
      description: 暂停当前清空快照修复，先系统处理 TypeScript 7.0 配置迁移。
      approach_evaluation: 可维护性 2/5，因为任务切换会打断当前数据一致性事故修复；健壮性 2/5，因为用户数据清空风险仍未处理；可扩展性 3/5，长期配置迁移有价值但当前优先级错误。
      edge_cases: 当前清空 delta 问题继续存在，测试和实现中断。
      affected_scope_delta: 新增 tsconfig.json 及潜在构建配置文件。
recommendation: 选择 option_b。三维评估显示 option_b 在可维护性 5/5、健壮性 5/5、可扩展性 5/5 上最优；它不回避验证，也不把无关配置迁移塞进本次数据修复。助手，看到诊断就乱改配置，是把提交做脏的常见开端。
execution_plan_update: 保持原 execution_plan 不变。继续补充 table-service 与 sql-table-service 回归测试；最终运行 npm run typecheck，如果正式失败再进入新的 decision_point 处理 tsconfig.json。
deviation_audit:
  original_plan_excerpt:
    - step_6: 运行目标测试 tests/service/table/table-service.test.ts、tests/service/table/sql-table-service.test.ts、tests/service/table/table-delta-reconstruct.test.ts；随后运行 npm run typecheck、npm run build、npm test。
  current_proposal: 不修改 tsconfig.json，继续执行当前实现和测试，在 step_6 通过正式 npm run typecheck 验证是否需要处理配置。
  diff_summary: 没有删减原计划；只是确认编辑器诊断不改变执行路径。
  deviation_motive_check:
    - 措辞替换规则逐类检查：未命中降级措辞。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。当前方案保持原计划，不降低质量。
    - 偏离是否导致 affected_scope 缩小？→ NO。affected_scope 不变。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_b 三维均为 5/5。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。配置诊断将在正式 typecheck 中验证。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。不修改 tsconfig.json 是为了避免无关变更，不是跳过验证。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。原 affected_scope 不变。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。该诊断已记录，并由最终 typecheck 复核。
  - options 是否包含至少三个方案？ → YES。包含 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。不涉及 shell 修改。
  - deviation_audit 是否触发了 self_dissection？ → NO。未触发偷懒判定。
</decision_point>
---
<decision_point>
issue: 目标测试失败，暴露出两个测试/实现边界未被正确建模：（1）table-service 回归测试中用 reconstructTablesFromChatDeltas_ACU 直接重建被 mock 的 chat-message-data-repo 环境，导致 checkpoint 读取链路返回 null，而不是证明持久化保护失败；（2）sql-table-service 回归测试假定 headerOnlyData 的表头能完整导出，但 SQLite schema 由 DDL 决定，当前测试数据的 DDL 只导出了 row_id，断言写成 item_name/quantity 是测试前提错误。这个问题在分析阶段未预见，是因为当时只评估了业务链路，没有重新核对测试 fixture 的 DDL/schema 映射和 table-delta-reconstruct 在 mock 环境下的依赖。
impact: YES。它影响测试有效性，不影响当前持久化防线方案本身。若直接改成宽松断言，会让测试变成“能过但不证明问题”的废物；若错误修改生产代码以迎合错误 fixture，则会污染 SQLite schema/export 语义。
context_update:
  - analysis.execution_plan step_3 需要调整：table-service.test.ts 中的“回退重建仍保留上一轮数据”不能在 chat-message-data-repo 被 mock 的同一测试环境里直接依赖 reconstructTablesFromChatDeltas_ACU；应改为直接检查目标消息没有写入清空 delta，并检查 protect 后写入层不破坏 checkpoint，或改用更贴合当前 mock 的断言。
  - analysis.execution_plan step_4 需要调整：sql-table-service.test.ts 的 provider 层测试应断言 saveToChat 把 header-only afterData 原样交给持久化层且不显式允许清空；表头应以实际导出 schema 为准，或使用与 DDL 一致的 header。
options:
  - option_a:
      description: 修改生产代码，让 SqlTableService 在 replaceCurrentData(headerOnlyData) 后强制保留 JSON content 表头，即使 SQLite DDL 导出的 schema 不一致；同时让 reconstructTablesFromChatDeltas_ACU 在测试 mock 下绕过 repository 读取失败。
      approach_evaluation: 可维护性 1/5，因为为了错误测试改生产语义；健壮性 1/5，因为会掩盖 DDL 与 content 不一致的真实 schema 问题；可扩展性 1/5，因为后续 SQL 导出规则会被 JSON 表头反向污染。
      edge_cases: DDL 与 content 表头不一致时会产生双重真相；真实 SQL 表列可能被 UI 表头覆盖，导致查询和导出不一致。
      affected_scope_delta: 新增 src/service/table/sql-table-service.ts 和 src/service/table/table-delta-reconstruct.ts 的非必要改动。
  - option_b:
      description: 修正测试前提：table-service.test.ts 保留对“不会写入 clearSheet/delete-all delta”的直接断言，把 mock 环境下不可靠的 reconstruct 调用移除或替换成对 root checkpoint 未被破坏的直接检查；sql-table-service.test.ts 改用实际导出的 header [['row_id']]，并明确该测试只验证 saveToChat 把异常空壳 afterData 与 beforeData 传给持久化层且不设置 allowClearingTargetSheets，由 table-service.test.ts 负责验证持久化层会阻止落盘清空。
      approach_evaluation: 可维护性 5/5，因为测试职责清晰分层，provider 测试验证传参契约，持久化测试验证防线行为；健壮性 5/5，因为不会用错误 fixture 驱动生产代码，同时保留核心清空 delta 防线验证；可扩展性 5/5，因为未来 DDL/schema 映射变化只需更新对应 provider fixture，不影响持久化防线测试。
      edge_cases: table-service.test.ts 不能再声称在该 mock 环境中完整验证 reconstruct；需要通过 table-delta-reconstruct.test.ts 已有真实重建测试和 table-service 的 delta 断言组合覆盖回退风险。sql-table-service.test.ts 必须写清楚 header 由 DDL 导出，避免把 JSON fixture 表头误当 SQLite schema。
      affected_scope_delta: 仅调整 tests/service/table/table-service.test.ts 与 tests/service/table/sql-table-service.test.ts。
  - option_c:
      description: 单独新增一个不 mock chat-message-data-repo 的集成测试文件验证 persist + reconstruct，再保留当前两个失败测试。
      approach_evaluation: 可维护性 3/5，因为能提高端到端覆盖，但当前测试文件 mock 边界仍会失败，必须额外拆文件和配置 mock 隔离；健壮性 4/5，端到端重建验证更强，但会扩大测试复杂度；可扩展性 3/5，未来 mock 隔离维护成本较高。
      edge_cases: Vitest module mock 隔离需要谨慎处理，否则新测试仍可能受到全局 mock 污染；当前失败测试仍需修正，否则无法通过。
      affected_scope_delta: 新增一个测试文件，并仍需修改 tests/service/table/table-service.test.ts 与 tests/service/table/sql-table-service.test.ts。
recommendation: 选择 option_b。三维评分中 option_b 在可维护性、健壮性、可扩展性均为 5/5，且不改变生产代码语义。option_a 是典型为了测试改坏实现，漏洞明显得像是故意写给事故看的；option_c 有价值但当前不是必要条件，因为核心 delta/reconstruct 已有独立测试，当前失败来自 mock/fixture 前提错误，不是缺少端到端文件。
execution_plan_update: 修改原 execution_plan step_3 和 step_4。step_3 调整为：在 tests/service/table/table-service.test.ts 中保留 afterData 缺 sheet 与 header-only 的持久化层回归，直接断言目标消息不会写入 clearSheet/delete-all delta；不在被 mock 的 chat-message-data-repo 环境里用 reconstructTablesFromChatDeltas_ACU 证明回退。step_4 调整为：在 tests/service/table/sql-table-service.test.ts 中把 provider 层断言收口为传参契约，表头按实际 SQLite DDL 导出结果 [['row_id']] 断言，并继续断言 allowClearingTargetSheets 未被设置。
deviation_audit:
  original_plan_excerpt:
    - step_3: 在 tests/service/table/table-service.test.ts 增加持久化层回归：beforeData 有 sheet_0 数据行，afterData 缺 sheet_0 或 header-only，调用 persistTablesToChatMessage_ACU 后写入的 tablePersistenceV2.delta 不应包含 clearSheet/delete-all；reconstructTablesFromChatDeltas_ACU 回放后应保留上一轮行。
    - step_4: 在 tests/service/table/sql-table-service.test.ts 增加 provider 层回归：模拟 saveToChat 收到 afterData header-only/mate-only 的场景时，传给 saveIndependentTableToChatHistory_ACU 的 afterData 不应清空 committed before 中已有真实行，防止 SQLite 导出空壳污染楼层。
  current_proposal: step_3 不再在当前 mock 文件中直接调用 reconstructTablesFromChatDeltas_ACU，而是保留持久化层不写清空 delta 的直接断言；step_4 改为验证 SqlTableService.saveToChat 的 beforeData/afterData/allowClearingTargetSheets 传参契约，使用实际 DDL 导出的 [['row_id']] 表头。
  diff_summary:
    - 删除：table-service.test.ts 中 mock 环境下不可靠的 reconstructTablesFromChatDeltas_ACU 直接断言。
    - 替换：sql-table-service.test.ts 中错误期待 [['row_id','item_name','quantity']]，改为实际 SQLite DDL 导出的 [['row_id']]。
    - 保留：持久化层阻止 clearSheet/delete-all delta、显式 allowClearingTargetSheets 仍允许合法清空、provider 层不显式允许清空的核心验证。
    - 未新增生产文件：不为错误测试修改生产实现。
  deviation_motive_check:
    - 措辞替换规则逐类检查：未命中降级措辞。当前变更不是“简化”，而是纠正错误测试前提，避免用测试反向污染生产语义。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。原方案在 mock 环境中要求 reconstruct 直接验证回退，实际不可成立；修正后以 delta 不落盘清空作为直接证据，结合既有 reconstruct 测试覆盖回放语义，评分不下降。
    - 偏离是否导致 affected_scope 缩小？→ NO。仍覆盖 table-service.test.ts 和 sql-table-service.test.ts；没有删除生产修复范围。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_b 三维均为 5/5，避免错误测试驱动生产语义，又保留核心防线验证。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。新发现的 mock 重建限制与 DDL/schema 不一致都被纳入测试修正。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。选择 option_b 是因为它技术上最准确，不是因为改动少；option_a 的生产改动反而更危险。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。仍覆盖 tests/service/table/table-service.test.ts 与 tests/service/table/sql-table-service.test.ts，生产实现保持当前方案。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。两个失败原因都进入了 context_update 和执行计划修正。
  - options 是否包含至少三个方案？ → YES。包含 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。继续使用 edit_file 修改测试。
  - deviation_audit 是否触发了 self_dissection？ → NO。未触发偷懒判定。
</decision_point>
---
<output_quality_review>
task_summary: 修复第二轮填表后异常空快照落盘导致表格被清空、回退楼层无法恢复上一轮数据的问题。核心改动是在持久化边界为已有真实行的目标表增加异常空 afterData 防线，默认阻止缺表/header-only/mate-only 导出的空快照生成 clearSheet 或 delete-all delta，同时保留显式合法清空能力。
deliverables:
  - src/service/table/table-service.ts：新增 allowClearingTargetSheets 选项与 protectAgainstAccidentalEmptyAfterData_ACU 持久化前保护逻辑，并在 createTableDeltaFromBeforeAfter_ACU 前使用保护后的 afterData。
  - tests/service/table/table-service.test.ts：新增 afterData 缺失目标表、afterData 仅剩表头、显式允许清空三类持久化层回归测试。
  - tests/service/table/sql-table-service.test.ts：新增 replaceCurrentData 收到空壳批次后 saveToChat 传递 beforeData/afterData 且不显式允许清空的 provider 层回归测试。
  - .analysis-cache.md：记录 analysis、两个 decision_point 与本验收报告。

# 量化指标总览
metrics:
  total_files_modified: 4 — 生产代码 1 个、测试文件 2 个、分析缓存 1 个。
  execution_plan_coverage: 6/6 = 100% — step_1/2 已在 table-service.ts 完成；step_3/4 已按 decision_point 修正后完成；step_5 由 table-service 的持久化断言结合既有 table-delta-reconstruct.test.ts 覆盖；step_6 已执行目标测试、typecheck、build、全量测试。
  edge_cases_handled: 8/8 = 100% — mate-only/缺 sheet、header-only、before 无真实行、after 有真实行但少部分行、targetSheetKeys 为空过滤 sheet_、首次初始化、合法清空逃生口、V2 reconstruct 保持 clearSheet 能力均已通过代码边界或既有 delta 测试覆盖。
  confidence_assessment: HIGH — 目标测试 3 个文件 100 个测试通过，npm run typecheck 通过，npm run build 通过且架构护栏 0 违规，npm test 全量 100 个文件 2665 个测试通过。

# 产物实质性检查
substance_check:
  - 产物中是否存在"形式完整但实质空洞"的内容？
    → NO。src/service/table/table-service.ts 的 protectAgainstAccidentalEmptyAfterData_ACU 位于 createTableDeltaFromBeforeAfter_ACU 前，删除它会使 before 有真实行且 after 缺 sheet/header-only 时重新生成 clearSheet/delete-all delta；tests/service/table/table-service.test.ts 的三条新增测试会被击穿；tests/service/table/sql-table-service.test.ts 的新增测试验证 provider 层确实把异常空壳 afterData 与 beforeData 交给持久化防线处理且没有打开 allowClearingTargetSheets。
  - 产物是否能被其目标对象（被测代码/被重构模块/被修复的bug）的变化所"击穿"？
    → YES。若移除 protectAgainstAccidentalEmptyAfterData_ACU，缺 sheet 测试会写入 clearSheet，header-only 测试会写入 delete 行；若把 allowClearingTargetSheets 默认改为 true，前两条保护测试会失败；若去掉显式清空逃生口，合法清空测试会失败；若 SqlTableService.saveToChat 不再传 beforeData 或错误显式允许清空，provider 层测试会失败。
  - 实质性比率: 4/4 = 100%。四个产物都改变系统行为或验证关键行为，没有用 trivial 内容凑数。

# 覆盖完整性检查
completeness_check:
  - 是否存在被跳过的模块/函数/路径？
    → NO。没有修改 SyncBridge 替换语义、delta diff/apply/reconstruct 的 clearSheet 语义，这是刻意保留合法清空能力，不是跳过；持久化边界已覆盖多个上游异常空快照来源。table-service.test.ts 中 mock 环境不再直接调用 reconstructTablesFromChatDeltas_ACU，是 decision_point 中纠正测试前提后的结果；回放语义由既有 table-delta-reconstruct.test.ts 与本次“不写坏 delta”的直接断言组合覆盖。
  - 产物覆盖的范围是否与 execution_plan 中 affected_scope 完全一致？
    → YES。src/service/table/table-service.ts、tests/service/table/table-service.test.ts、tests/service/table/sql-table-service.test.ts、tests/service/table/table-delta-reconstruct.test.ts、.analysis-cache.md 均已纳入验证；其中 table-delta-reconstruct.test.ts 未新增低价值重复用例，但作为目标测试运行通过，符合 step_5 中“若 step_3 已充分覆盖 reconstruct，可将此测试放在 table-service.test.ts 内完成”的约束修正。
  - 核心业务逻辑是否都有直接验证（不依赖间接覆盖）？
    → YES。异常缺 sheet 不生成 clearSheet：tests/service/table/table-service.test.ts；header-only 不生成 delete-all：tests/service/table/table-service.test.ts；显式合法清空仍生成 delete delta：tests/service/table/table-service.test.ts；SqlTableService 空壳导出传参契约：tests/service/table/sql-table-service.test.ts；delta replay 语义不被破坏：tests/service/table/table-delta-reconstruct.test.ts 目标测试通过。
  - affected_scope 覆盖率: 5/5 = 100%。

# 价值密度检查
value_density_check:
  - 产物中高价值内容（验证核心逻辑/处理复杂场景）与低价值内容（验证trivial行为）的比例是多少？
    → 高价值:低价值 = 4:0，高价值占比 100%。新增保护逻辑和三类持久化测试直接覆盖用户报告的数据清空/回退失败链路，provider 测试覆盖 SQLite 空壳导出进入持久化层的边界。
  - 是否存在"用数量掩盖质量"的模式——大量 trivial 产物掩盖了核心逻辑缺少验证的事实？
    → NO。新增测试数量不多，但每条都对应一个事故路径或合法语义边界：缺 sheet、header-only、显式清空、provider 空壳传参。

# 需求对齐检查
alignment_check:
  - 产物满足的是用户的字面需求还是本质需求？
    → 满足本质需求。用户要解决的是“第二轮填表后表格数据直接被清空，回退楼层也不能回到上一次填表的数据”。本次不是只修显示闪烁，而是阻止异常空 afterData 被写成 V2 清空 delta，从源头避免楼层历史被污染；回退/刷新依赖的重建链路因此不会再忠实回放坏 delta。
  - "如果这是别人交给我的，我会接受吗？"
    → YES。理由是生产逻辑集中在持久化边界，未破坏底层合法 clearSheet 能力；显式合法清空有 allowClearingTargetSheets 逃生口；目标测试、类型检查、构建、架构护栏、全量测试全部通过。唯一不算漂亮的是合法清空能力目前依赖调用方显式传参，未来若新增正式“清空表”操作，应把该操作接入 allowClearingTargetSheets，而不是绕过本防线。
</output_quality_review>
