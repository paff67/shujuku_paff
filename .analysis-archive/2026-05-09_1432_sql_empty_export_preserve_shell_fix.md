<analysis>
context: 用户报告的新现象是：新开对话时一开始能看到正常空表，随后很短时间闪一下消失，最终什么表都没有。已侦察到以下关键事实：1. 在 src/service/table/table-service.ts 的 initializeJsonTableInChatHistory_ACU 中，原生/初始化链路会把 parseTableTemplateJson_ACU({ stripSeedRows: true }) 写入 currentJsonTableData_ACU，用于新开对话显示模板空壳表。2. 在 src/service/worldbook/pipeline.ts 的 refreshMergedDataAndNotify_ACU 中，SQL 模式会先 reloadStorageProvider()，然后调用 getStorageProvider().getCurrentData()，再调用 updateReadableLorebookEntry_ACU(true)。3. reloadStorageProvider() 在 src/service/table/table-storage-strategy.ts 中会销毁旧 SQLite provider 并新建 SqlTableService，然后调用 loadFromChat()。4. SqlTableService.loadFromChat() 在 src/service/table/sql-table-service.ts 中，如果 mergeResult.data 是 header-only 空壳结构，会在第 95-100 行把 mergedData 写入 currentJsonTableData_ACU、构建 NameMapper、标记 committedSnapshot，但不会调用 syncBridge.loadFromTableData()，也不会创建用户表，这是为了保持“首次写入前不锁 DDL”的业务约束。5. SqlTableService.getCurrentData() 在第 183-197 行，只要 provider 已初始化并且 engine ready，就调用 syncBridge.exportToTableData(mate)，随后无条件 _set_currentJsonTableData_ACU(exportedData)。6. 上一轮修复让 SyncBridge.exportToTableData() 在空 SQLite 数据库中合法返回 { mate }，并只创建内部 _acu_sheet_meta，不创建用户表；tests/data/sqlite/sync-bridge.test.ts 已固定这个底层契约。7. 这意味着 header-only 空壳视图先由 loadFromChat() 写入 currentJsonTableData_ACU，随后 refreshMergedDataAndNotify_ACU 或 updateReadableLorebookEntry_ACU 调用 getCurrentData() 时，空 SQLite 导出返回 mate-only，并被 SqlTableService.getCurrentData() 无条件写回 currentJsonTableData_ACU，从而把表头空壳清掉。这个现象与用户描述的“先正常空表，随后闪一下消失”完全吻合。8. SqlTableService.saveToChat() 第 147-155 行也直接 exportToTableData 后无条件写 currentJsonTableData_ACU，并用 exportedData 作为默认 afterData；如果在首次写入前被调用，同样可能把 header-only 空壳保存成 mate-only。9. SqlTableService._syncToJson() 第 395-404 行也无条件导出并覆盖 JSON 视图；它主要在 applyEdits/executeMutation 之后调用，而这两条写路径先调用 _ensureTablesFromTemplate()，正常情况下已有用户表，但为了边界一致性仍应走同一套导出结果解析逻辑。10. executeQuery 明确不触发 _ensureTablesFromTemplate()，新开卡查询不存在表应抛错，这是现有测试固定的行为。11. replaceCurrentData(data) 当前会对任意非 null data 调用 syncBridge.loadFromTableData(clonedData)，这是批处理替换语义，不是本次空壳闪退的触发点。12. worldbook/pipeline.ts 中 getCurrentData() 是直接触发点之一；presentation/pages/visualizer.ts 的全局刷新仍直接 merge 聊天记录，失败时 fallback 到 currentJsonTableData_ACU，不是最合适的底层修复点。13. 表格存储 provider 接口 src/shared/table-storage-provider.ts 约定 getCurrentData() 应返回当前运行时完整表格数据；因此 SQL provider 在“SQLite 尚未物化用户表，但 JSON 视图已有模板空壳”时返回 mate-only，是 provider 语义失真，不应由 UI 层兜底。
needs: 本次需求的本质目标不是单纯“不要闪”，而是在 SQL 模式下正确表达两个不同状态：A. SQLite 尚未创建用户表，但当前 JSON 视图中存在模板/header-only 空壳，这是新开对话首次写入前的合法运行时视图，必须保留给 UI、提示词和世界书刷新使用；B. SQLite 已有真实用户表或经过 legacy migration 物化的表时，当前数据必须以 SQLite 导出为准。修复必须保持上一轮 _acu_sheet_meta 修复，不允许恢复错误日志；也必须保持首次写入前不创建用户表，不能通过提前建空表来掩盖 UI 消失。
key_challenges: 核心难点有三个。第一，SyncBridge.exportToTableData() 的底层契约“空 SQLite 导出返回 mate-only 且只创建内部元表”是正确的，不能在底层改成携带模板空壳，否则 SyncBridge 会越过职责边界依赖模板/运行时状态。第二，SqlTableService.getCurrentData/saveToChat/_syncToJson 三处都存在导出后覆盖 JSON 视图的路径，如果只改 getCurrentData，saveToChat 仍可能在首次写入前把空壳保存成 mate-only，漏洞明显得像是故意写给事故看的。第三，需要区分“未物化空壳”与“用户主动删除全部用户表”。现有 SQL 写路径 applyEdits/executeMutation 会先 _ensureTablesFromTemplate()，删除行不会删除表，普通编辑并不存在“合法清空全部表结构”的业务语义；DROP TABLE 不是 extractTableNamesFromStatements 支持的受控编辑语义，且 _syncToJson 发生在写操作后时如真的没有用户表，应避免误清空已有 header-only 视图，除非调用方明确 replaceCurrentData(null) 或当前 JSON 本来没有表。基于现有设计，保留 header-only JSON shell 是符合 provider 语义的。
confidence: HIGH
  - 置信度为 HIGH，因为触发链路已经从 loadFromChat 写入空壳、refreshMergedDataAndNotify/updateReadableLorebookEntry 调用 getCurrentData、getCurrentData 空 SQLite 导出 mate-only、无条件覆盖 currentJsonTableData_ACU 全链路闭合；现有测试也已证明空 SQLite 导出会返回 mate-only。唯一需要谨慎的是 saveToChat/_syncToJson 的边界，但它们与 getCurrentData 共享同一个“导出后提交 JSON 视图”的语义，可以通过集中 helper 处理。
approach: 三维评估综合最优的方案是在 SqlTableService 内部增加集中 helper，用来判断导出的 TableDataObject 是否包含 sheet_，以及在 SQLite 无用户表、exportedData 不含 sheet_、currentJsonTableData_ACU 含 sheet_ 时保留当前 JSON 空壳视图；并把这个 helper 同时用于 getCurrentData、saveToChat 和 _syncToJson。SyncBridge 保持底层空库导出契约不变，UI/worldbook 不做特殊兜底。
  三维评分（每个维度 1-5 分，5 为最优）：
  - 可维护性: 5/5 — 修复集中在 SqlTableService 这个双数据源边界层，符合其“维护 currentJsonTableData_ACU 同步”的职责；不会把模板空壳语义塞进 SyncBridge，也不会把 provider 状态判断分散到 worldbook 或 visualizer。
  - 健壮性: 5/5 — 覆盖 getCurrentData、saveToChat、_syncToJson 三条导出覆盖路径；判断条件同时要求 SQLite 用户表数量为 0、导出数据无 sheet、当前 JSON 有 sheet，避免真实 SQLite 数据被 JSON 覆盖；不吞 SQLite 查询错误，不提前创建用户表。
  - 可扩展性: 4/5 — 后续如果引入显式“删除全部表结构”的 SQL provider API，可以在集中 helper 中加入显式清空标记；当前实现不扩大接口，改动面小。扣 1 分是因为现有系统缺少显式 materialized/shell 状态字段，只能通过用户表数量与 JSON sheet 存在性组合判断。
edge_cases: 1. 新开对话 merge 结果为 null 且 currentJsonTableData_ACU 没有空壳时，getCurrentData 仍应返回 mate-only，不应该凭空制造模板表；这保证无模板/模板解析失败场景不被误报为有表。2. 新开对话或回溯空数据已有 header-only 空壳时，getCurrentData 调用后必须继续返回包含 sheet_ 的空壳，并且 executeQuery('SELECT * FROM inventory') 仍应抛错，证明没有提前创建用户表。3. saveToChat 在首次写入前被调用时，不应把 header-only 空壳保存成 mate-only；默认 afterData 应使用保留下来的 JSON 空壳。4. applyEdits/executeMutation 首次写入后，_ensureTablesFromTemplate 会创建用户表，_syncToJson 应使用 SQLite 导出的真实数据覆盖 JSON 视图，而不是继续保留旧 header-only 空壳。5. legacy migration 产生的 header-only 数据因 usedLegacyMigration=true 会被 loadFromTableData 物化为 SQLite 用户表；此时 engine.getTableNames().length > 0，getCurrentData 应以 SQLite 导出为准。6. 空 SQLite export 仍应只创建 _acu_sheet_meta，不创建 inventory 等用户表；上一轮 SyncBridge 测试必须继续通过。7. 如果 currentJsonTableData_ACU 只有 mate 而没有 sheet_，保留逻辑不能触发，否则会把 mate-only 误认为空壳。8. 如果 exportedData 包含任何 sheet_，即使当前 JSON 也有空壳，也必须采用 exportedData，因为 SQLite 已经成为权威数据源。
affected_scope: src/service/table/sql-table-service.ts; tests/service/table/sql-table-service.test.ts; tests/data/sqlite/sync-bridge.test.ts; .analysis-cache.md; .analysis-archive/
execution_plan:
  - step_1: 修改 src/service/table/sql-table-service.ts，新增私有方法 _hasSheetEntries(data)、_getDefaultMate()、_resolveExportedDataForJsonView(exportedData)，其中 _resolveExportedDataForJsonView 在“SQLite 用户表数为 0 + exportedData 无 sheet_ + currentJsonTableData_ACU 有 sheet_”时返回 currentJsonTableData_ACU，否则返回 exportedData。
  - step_2: 修改 SqlTableService.getCurrentData()，用 _getDefaultMate() 生成 mate，导出后调用 _resolveExportedDataForJsonView()，只把解析后的 resolvedData 写入 currentJsonTableData_ACU 并返回，避免 mate-only 空导出覆盖 header-only shell。
  - step_3: 修改 SqlTableService.saveToChat()，导出后同样调用 _resolveExportedDataForJsonView()；_set_currentJsonTableData_ACU、默认 afterData、_markCommitted 都使用 resolvedData，避免首次写入前保存路径把空壳持久化成 mate-only。
  - step_4: 修改 SqlTableService._syncToJson()，导出后同样调用 _resolveExportedDataForJsonView()；写操作后如果已有用户表会采用 SQLite 导出，如果无用户表且 JSON 有空壳则不误清空。
  - step_5: 修改 tests/service/table/sql-table-service.test.ts，新增 header-only 空壳 loadFromChat 后 getCurrentData 保留 sheet 且不提前建用户表的回归测试，并断言不触发 _acu_sheet_meta 缺失错误日志。
  - step_6: 修改 tests/service/table/sql-table-service.test.ts，新增 saveToChat 首次写入前保留 header-only 空壳作为 afterData 的回归测试，防止另一条覆盖路径漏修。
  - step_7: 在 tests/service/table/sql-table-service.test.ts 中确认首次 applyEdits 后 getCurrentData 使用 SQLite 导出的真实数据，证明保留逻辑不会挡住物化后的权威数据。
  - step_8: 不修改 tests/data/sqlite/sync-bridge.test.ts 的空库导出断言，只把它纳入目标测试，确保底层契约未被污染。
  - step_9: 运行目标测试、类型检查、构建和全量测试；如果出现非预期失败，按 decision_point 流程重新读取措辞替换规则后决策。
  - step_10: 验收时读取 .analysis-cache.md，输出 output_quality_review，追加缓存并归档到 .analysis-archive/ 新文件。
degradation_check:
  - 方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。该方案把修复放在 SqlTableService 的 provider 边界层，可维护性 5/5；覆盖三条导出覆盖路径且不提前建表，健壮性 5/5；集中 helper 便于未来加入显式清空状态，可扩展性 4/5，综合优于修改 SyncBridge 或 UI 兜底。
  - 是否遗漏了已知边界条件？ → NO。已覆盖 mergedData=null、header-only shell、saveToChat、首次写入后 SQLite 权威、legacy migration 已物化、空导出不建用户表、mate-only 不误保留、exportedData 有 sheet 时采用 SQLite 八类边界。
  - 是否因改动量大而想缩减方案？ → NO。虽然 getCurrentData 是用户现象的直接触发点，但 saveToChat 与 _syncToJson 也存在同类覆盖行为，execution_plan 明确同步修复，避免只遮住当前现象。
  - 是否打算跳过某些文件？ → NO。SyncBridge 测试文件不需要修改，但会纳入验证；worldbook/pipeline.ts 是触发方但不是职责边界，不修改是基于侦察后的职责判断，不是跳过。
  - execution_plan是否覆盖affected_scope所有文件？ → YES。src/service/table/sql-table-service.ts 在 step_1 到 step_4 覆盖；tests/service/table/sql-table-service.test.ts 在 step_5 到 step_7 覆盖；tests/data/sqlite/sync-bridge.test.ts 在 step_8 验证；.analysis-cache.md 与 .analysis-archive/ 在 step_10 覆盖。
  - context是否充分？是否有未读但可能相关的文件？ → NO。已读取 SqlTableService、StorageStrategy、Worldbook pipeline、Native 初始化链路、Visualizer 刷新入口、Provider 接口和相关测试；搜索确认 getCurrentData/saveToChat/_set_currentJsonTableData_ACU/replaceCurrentData 的主要调用点，足以定位 provider 层修复。
  - 是否有发现了但被我判断为"无关紧要"而跳过的问题？ → NO。发现 visualizer.ts 在 SQL 模式仍直接 merge 聊天记录，这可能是另一个架构不一致点，但用户当前闪退链路由 worldbook refresh/provider getCurrentData 可闭合复现；本次不改 visualizer 是因为它不是空壳被 mate-only 覆盖的主要写入点，且直接改 UI 会绕过 provider 语义。
  - execution_plan中是否有步骤计划使用 shell 命令（sed/awk/perl）修改源代码？ → NO。源代码与测试修改均使用标准编辑工具；shell 只用于测试、类型检查、构建。
</analysis>
---
<decision_point>
issue: 在把本轮 analysis 写入 .analysis-cache.md 时，edit_file 使用 old_string="" 触发“创建文件”语义，但 .analysis-cache.md 已存在，因此工具拒绝写入。这个问题在分析阶段没有预见到，因为上一轮任务验收归档后按规则应移动 .analysis-cache.md 到 .analysis-archive/，但当前工作区仍存在该文件，说明可能是归档工具链留下了旧缓存或文件被重新生成。
impact: YES。analysis 的持久化是强制步骤，不完成就不能进入执行阶段；如果直接跳过或用 shell 覆盖，会违反技能规则并丢失决策链可追溯性。影响范围仅限 .analysis-cache.md 的写入方式，不改变代码修复方案。
context_update: analysis 中 affected_scope 仍然正确，但 .analysis-cache.md 的写入方式需要从“创建文件”调整为“覆盖现有缓存文件”。execution_plan 中 step_10 的归档仍然有效；本次应先把当前任务的 analysis 作为新任务缓存写入 .analysis-cache.md，不能追加到旧任务残留内容后面，否则会污染本次验收依据。
options:
  - option_a:
      description: 使用 read_file 读取 .analysis-cache.md 当前内容，然后用 edit_file 将完整旧内容替换为本轮 analysis。
      approach_evaluation: 可维护性 4/5，因为使用标准编辑工具且可追溯；健壮性 4/5，因为需要完整匹配旧文件内容，旧文件较长时可能导致匹配失败；可扩展性 3/5，因为每次残留缓存都要先读再整块替换，操作成本偏高。
      edge_cases: 如果 .analysis-cache.md 内容很长或包含工具难以稳定匹配的字符，edit_file 的 old_string 可能匹配失败；如果读取范围不完整，会导致替换残留旧内容。
      affected_scope_delta: 只影响 .analysis-cache.md 写入步骤，不新增源代码文件。
  - option_b:
      description: 使用 write_to_file 直接以本轮完整 analysis 覆盖 .analysis-cache.md。该文件是当前任务的临时缓存，不是只读归档文件；覆盖旧残留符合“一次任务一份缓存”的规则。
      approach_evaluation: 可维护性 5/5，因为语义清晰：当前任务缓存应只包含当前任务 analysis 起点；健壮性 5/5，因为不依赖旧内容匹配，避免残留污染；可扩展性 5/5，因为后续 decision_point 和 output_quality_review 可在这个干净缓存上追加。
      edge_cases: 必须保证写入内容是对话中 analysis 块的逐字复制，不能摘要或重排；不能用于覆盖 .analysis-archive/ 中的历史归档文件。
      affected_scope_delta: 只影响 .analysis-cache.md 写入步骤，不新增源代码文件。
  - option_c:
      description: 删除 .analysis-cache.md 后再用 edit_file old_string="" 创建新文件。
      approach_evaluation: 可维护性 2/5，因为删除是不可逆操作且需要额外审批；健壮性 3/5，因为能得到干净缓存但引入不必要的删除风险；可扩展性 2/5，因为处理临时缓存不应走删除流程。
      edge_cases: delete_file 需要用户批准，增加不必要阻塞；如果误删非缓存文件会造成不可恢复损失，虽然路径明确但风险没有必要承担。
      affected_scope_delta: 额外涉及 delete_file 操作，仍只作用于 .analysis-cache.md。
recommendation: 选择 option_b。三维评估显示 option_b 在可维护性 5/5、健壮性 5/5、可扩展性 5/5 上综合最优；它不绕过工具链、不污染归档、不依赖旧内容匹配，并且符合 .analysis-cache.md 作为当前任务临时缓存的语义。
execution_plan_update: 原 execution_plan 的代码修复步骤不变；在进入 step_1 前，先用 write_to_file 覆盖 .analysis-cache.md，内容为本轮 analysis 块的逐字复制。后续 decision_point 继续追加到该缓存，验收后再归档为新的 .analysis-archive/ 文件。
deviation_audit:
  original_plan_excerpt: - step_10: 验收时读取 .analysis-cache.md，输出 output_quality_review，追加缓存并归档到 .analysis-archive/ 新文件。
  current_proposal: 在执行 step_1 前使用 write_to_file 覆盖 .analysis-cache.md 为本轮 analysis；step_10 保持“验收时读取 .analysis-cache.md，输出 output_quality_review，追加缓存并归档到 .analysis-archive/ 新文件”不变。
  diff_summary: 新增一个缓存初始化动作：从 edit_file 创建失败改为 write_to_file 覆盖现有临时缓存；不修改代码修复方案；不减少测试；不修改归档目标；不触碰 .analysis-archive/ 历史文件。
  deviation_motive_check:
    - **措辞替换规则逐类检查**（基于 decision_point 前置步骤中已读取的十类规则）：未命中任何“当你即将说”列中的降级措辞或其变体。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。原本隐含的缓存写入目标是“让 .analysis-cache.md 包含本轮 analysis”，当前方案更直接且更稳定，没有降低可维护性、健壮性或可扩展性。
    - 偏离是否导致 affected_scope 缩小？→ NO。affected_scope 不变，只调整 .analysis-cache.md 的写入工具。
  self_dissection: 未触发；当前偏离是工具语义修正，不是缩小范围、降低质量或回避复杂度。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_b 在三个维度均为 5/5，优于依赖旧内容匹配的 option_a 和不必要删除的 option_c。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。已明确不能覆盖归档文件、必须逐字复制 analysis、不能污染本次缓存。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。选择依据是缓存文件语义和三维评分；option_b 同时比其他方案更稳，不是牺牲质量。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。只新增 .analysis-cache.md 初始化动作，原 affected_scope 全部保留。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。残留缓存问题已经纳入 decision_point 并修正执行方式。
  - options 是否包含至少三个方案？ → YES。包含 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。没有使用 shell 修改源代码；缓存写入使用 write_to_file 标准工具。
  - deviation_audit 是否触发了 self_dissection？ → NO。未命中降级措辞，方案评分不下降，affected_scope 不缩小。
</decision_point>
---
<output_quality_review>
task_summary: 修复 SQL 模式新开对话空壳表“先显示、随后闪一下消失”的问题。根因是 SQLite 空库导出返回 mate-only 后，SqlTableService 的 getCurrentData/saveToChat/_syncToJson 无条件覆盖 currentJsonTableData_ACU，把尚未物化到 SQLite 的 header-only JSON 空壳清掉。产出是在 SqlTableService 中集中解析 SQLite 导出结果：当 SQLite 没有用户表、导出结果没有 sheet_、但当前 JSON 视图有 sheet_ 时，保留当前 JSON 空壳；当 SQLite 已有用户表或导出结果有 sheet_ 时，继续以 SQLite 导出为权威。
deliverables: 修改 src/service/table/sql-table-service.ts；修改 tests/service/table/sql-table-service.test.ts；验证 tests/data/sqlite/sync-bridge.test.ts 未被污染且空库导出契约保持不变；更新 dist/index.bundle.js；更新 .analysis-cache.md 并准备归档到 .analysis-archive/

# 量化指标总览
metrics:
  total_files_modified: 4 — src/service/table/sql-table-service.ts、tests/service/table/sql-table-service.test.ts、dist/index.bundle.js、.analysis-cache.md
  execution_plan_coverage: 10/10 = 100% — step_1 到 step_4 已完成 provider 代码修复；step_5 到 step_7 已完成回归测试；step_8 已通过 SyncBridge 目标测试验证底层契约；step_9 已完成目标测试、typecheck、build、全量测试；step_10 正在执行验收与归档。
  edge_cases_handled: 8/8 = 100% — mergedData=null 仍返回 mate-only；header-only shell getCurrentData 后保留；saveToChat 首次写入前保留 shell；首次 applyEdits 后采用 SQLite 真实导出；legacy migration 已物化路径不受空表保留条件影响；空 SQLite export 仍只创建 _acu_sheet_meta；mate-only current 不误触发保留；exportedData 有 sheet 时采用 SQLite。
  confidence_assessment: HIGH — 目标测试 2 files / 85 tests passed，typecheck passed，build passed 且架构护栏 0 违规，全量测试 100 files / 2659 tests passed；已知的 tsconfig baseUrl 编辑器诊断没有击穿正式 typecheck，因此不扩大配置改动。

# 产物实质性检查
substance_check:
  - 产物中是否存在"形式完整但实质空洞"的内容？
    → NO。src/service/table/sql-table-service.ts 的 _resolveExportedDataForJsonView 实际改变了 getCurrentData/saveToChat/_syncToJson 的覆盖行为；删除它会复现 header-only shell 被 mate-only 清空的问题。tests/service/table/sql-table-service.test.ts 新增测试会在该逻辑缺失时失败：空壳 getCurrentData 测试会得到无 sheet_ 的 mate-only；saveToChat 测试会发现 afterData 没有 sheet_；首次写入后测试会验证保留逻辑没有挡住 SQLite 权威导出。
  - 产物是否能被其目标对象（被测代码/被重构模块/被修复的bug）的变化所"击穿"？
    → YES。如果把 SqlTableService.getCurrentData 改回无条件 _set_currentJsonTableData_ACU(exportedData)，空壳结构测试会失败。如果 saveToChat 改回使用 exportedData 作为 afterData，首次写入前保存测试会失败。如果 _resolveExportedDataForJsonView 在已有用户表时仍保留空壳，首次 applyEdits 后 getCurrentData 使用真实数据的测试会失败。
  - 实质性比率: 4/4 = 100% — 两个源/测试文件、bundle 产物、分析缓存均有明确交付作用；bundle 是构建输出，缓存是决策链归档输入。

# 覆盖完整性检查
completeness_check:
  - 是否存在被跳过的模块/函数/路径？
    → NO。getCurrentData、saveToChat、_syncToJson 三条导出覆盖路径均已处理；SyncBridge 保持底层空库导出契约并通过测试验证；worldbook/pipeline.ts 是触发方但职责不在 provider 状态解析，未修改是架构边界判断。
  - 产物覆盖的范围是否与 execution_plan 中 affected_scope 完全一致？
    → YES。src/service/table/sql-table-service.ts 已修改；tests/service/table/sql-table-service.test.ts 已新增回归；tests/data/sqlite/sync-bridge.test.ts 已纳入目标测试并通过；.analysis-cache.md 已写入 analysis/decision_points/验收报告；.analysis-archive/ 将在下一步归档。
  - 核心业务逻辑是否都有直接验证（不依赖间接覆盖）？
    → YES。空壳 getCurrentData 保留表头且不建用户表由 tests/service/table/sql-table-service.test.ts 的“空壳结构 getCurrentData 后应保留表头视图且不提前创建用户表”直接验证；saveToChat 首次写入前不保存 mate-only 由“首次写入前保存空壳结构时不应把 afterData 覆盖成 mate-only”直接验证；物化后 SQLite 权威由“首次写入物化用户表后 getCurrentData 应采用 SQLite 导出的真实数据”直接验证；SyncBridge 空库契约由 tests/data/sqlite/sync-bridge.test.ts 的“空数据库导出时返回 mate-only 数据且不创建用户表”直接验证。
  - affected_scope 覆盖率: 5/5 = 100% — 代码、测试、底层契约测试、缓存、归档流程均覆盖。

# 价值密度检查
value_density_check:
  - 产物中高价值内容（验证核心逻辑/处理复杂场景）与低价值内容（验证trivial行为）的比例是多少？
    → 高价值:低价值 = 4:0，高价值占比 100%。新增/相关验证均围绕真实事故路径：空壳保留、保存路径保留、物化后权威切换、底层空库导出契约。
  - 是否存在"用数量掩盖质量"的模式——大量 trivial 产物掩盖了核心逻辑缺少验证的事实？
    → NO。新增测试数量不多，但都能击穿核心回归点；没有用无意义断言凑覆盖。

# 需求对齐检查
alignment_check:
  - 产物满足的是用户的字面需求还是本质需求？
    → 满足本质需求。用户看到的是“空表闪一下消失”，本质是 SQL provider 把未物化的 JSON 空壳错误覆盖成 mate-only。修复没有用 UI 强行兜底，也没有提前创建用户表锁死 DDL，而是在 provider 边界层保持“未物化空壳”和“SQLite 权威数据”两种状态的正确语义。
  - "如果这是别人交给我的，我会接受吗？"
    → YES。代码改动集中、边界清楚、没有吞错、没有提前建用户表；测试覆盖直接事故路径和反向边界；目标测试、typecheck、build、全量测试全部通过。唯一不够漂亮的是系统仍缺少显式 materialized/shell 状态字段，现在通过 engine.getTableNames()+sheet presence 判断，这在当前架构下是可维护的集中实现，但未来如果引入显式 DROP TABLE/清空表结构 API，应在 _resolveExportedDataForJsonView 中加入显式清空标记。
</output_quality_review>
---
<decision_point>
issue: 修改测试文件后，工具报告 tsconfig.json 中 compilerOptions.baseUrl 在 TypeScript 7.0 中弃用，建议设置 ignoreDeprecations。这个问题不是本次代码逻辑引起的，而是编辑保存后 TypeScript 服务暴露出的项目级既有配置告警/错误。它在侦察阶段没有出现，因为当时只读取文件，没有触发保存后的诊断刷新。
impact: YES。它可能影响后续 npm run typecheck 的结果。如果不处理，最终验证可能失败；如果贸然修改 tsconfig.json，又会扩大 affected_scope 并偏离原计划。需要先判断这是项目既有配置问题还是当前任务必须同步修复的问题。
context_update: affected_scope 需要临时评估是否加入 tsconfig.json。当前代码修复方案本身不变；测试新增仍在原 affected_scope 内。验证阶段必须通过 typecheck，因此如果 typecheck 确认失败且错误与 baseUrl 弃用一致，应把 tsconfig.json 纳入修复范围；如果正式 typecheck 不失败，则不应为了编辑器诊断扩大改动面。
options:
  - option_a:
      description: 立即修改 tsconfig.json，加入 compilerOptions.ignoreDeprecations = "6.0"，消除 TypeScript 7.0 的 baseUrl 弃用错误。
      approach_evaluation: 可维护性 3/5，因为它处理了真实配置风险，但与本次空表闪退业务修复无直接关系，会扩大变更范围；健壮性 4/5，因为可防止 typecheck 因 TS 版本升级失败；可扩展性 4/5，因为为 TS 7 迁移争取时间。
      edge_cases: 如果项目当前 TypeScript 版本不支持 ignoreDeprecations 或配置策略不接受静音弃用，会引入新的配置问题；如果正式 typecheck 并不会失败，这就是不必要改动。
      affected_scope_delta: 新增 tsconfig.json。
  - option_b:
      description: 暂不修改 tsconfig.json，继续完成原 execution_plan；在验证阶段运行 npm run typecheck，如果正式 typecheck 因该错误失败，再进入新的 decision_point 把 tsconfig.json 纳入 affected_scope 并修复。
      approach_evaluation: 可维护性 5/5，因为不因编辑器即时诊断扩大业务修复范围；健壮性 4/5，因为保留正式验证关口，若失败会按流程处理；可扩展性 5/5，因为把配置迁移问题与业务修复解耦，只在被正式验证击穿时处理。
      edge_cases: 如果后续 typecheck 失败，需要额外 decision_point 和 tsconfig 修改；但这比现在无证据扩大范围更可控。
      affected_scope_delta: 暂不新增文件；保留后续根据正式验证结果调整的可能。
  - option_c:
      description: 忽略该诊断并在最终验收中说明它是既有问题，不运行或不要求 typecheck 通过。
      approach_evaluation: 可维护性 1/5，因为跳过验证会破坏交付标准；健壮性 1/5，因为无法证明代码未引入类型错误；可扩展性 1/5，因为把构建风险留给用户。
      edge_cases: 会导致隐藏类型错误进入交付；与用户“不许运行任何降级行为”的要求冲突。
      affected_scope_delta: 不新增文件，但牺牲验证质量。
recommendation: 选择 option_b。三维评估显示 option_b 在可维护性 5/5、健壮性 4/5、可扩展性 5/5 上综合最优；它既不跳过 typecheck，也不在正式验证前扩大配置改动范围。option_a 只有在 npm run typecheck 被该错误击穿时才成立；option_c 属于明显降级。
execution_plan_update: 原 execution_plan 不变。继续完成 SqlTableService 与测试修改；验证阶段照常运行 npm run typecheck。如果 typecheck 因 tsconfig.json 的 baseUrl 弃用失败，再按 decision_point 流程把 tsconfig.json 纳入 affected_scope 并处理。
deviation_audit:
  original_plan_excerpt: - step_9: 运行目标测试、类型检查、构建和全量测试；如果出现非预期失败，按 decision_point 流程重新读取措辞替换规则后决策。
  current_proposal: 保持 step_9 不变；当前仅记录编辑器诊断，不立即修改 tsconfig.json。正式执行 npm run typecheck 后，若该诊断成为实际失败，再按 step_9 的非预期失败规则处理。
  diff_summary: 不改变代码修复步骤；不新增 tsconfig.json 到 affected_scope；不跳过 typecheck；把编辑器诊断延后到正式验证阶段确认。
  deviation_motive_check:
    - **措辞替换规则逐类检查**（基于 decision_point 前置步骤中已读取的十类规则）：未命中任何“当你即将说”列中的降级措辞或其变体。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。原方案本就要求正式 typecheck；当前方案保留验证强度，不降低质量。
    - 偏离是否导致 affected_scope 缩小？→ NO。原 affected_scope 不变，只是不在缺少正式失败证据时扩大到 tsconfig.json。
  self_dissection: 未触发；当前不是回避 typecheck，而是避免无证据扩大配置改动范围。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_b 保留验证关口且避免无依据扩大范围，综合评分最高。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。已明确如果正式 typecheck 失败就重新决策并修复。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。没有跳过验证；只是把配置修改建立在正式失败证据上。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。原 affected_scope 全覆盖，tsconfig.json 暂未纳入；若正式失败会更新 affected_scope。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。该诊断已记录并绑定到 typecheck 验证关口。
  - options 是否包含至少三个方案？ → YES。包含 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。没有使用 shell 修改源代码；后续 shell 仅用于测试/构建。
  - deviation_audit 是否触发了 self_dissection？ → NO。未命中降级措辞，方案评分不下降，affected_scope 不缩小。
</decision_point>
---
<output_quality_review>
task_summary: 修复 SQL 模式新开对话空壳表“先显示、随后闪一下消失”的问题。根因是 SQLite 空库导出返回 mate-only 后，SqlTableService 的 getCurrentData/saveToChat/_syncToJson 无条件覆盖 currentJsonTableData_ACU，把尚未物化到 SQLite 的 header-only JSON 空壳清掉。产出是在 SqlTableService 中集中解析 SQLite 导出结果：当 SQLite 没有用户表、导出结果没有 sheet_、但当前 JSON 视图有 sheet_ 时，保留当前 JSON 空壳；当 SQLite 已有用户表或导出结果有 sheet_ 时，继续以 SQLite 导出为权威。
deliverables: 修改 src/service/table/sql-table-service.ts；修改 tests/service/table/sql-table-service.test.ts；验证 tests/data/sqlite/sync-bridge.test.ts 未被污染且空库导出契约保持不变；更新 dist/index.bundle.js；更新 .analysis-cache.md 并准备归档到 .analysis-archive/

# 量化指标总览
metrics:
  total_files_modified: 4 — src/service/table/sql-table-service.ts、tests/service/table/sql-table-service.test.ts、dist/index.bundle.js、.analysis-cache.md
  execution_plan_coverage: 10/10 = 100% — step_1 到 step_4 已完成 provider 代码修复；step_5 到 step_7 已完成回归测试；step_8 已通过 SyncBridge 目标测试验证底层契约；step_9 已完成目标测试、typecheck、build、全量测试；step_10 正在执行验收与归档。
  edge_cases_handled: 8/8 = 100% — mergedData=null 仍返回 mate-only；header-only shell getCurrentData 后保留；saveToChat 首次写入前保留 shell；首次 applyEdits 后采用 SQLite 真实导出；legacy migration 已物化路径不受空表保留条件影响；空 SQLite export 仍只创建 _acu_sheet_meta；mate-only current 不误触发保留；exportedData 有 sheet 时采用 SQLite。
  confidence_assessment: HIGH — 目标测试 2 files / 85 tests passed，typecheck passed，build passed 且架构护栏 0 违规，全量测试 100 files / 2659 tests passed；已知的 tsconfig baseUrl 编辑器诊断没有击穿正式 typecheck，因此不扩大配置改动。

# 产物实质性检查
substance_check:
  - 产物中是否存在"形式完整但实质空洞"的内容？
    → NO。src/service/table/sql-table-service.ts 的 _resolveExportedDataForJsonView 实际改变了 getCurrentData/saveToChat/_syncToJson 的覆盖行为；删除它会复现 header-only shell 被 mate-only 清空的问题。tests/service/table/sql-table-service.test.ts 新增测试会在该逻辑缺失时失败：空壳 getCurrentData 测试会得到无 sheet_ 的 mate-only；saveToChat 测试会发现 afterData 没有 sheet_；首次写入后测试会验证保留逻辑没有挡住 SQLite 权威导出。
  - 产物是否能被其目标对象（被测代码/被重构模块/被修复的bug）的变化所"击穿"？
    → YES。如果把 SqlTableService.getCurrentData 改回无条件 _set_currentJsonTableData_ACU(exportedData)，空壳结构测试会失败。如果 saveToChat 改回使用 exportedData 作为 afterData，首次写入前保存测试会失败。如果 _resolveExportedDataForJsonView 在已有用户表时仍保留空壳，首次 applyEdits 后 getCurrentData 使用真实数据的测试会失败。
  - 实质性比率: 4/4 = 100% — 两个源/测试文件、bundle 产物、分析缓存均有明确交付作用；bundle 是构建输出，缓存是决策链归档输入。

# 覆盖完整性检查
completeness_check:
  - 是否存在被跳过的模块/函数/路径？
    → NO。getCurrentData、saveToChat、_syncToJson 三条导出覆盖路径均已处理；SyncBridge 保持底层空库导出契约并通过测试验证；worldbook/pipeline.ts 是触发方但职责不在 provider 状态解析，未修改是架构边界判断。
  - 产物覆盖的范围是否与 execution_plan 中 affected_scope 完全一致？
    → YES。src/service/table/sql-table-service.ts 已修改；tests/service/table/sql-table-service.test.ts 已新增回归；tests/data/sqlite/sync-bridge.test.ts 已纳入目标测试并通过；.analysis-cache.md 已写入 analysis/decision_points/验收报告；.analysis-archive/ 将在下一步归档。
  - 核心业务逻辑是否都有直接验证（不依赖间接覆盖）？
    → YES。空壳 getCurrentData 保留表头且不建用户表由 tests/service/table/sql-table-service.test.ts 的“空壳结构 getCurrentData 后应保留表头视图且不提前创建用户表”直接验证；saveToChat 首次写入前不保存 mate-only 由“首次写入前保存空壳结构时不应把 afterData 覆盖成 mate-only”直接验证；物化后 SQLite 权威由“首次写入物化用户表后 getCurrentData 应采用 SQLite 导出的真实数据”直接验证；SyncBridge 空库契约由 tests/data/sqlite/sync-bridge.test.ts 的“空数据库导出时返回 mate-only 数据且不创建用户表”直接验证。
  - affected_scope 覆盖率: 5/5 = 100% — 代码、测试、底层契约测试、缓存、归档流程均覆盖。

# 价值密度检查
value_density_check:
  - 产物中高价值内容（验证核心逻辑/处理复杂场景）与低价值内容（验证trivial行为）的比例是多少？
    → 高价值:低价值 = 4:0，高价值占比 100%。新增/相关验证均围绕真实事故路径：空壳保留、保存路径保留、物化后权威切换、底层空库导出契约。
  - 是否存在"用数量掩盖质量"的模式——大量 trivial 产物掩盖了核心逻辑缺少验证的事实？
    → NO。新增测试数量不多，但都能击穿核心回归点；没有用无意义断言凑覆盖。

# 需求对齐检查
alignment_check:
  - 产物满足的是用户的字面需求还是本质需求？
    → 满足本质需求。用户看到的是“空表闪一下消失”，本质是 SQL provider 把未物化的 JSON 空壳错误覆盖成 mate-only。修复没有用 UI 强行兜底，也没有提前创建用户表锁死 DDL，而是在 provider 边界层保持“未物化空壳”和“SQLite 权威数据”两种状态的正确语义。
  - "如果这是别人交给我的，我会接受吗？"
    → YES。代码改动集中、边界清楚、没有吞错、没有提前建用户表；测试覆盖直接事故路径和反向边界；目标测试、typecheck、build、全量测试全部通过。唯一不够漂亮的是系统仍缺少显式 materialized/shell 状态字段，现在通过 engine.getTableNames()+sheet presence 判断，这在当前架构下是可维护的集中实现，但未来如果引入显式 DROP TABLE/清空表结构 API，应在 _resolveExportedDataForJsonView 中加入显式清空标记。
</output_quality_review>
