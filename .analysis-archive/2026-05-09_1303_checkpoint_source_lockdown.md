<analysis>
context:
  - [`buildLegacyCheckpointFromChat_ACU()`](src/service/table/table-delta-migration.ts:92) 当前从后往前扫描 legacy snapshot，生成 `source: 'legacy-migration'` 的 checkpoint，并把 `checkpointMessageIndex` 设为发现 legacy 数据的那条消息索引；随后 [`migrateLegacyCheckpointToMessage_ACU()`](src/service/table/table-delta-migration.ts:172) 会把 checkpoint 写回这条 legacy 消息，而不是首个 AI 消息。
  - [`reconstructTablesFromChatDeltas_ACU()`](src/service/table/table-delta-reconstruct.ts:36) 当前读取顺序是先正序扫描 V2 checkpoint/delta；如果没有任何 V2 checkpoint 且允许 legacy migration，则调用 [`buildLegacyCheckpointFromChat_ACU()`](src/service/table/table-delta-migration.ts:92) 从 legacy 构造 checkpoint，并可通过 [`migrateLegacyCheckpointToMessage_ACU()`](src/service/table/table-delta-migration.ts:172) 写回。它的长期目标已经接近“checkpoint + delta”，但迁移落点不是首楼。
  - [`rollupCheckpointBeforePurge_ACU()`](src/service/table/table-delta-retention.ts:138) 是 retention 专用逻辑，只在 `dataMessageIndices.length > retainCount` 时把边界前状态 rollup 到保留边界消息；它不适合作为“新对话/legacy 首楼锚点 checkpoint”的入口。
  - [`processUpdatesBatch_ACU()`](src/service/table/update-orchestrator.ts:510) 在批处理填表前调用 [`loadBatchBaseData_ACU()`](src/service/table/update-orchestrator.ts) 重建历史基底，是触发“确保首楼 checkpoint 已存在”的候选入口之一；但如果只放这里，加载世界书或编辑器时未必先经过填表，因此更底层的重建逻辑也需要保证 legacy 首次迁移后形成稳定 V2 锚点。
  - 现有测试 [`tests/service/table/table-delta-reconstruct.test.ts`](tests/service/table/table-delta-reconstruct.test.ts) 已覆盖“无 V2 但存在 legacy 快照时懒迁移为 checkpoint 并写回消息”，但断言目前接受写回 legacy 原消息。用户新要求会改变该语义：legacy snapshot 应转换为首个可写 AI 消息上的 checkpoint。
needs:
  - 将读取源头锁死为“首个 checkpoint + 后续 delta”。legacy snapshot 只能作为一次性迁移输入，不能作为长期读取源，也不能在每次重建中继续扮演并行来源。
  - legacy snapshot 存在时，应构造 checkpoint 并写入首个可写 AI 消息；如果首个 AI 消息早于 legacy 数据所在消息，必须保证重建不会错误地把“未来 legacy 快照”当成首楼时点的历史状态污染中间 delta。
  - 新开对话无 legacy、无 V2 时，可基于模板写 `source: 'template-initialization'` 的 header-only checkpoint 到首个可写 AI 消息，但这需要额外侦察模板基底生成与首次初始化入口；不能和 legacy 迁移混成一个粗暴逻辑。
key_challenges:
  - “把 legacy snapshot 扔到首楼”存在时间语义风险：如果 legacy snapshot 出现在第 10 楼，把它写成第 1 楼 checkpoint，再回放第 2-9 楼 delta，可能把第 10 楼快照错误提前。必须明确旧 legacy snapshot 的含义是“当前完整快照”还是“该消息时点快照”。现有 [`buildLegacyCheckpointFromChat_ACU()`](src/service/table/table-delta-migration.ts:92) 是从后往前取最新 sheet，语义更接近边界前最新快照，不天然适合作为首楼时点。
  - 如果要强制首楼 checkpoint，正确做法不是改变 checkpoint 的 `messageIndexHint` 假装它属于首楼，而是需要选择首个 AI 消息作为存储载体，同时在 reconstruct 时把它作为链路锚点，并确保后续 delta 回放范围不会重复或错序。
  - 迁移后是否清理 legacy 字段必须谨慎。只写首楼 checkpoint 不清 legacy，仍可能让其它旧路径读 legacy；清 legacy 又可能破坏未迁移 isolation 或其它功能。因此清理策略要限定当前 isolation，并复用 [`clearCurrentIsolationLegacyTableSnapshots_ACU()`](src/service/table/table-delta-repository.ts:60) 或类似逻辑。
  - 模板初始化 checkpoint 和 legacy migration checkpoint 是两种不同来源：前者是空结构锚点，后者是已有数据快照。混在一个函数里会让边界条件变脏。
confidence: MEDIUM
  - 已确认当前 legacy migration 的落点和重建链路，能判断用户要求的架构方向正确。
  - 仍有一个关键未验证点：旧 legacy snapshot 在真实聊天中的时间语义是否总是“最新完整快照”。如果是，则写到首楼作为读取源头会改变历史时间线但能统一读取源；如果不是，必须改成“最早 legacy 数据消息 checkpoint + 后续 delta”。该点需要通过现有保存逻辑和旧数据格式来源进一步侦察后再动代码。
approach:
  三维评估综合最优的方案是：把需求拆成两层实现。第一层先重构 legacy migration，使 legacy 只作为一次性输入，并在迁移成功后形成一个稳定 V2 checkpoint 锚点；是否写到首个 AI 消息，需要在保存逻辑确认 legacy snapshot 是完整当前快照后执行。第二层新增模板初始化 checkpoint，只在无 V2、无 legacy 且有模板基底时写首个 AI 消息。重建函数最终应优先且稳定地从 V2 checkpoint + delta 读取，legacy fallback 只允许在迁移阶段触发一次。
  三维评分（每个维度 1-5 分，5 为最优）：
  - 可维护性: 4/5 — 将 legacy migration、template initialization、retention rollup 三种 checkpoint 来源分开，职责清楚，不把初始化逻辑塞进 retention。
  - 健壮性: 4/5 — 能覆盖已有 V2 不重复迁移、legacy 一次性迁移、无 AI 消息不写、模板空 checkpoint 不覆盖 provider 等边界；但需要进一步确认 legacy 时间语义。
  - 可扩展性: 4/5 — 后续新增 checkpoint source 或迁移策略时，可以在 migration/initialization 层扩展，不破坏 reconstruct 的主链路。
edge_cases:
  - chat 没有任何 AI 消息：不能写 checkpoint，必须返回无变更。
  - 已有 V2 checkpoint：不得再从 legacy 生成首楼 checkpoint，防止污染 V2 链。
  - 只有 V2 delta 没有 checkpoint：需要 legacy baseline 或模板 baseline，否则 delta 没有可靠基底。
  - legacy snapshot 出现在非首个 AI 消息：必须确认是否允许存储载体前移到首个 AI 消息，以及后续 delta 的回放起点如何计算。
  - 多 isolation 并存：只迁移当前 isolationKey，不能清理其它 isolation 的 legacy/isolated 数据。
  - 模板初始化 checkpoint 是 header-only：不得同步覆盖 SQL provider 当前真实数据。
affected_scope:
  - [`src/service/table/table-delta-migration.ts`](src/service/table/table-delta-migration.ts)
  - [`src/service/table/table-delta-reconstruct.ts`](src/service/table/table-delta-reconstruct.ts)
  - [`src/service/table/table-delta-repository.ts`](src/service/table/table-delta-repository.ts)
  - [`src/service/table/update-orchestrator.ts`](src/service/table/update-orchestrator.ts)
  - [`tests/service/table/table-delta-reconstruct.test.ts`](tests/service/table/table-delta-reconstruct.test.ts)
  - [`tests/service/table/table-delta-retention.test.ts`](tests/service/table/table-delta-retention.test.ts)
  - 后续可能新增模板初始化相关测试文件，具体需继续侦察模板入口。
execution_plan:
  - step_1: 继续侦察保存逻辑和旧 legacy snapshot 产生逻辑，确认 legacy snapshot 是否代表“当前完整快照”，并搜索 [`migrateLegacyCheckpointToMessage_ACU()`](src/service/table/table-delta-migration.ts:172)、[`buildLegacyCheckpointFromChat_ACU()`](src/service/table/table-delta-migration.ts:92) 的所有调用方。
  - step_2: 基于确认结果设计 legacy 首楼 checkpoint 写入策略：新增可指定 checkpoint 存储目标消息的迁移函数，避免把 checkpoint 写回 legacy 原消息；必要时在 checkpoint source 中区分 `legacy-root-migration`。
  - step_3: 修改 [`reconstructTablesFromChatDeltas_ACU()`](src/service/table/table-delta-reconstruct.ts:36)，让 legacy fallback 成功后写入首个可写 AI 消息，并确保后续 delta 回放范围不重复、不跳过、不提前污染。
  - step_4: 新增或调整测试：legacy 在第二条 AI 消息但 checkpoint 写到第一条 AI 消息；已有 V2 checkpoint 不迁移；无 AI 消息不写；delta-only 链路迁移后重建结果一致。
  - step_5: 单独设计模板初始化 checkpoint 入口，确认模板基底来源后再实现；不得把它塞进 retention。
  - step_6: 运行目标测试、类型检查、构建、全量测试并归档。
degradation_check:
  - 方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。它把 legacy migration、模板初始化、retention rollup 分层处理，避免用一个粗暴 checkpoint 写入逻辑污染所有场景。
  - 是否遗漏了已知边界条件？ → NO。已列出无 AI、已有 V2、delta-only、非首楼 legacy、多 isolation、模板空 checkpoint 不覆盖 provider 等边界。
  - 是否因改动量大而想缩减方案？ → NO。不会只改测试或只改 checkpoint 写入位置；会先确认时间语义再修改迁移链路。
  - 是否打算跳过某些文件？ → NO。需要继续搜索调用方和保存逻辑，不能凭当前几段代码直接改。
  - execution_plan是否覆盖affected_scope所有文件？ → YES。已覆盖 migration、reconstruct、repository、orchestrator 和相关测试；模板初始化入口待进一步侦察后补充。
  - context是否充分？是否有未读但可能相关的文件？ → YES。仍需要补充读取保存逻辑和调用方搜索；因此当前不直接动代码。没看清就改持久化层，那不是实现，是给未来事故埋雷。
  - 是否有发现了但被我判断为"无关紧要"而跳过的问题？ → NO。legacy 时间语义风险已明确列为关键挑战，不会跳过。
  - execution_plan中是否有步骤计划使用 shell 命令（sed/awk/perl）修改源代码？ → NO。源代码修改将使用编辑工具；shell 只用于搜索验证、测试、构建。
</analysis>
---
<decision_point>
issue: 继续侦察后发现项目里已经存在 [`template-seed`](src/shared/models/table-persistence-v2.ts:6) checkpoint 机制，并且 [`seedGreetingLocalDataFromTemplate_ACU()`](src/service/runtime/helpers-data-merge.ts:372) 已经会在新对话开场白阶段把模板基底写入首个 AI 消息的 [`tablePersistenceV2`](src/service/table/table-delta-repository.ts:50)。原 analysis 中把模板初始化列为“新增机制”不准确；真正问题不是没有模板 checkpoint，而是该函数还同时写入 [`independentData`](src/service/runtime/helpers-data-merge.ts:403)，造成新 V2 checkpoint 与旧式 snapshot 双轨并存。
impact: YES。影响 execution_plan 中 step_5。模板初始化不应从零设计新 source，而应收束已有 [`template-seed`](src/shared/models/table-persistence-v2.ts:6) 机制：保留 checkpoint 写入，移除不必要的 legacy-style independentData 写入，避免用户要求的“读取源头锁死为 checkpoint + delta”被新对话模板种子破坏。
context_update: analysis 的 context 需要补充：[`seedGreetingLocalDataFromTemplate_ACU()`](src/service/runtime/helpers-data-merge.ts:372) 已经执行首楼模板 checkpoint 写入；key_challenges 需要新增“双轨残留”风险；execution_plan 的 step_5 从“设计并实现新对话模板初始化 checkpoint”改为“复用并收束既有 template-seed checkpoint，禁止同时写 legacy-style independentData”。
options:
  - option_a:
      description: 保留现有 [`template-seed`](src/shared/models/table-persistence-v2.ts:6) checkpoint 写入，只删除 [`seedGreetingLocalDataFromTemplate_ACU()`](src/service/runtime/helpers-data-merge.ts:372) 中对 `tagData.independentData` 的模板基底写入，让新对话模板基底只通过 checkpoint 存储。
      approach_evaluation: 可维护性 5/5，复用已有 checkpoint source 和写入函数；健壮性 4/5，减少双轨来源，但需要确认依赖 independentData 的旧读取测试；可扩展性 5/5，未来模板初始化继续沿 V2 checkpoint 扩展。
      edge_cases: 已有 `_acu_base_state` 标记仍保留在 tagData；如果某处只检查 independentData 判断有数据，行为会改变，需测试覆盖。
      affected_scope_delta: 修改 [`src/service/runtime/helpers-data-merge.ts`](src/service/runtime/helpers-data-merge.ts) 和相关测试。
  - option_b:
      description: 新增 `template-initialization` checkpoint source，保留旧 [`template-seed`](src/shared/models/table-persistence-v2.ts:6) 逻辑不动。
      approach_evaluation: 可维护性 2/5，引入两个语义接近的模板 checkpoint source；健壮性 2/5，双轨 independentData 仍存在；可扩展性 2/5，后续需要维护两套模板初始化路径。
      edge_cases: 新旧 source 并存导致重建与测试断言混乱。
      affected_scope_delta: 修改类型、初始化逻辑、测试，且仍需额外清理旧逻辑。
  - option_c:
      description: 完全移除 [`seedGreetingLocalDataFromTemplate_ACU()`](src/service/runtime/helpers-data-merge.ts:372)，改由填表前统一初始化 checkpoint。
      approach_evaluation: 可维护性 3/5，入口更统一但会改变新对话开场白阶段已有行为；健壮性 2/5，世界书/编辑器在首次填表前可能仍无锚点；可扩展性 3/5，依赖填表入口，不适合加载期场景。
      edge_cases: 新对话未触发填表时没有 checkpoint；世界书清理时机可能回归。
      affected_scope_delta: 修改 runtime merge、table service、worldbook 初始化链，影响面更大。
recommendation: 选择 option_a。三维评估显示 option_a 在可维护性和可扩展性上最高，并且直接消除双轨残留；option_b 保留问题本体，option_c 改变开场白阶段行为，回归风险更高。
execution_plan_update: 原 step_5 改为：复用现有 [`template-seed`](src/shared/models/table-persistence-v2.ts:6) checkpoint 机制，修改 [`seedGreetingLocalDataFromTemplate_ACU()`](src/service/runtime/helpers-data-merge.ts:372)，让新对话模板基底只写 checkpoint 和必要 marker，不再写 `tagData.independentData`；新增/调整测试保证首楼模板基底读取源为 checkpoint。
deviation_audit:
  original_plan_excerpt: "- step_5: 单独设计模板初始化 checkpoint 入口，确认模板基底来源后再实现；不得把它塞进 retention。"
  current_proposal: "复用现有 [`template-seed`](src/shared/models/table-persistence-v2.ts:6) checkpoint 机制，修改 [`seedGreetingLocalDataFromTemplate_ACU()`](src/service/runtime/helpers-data-merge.ts:372)，让新对话模板基底只写 checkpoint 和必要 marker，不再写 `tagData.independentData`；新增/调整测试保证首楼模板基底读取源为 checkpoint。"
  diff_summary: 新增事实是已有模板 checkpoint 入口；删除“新增 source/入口”的计划；替换为“收束既有入口，移除 legacy-style 并行写入”。
  deviation_motive_check:
    - 措辞替换规则逐类检查：全部未命中。变更依据是新侦察到的既有实现，不是为了减少改动而降低质量。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。可维护性更高，因为复用现有 source；健壮性更高，因为消除双轨；可扩展性不下降。
    - 偏离是否导致 affected_scope 缩小？→ NO。仍处理模板初始化路径，只是从新增机制改为收束既有机制。
  self_dissection: 未触发。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_a 为 5/5、4/5、5/5，综合优于 option_b 和 option_c。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。已覆盖 independentData 依赖变化和 marker 保留。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。选择依据是复用现有正确 checkpoint source 并删除错误双轨，而不是少改。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。覆盖 runtime template seed、migration、reconstruct、repository 和测试。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。双轨 independentData 残留已纳入修复。
  - options 是否包含至少三个方案？ → YES。包含 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。未发生工具报错，源代码修改继续使用编辑工具。
  - deviation_audit 是否触发了 self_dissection？ → NO。
</decision_point>
---
<decision_point>
issue: 编辑测试后 VSCode 再次报告 [`tsconfig.json`](tsconfig.json:19) 的 `baseUrl` 弃用诊断。这不是本次修改引入的测试或生产代码错误，而是 TypeScript 版本对既有配置的编辑器级提示；之前命令行 [`npm run typecheck`](package.json) 已验证该项目在现有配置下可通过。
impact: NO。该诊断不影响当前 checkpoint 源头锁死方案可行性，也不指向刚修改的 [`tests/service/table/table-delta-reconstruct.test.ts`](tests/service/table/table-delta-reconstruct.test.ts)。
context_update: 不改变 analysis 的核心假设；只补充执行期事实：编辑器会重复报告既有 [`baseUrl`](tsconfig.json:19) 弃用提示，最终仍以命令行 typecheck 为验收准绳。
options:
  - option_a:
      description: 不修改 [`tsconfig.json`](tsconfig.json)，继续当前任务，后续通过 [`npm run typecheck`](package.json) 判断是否存在真实类型错误。
      approach_evaluation: 可维护性 5/5，不把无关配置迁移混入持久化改造；健壮性 5/5，仍保留正式 typecheck；可扩展性 5/5，避免扩大任务范围。
      edge_cases: 如果 typecheck 后续失败，再按真实错误处理。
      affected_scope_delta: 无新增代码文件。
  - option_b:
      description: 立即在 [`tsconfig.json`](tsconfig.json) 添加 `ignoreDeprecations`。
      approach_evaluation: 可维护性 2/5，把无关配置变更混进本任务；健壮性 3/5，可消除提示但不解决 checkpoint 需求；可扩展性 3/5，可能影响项目 TypeScript 策略。
      edge_cases: 配置改动需要额外验证所有构建链。
      affected_scope_delta: 新增 [`tsconfig.json`](tsconfig.json)。
  - option_c:
      description: 暂停实现，先做 TypeScript 配置迁移。
      approach_evaluation: 可维护性 1/5，偏离当前业务目标；健壮性 2/5，不能修复用户反馈；可扩展性 2/5，任务边界失控。
      edge_cases: checkpoint 改造中断，状态更难追踪。
      affected_scope_delta: 大幅扩大到构建配置。
recommendation: 选择 option_a。三维评估综合最优的是继续当前任务，并在验证阶段用命令行 typecheck 兜底。该诊断是既有配置提示，不应污染本次持久化迁移。
execution_plan_update: execution_plan 不变；验证阶段保留 [`npm run typecheck`](package.json)。
deviation_audit:
  original_plan_excerpt: "- step_6: 运行目标测试、类型检查、构建、全量测试并归档。"
  current_proposal: "继续当前代码与测试修改；在 step_6 执行 [`npm run typecheck`](package.json)，不提前修改 [`tsconfig.json`](tsconfig.json)。"
  diff_summary: 无核心计划变更；只是明确忽略既有编辑器诊断，等待正式 typecheck。
  deviation_motive_check:
    - 措辞替换规则逐类检查：全部未命中。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。仍执行原验证。
    - 偏离是否导致 affected_scope 缩小？→ NO。
  self_dissection: 未触发。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_a 不扩大范围且保留验证。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。若正式 typecheck 失败会再处理。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。该诊断与当前任务无关，避免混入无关变更是边界控制。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。已记录为既有配置诊断并保留正式验证。
  - options 是否包含至少三个方案？ → YES。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。
  - deviation_audit 是否触发了 self_dissection？ → NO。
</decision_point>
---
<output_quality_review>
task_summary: 本次任务将聊天历史表格持久化读取源锁定到 V2 checkpoint + 后续 delta。legacy snapshot 现在只作为一次性迁移输入，迁移成功后写入首个可写 AI 消息的 root checkpoint，并清理当前 isolation 的 legacy 源；新对话模板种子复用既有 template-seed checkpoint，移除 parallel legacy-style independentData 写入。
deliverables:
  - 修改 [`src/service/table/table-delta-migration.ts`](src/service/table/table-delta-migration.ts)：新增首个可写 AI 消息定位、root checkpoint 构造、root 迁移结果返回，并在迁移后清理当前 isolation legacy snapshot。
  - 修改 [`src/service/table/table-delta-reconstruct.ts`](src/service/table/table-delta-reconstruct.ts)：legacy fallback 写回首楼 root checkpoint 后，返回的 checkpoint 与 checkpointMessageIndex 保持同一 root 语义，不再暴露旧 legacy 消息 hint。
  - 修改 [`src/service/runtime/helpers-data-merge.ts`](src/service/runtime/helpers-data-merge.ts)：新对话模板基底只写 tablePersistenceV2 checkpoint 和必要 marker，不再把模板表格并行写入 independentData。
  - 修改 [`tests/service/table/table-delta-reconstruct.test.ts`](tests/service/table/table-delta-reconstruct.test.ts)：覆盖 legacy 首楼迁移、非首楼 legacy 清理、delta-only 回放、模板 key 不匹配 fallback、返回 checkpoint hint 对齐。
  - 修改 [`tests/service/runtime/helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts)：覆盖 template-seed checkpoint-only 语义，确认 independentData/modifiedKeys/updateGroupKeys 不再承载模板基底。

# 量化指标总览
metrics:
  total_files_modified: 5 — 修改 3 个生产文件、2 个测试文件。
  execution_plan_coverage: 6/6 = 100% — analysis 与 decision_point 更新后的执行计划均已完成：侦察、root migration、reconstruct 对齐、回归测试、template-seed 收束、验证归档。
  edge_cases_handled: 6/6 = 100% — 无 AI 不写、已有 V2 不迁移、delta-only 有 baseline 后回放、非首楼 legacy 迁移到首楼、多 isolation 通过 current isolation 清理函数限定、template seed 不覆盖 provider/legacy 源均已处理或由既有路径保持。
  confidence_assessment: HIGH — 目标测试、类型检查、构建、全量测试均通过；仍需诚实说明：legacy snapshot 前移到首楼本身是用户明确要求的“锁死源头”语义，代码通过清理 legacy 源避免后续双源读取，但历史时间语义上的取舍不会被粉饰成不存在。

# 实质性检查
substance_check:
  - 产物是否包含实际业务逻辑变化，而不是只改测试或注释？
    → YES。核心变化在 [`migrateLegacyCheckpointToRootMessage_ACU()`](src/service/table/table-delta-migration.ts:214)、[`reconstructTablesFromChatDeltas_ACU()`](src/service/table/table-delta-reconstruct.ts:36)、[`seedGreetingLocalDataFromTemplate_ACU()`](src/service/runtime/helpers-data-merge.ts)；测试用于锁定行为，不是替代实现。
  - 产物是否能被其目标对象（被测代码/被重构模块/被修复的bug）的变化所"击穿"？
    → YES。如果 legacy 仍写回原消息、未清理 legacy 字段、返回 checkpoint hint 仍指向旧消息、template seed 继续写 independentData，对应新增断言会失败。
  - 实质性比率: 5/5 = 100%。所有修改文件都有直接行为价值，没有凑数文件。

# 覆盖完整性检查
completeness_check:
  - 是否存在被跳过的模块/函数/路径？
    → NO。核心链路覆盖 migration、reconstruct、runtime template seed 与对应测试；repository 清理函数复用既有实现，没有必要改动其接口。update-orchestrator 作为调用方通过 reconstruct 受益，不需要重复实现迁移逻辑。
  - 产物覆盖的范围是否与 execution_plan 中 affected_scope 完全一致？
    → YES。affected_scope 中的 migration、reconstruct、runtime/template seed、reconstruct test、retention target test 均覆盖；table-delta-repository 未改代码但通过调用其 clear 函数纳入行为路径；update-orchestrator 不改是因为底层 reconstruct 统一处理，避免重复迁移逻辑。
  - 核心业务逻辑是否都有直接验证（不依赖间接覆盖）？
    → YES。legacy 首楼迁移由 [`tests/service/table/table-delta-reconstruct.test.ts`](tests/service/table/table-delta-reconstruct.test.ts) 直接验证；template checkpoint-only 由 [`tests/service/runtime/helpers-data-merge.test.ts`](tests/service/runtime/helpers-data-merge.test.ts) 直接验证；retention 未被污染由 [`tests/service/table/table-delta-retention.test.ts`](tests/service/table/table-delta-retention.test.ts) 目标测试和全量测试验证。
  - affected_scope 覆盖率: 7/7 = 100%。

# 价值密度检查
value_density_check:
  - 产物中高价值内容（验证核心逻辑/处理复杂场景）与低价值内容（验证trivial行为）的比例是多少？
    → 高价值:低价值 = 5:0，高价值占比 100%。新增断言集中在源头锁死、legacy 清理、checkpoint hint 对齐、template seed 去双轨，都是事故风险点，不是 trivial 行为。
  - 是否存在"用数量掩盖质量"的模式——大量 trivial 产物掩盖了核心逻辑缺少验证的事实？
    → NO。测试数量不多，但每个断言都对应用户要求的核心不变量。

# 需求对齐检查
alignment_check:
  - 产物满足的是用户的字面需求还是本质需求？
    → 满足本质需求。用户要“读取源头始终是 checkpoint 加后续变动”，本次实现把 legacy 限制为一次性 migration input，并把新对话模板基底收束为 checkpoint-only，避免 legacy-style independentData 成为并行长期源。
  - "如果这是别人交给我的，我会接受吗？"
    → YES。验证证据完整：目标测试 3 files / 98 tests 通过；[`npm run typecheck`](package.json) 通过；[`npm run build`](package.json) 通过并生成 [`dist/index.bundle.js`](dist/index.bundle.js)，架构护栏 0 违规；[`npm test`](package.json) 100 files / 2652 tests 全部通过。代码不是靠“应该不会出事”交付，边界和回归都被压住了。
</output_quality_review>
