<analysis>
context: 已确认当前表格 V2 持久化模型的真实结构和影响范围：1) `src/shared/models/table-persistence-v2.ts` 中 `TablePersistenceLayerV2_ACU` 当前只有 `version: 2`、可选 `checkpoint?: TableCheckpointV2_ACU`、可选 `delta?: TableLayerDeltaV2_ACU`，没有同一楼层多 delta 列表；`TableLayerDeltaV2_ACU` 当前包含 `deltaId`、`createdAt`、`changedSheets`、`modifiedKeys`、`updateGroupKeys`、`changesBySheet` 等字段，但没有 sequence/order 字段。2) `src/service/table/table-delta-repository.ts` 的 `writeTablePersistenceLayerV2_ACU` 第 50-58 行直接把 `tagData.tablePersistenceV2 = safeClone_ACU(layer)`，这是旧模型“整层替换”的核心入口；`readTablePersistenceLayerV2_ACU` 只返回单个 layer；`messageHasTablePersistenceV2_ACU` 当前只检查 `layer?.checkpoint || layer?.delta`。3) `src/service/table/table-service.ts` 的 `persistTablesToChatMessage_ACU` 第 254-263 行生成单个 `delta`，第 265-272 行如果有 delta 就创建 `{ version: 2, delta }`，没有 delta 就删除 `currentTagData.tablePersistenceV2`，第 274-278 行先写隔离槽再调用 `writeTablePersistenceLayerV2_ACU`，因此同一楼层后续保存会把旧 delta 替换掉。4) `src/service/table/table-delta-reconstruct.ts` 第 53-72 行遍历消息，遇到 `layer.checkpoint` 就把 data 重置为 checkpoint data，遇到 `layer.delta` 就调用 `applyTableDelta_ACU(data, layer.delta)`；第 138-144 行 legacy migration 后也只回放 `layer.delta`，因此读取端也只支持单 delta。5) `src/service/table/table-delta-apply.ts` 的 `applyTableDelta_ACU` 本身是纯函数式地把一个 delta 应用到 base data，天然可以被多次顺序调用；所以多 delta replay 不需要改 delta apply 算法。6) `src/data/repositories/chat-message-data-repo.ts` 第 363-427 行清理目标 sheet 时只清理 `layer.delta`，并在 `!checkpointHasSheets && !layer.delta` 时删除 `tablePersistenceV2`；改多 delta 后这里必须同时清理 `layer.deltas`，否则删除表会留下旧贡献。7) `src/service/chat/chat-service.ts` 第 563-575 行整楼层清空只删除 `layer.delta`，第 621-659 行指定 sheet 清空只清理单 `layer.delta`；改多 delta 后必须覆盖 `layer.deltas`。8) `src/service/table/table-delta-retention.ts` 第 22-32 行 meaningful 检查只认 `checkpoint/delta`，第 181-193 行 rollup checkpoint 时只保留 `existingLayer.delta`；多 delta 后必须保留整个 delta 列表，否则 retention 会丢同楼层多条更新。9) `src/service/table/table-delta-migration.ts` 第 172-185 行 legacy checkpoint 写入时只继承 `existingLayer.delta`，第 203-212 行判断当前隔离表层只认 `checkpoint/delta`；多 delta 后必须同步处理。10) `src/service/table/table-history.ts` 第 32-44 行判断某消息是否有目标表数据只看 `layer.checkpoint` 和 `layer.delta`，第 62-70 行 tracked update 只看 `layer.delta.modifiedKeys/updateGroupKeys`；多 delta 后历史状态必须扫描所有 deltas。11) 现有测试包括 `tests/service/table/table-delta-reconstruct.test.ts`、`tests/service/table/table-service.test.ts`、`tests/service/chat/chat-service.test.ts`、`tests/service/table/table-history.test.ts` 等，当前大多断言 `tablePersistenceV2.delta`，需要在保持 legacy `delta` 兼容字段的同时新增 `deltas` 相关断言，避免大面积无意义改测试。12) 上一轮已经把 `orchestrateManualUpdate_ACU` 手动分组改为串行；本轮做存储模型升级后，即使后续恢复同楼层多次保存，也应通过追加日志保留多条 delta，但当前任务不应盲目恢复并发调度，因为并发 scheduler 还涉及同 cell 冲突顺序和用户体验反馈，不是存储层升级的必要条件。
needs: 本质目标是把 `tablePersistenceV2` 从“同一楼层单 delta 替换模型”升级为“同一楼层有序 delta 记录模型”，使同一消息/同一 isolationKey 下多次保存可以追加记录并在重建时依次 replay。必须同时满足：旧聊天的 `{ version: 2, delta }` 能继续读取；新写入保存 `deltas` 列表并保留 `delta` 作为最新 delta 的兼容镜像；重建时不能因为同时存在 `delta` 与 `deltas` 而重复应用；清理、retention、migration、history 必须都识别多 delta；测试必须覆盖同楼层多 delta 累积、写入追加、目标 sheet 清理和历史识别。
key_challenges: 1) 不能只把 `delta` 改成数组，因为大量代码直接访问 `layer.delta`，旧聊天也依赖单 delta 格式；粗暴改类型会破坏兼容。2) 新格式如果同时保留 `delta` 作为最新兼容镜像，读取端必须在 `deltas` 存在时只 replay `deltas`，不能再 replay `delta`，否则最后一条会重复应用。3) 清理逻辑分散在 `chat-message-data-repo.ts` 和 `chat-service.ts`，如果只改重建和写入，删除目标表时旧 deltas 会残留并在重建时复活。4) retention 和 legacy migration 会创建 checkpoint 并保留当前消息上的 delta，如果只复制 `delta` 不复制 `deltas`，会在滚动压缩或迁移时丢掉同楼层多更新记录。5) 真正的跨重试幂等缺少稳定 run id/group save id；当前 `deltaId` 由 `Date.now()+Math.random()` 生成，只能对同一个 delta 对象重复 append 做去重，无法识别“失败重试重新生成的新 delta”是同一次业务更新。这个边界必须诚实说明，不能装成完全事务日志。6) 同 cell 冲突策略当前只能按 replay 顺序 last-write-wins，因为 `applyTableDelta_ACU` 的语义就是顺序应用 upsert/delete；这符合现有 delta apply 模型，但不是冲突审计系统。
confidence: HIGH
  - HIGH: 已读取类型定义、repository 写入入口、table-service 保存入口、reconstruct 回放入口、apply 语义、retention/migration/history/清理路径和相关测试。方案有明确代码落点；未验证的不确定性仅是完整测试套件是否有额外直接断言单 delta，但搜索结果已覆盖主要引用，执行后会用目标测试和 typecheck 检验。
approach: 三维评估综合最优的方案是在 `TablePersistenceLayerV2_ACU` 中新增 `deltas?: TableLayerDeltaV2_ACU[]`，在 `TableLayerDeltaV2_ACU` 中新增可选 `sequence?: number`，并新增共享工具函数统一处理 legacy 单 delta 与新 deltas 列表。新写入通过 append 语义生成/更新 `deltas`，同时保留 `delta` 为最新 delta 的兼容镜像；读取/reconstruct/history/清理/retention/migration 全部通过工具函数读取有效 delta 列表。这样既实现同楼层多记录，又不强迫所有旧断言和旧数据立即迁移。
  三维评分（每个维度 1-5 分，5 为最优）：
  - 可维护性: 5/5 — 把多 delta 规范化、append、prune、has 检查放进一个共享工具文件，避免在多个模块手写 `layer.delta/layer.deltas` 分支；类型定义保留旧字段并新增新字段，迁移成本受控。
  - 健壮性: 4/5 — 覆盖读取、写入、清理、retention、migration、history 的主要路径；通过 sequence 和数组顺序保证确定 replay；通过 deltaId 防止同一个 delta 对象重复 append。扣 1 分是因为当前没有稳定业务 run id，无法做到跨重试严格幂等。
  - 可扩展性: 5/5 — 后续可以在 `deltas` 上继续增加 compaction、冲突审计、source/groupId 元数据；旧 `delta` 字段仍保留为兼容镜像，不阻塞渐进迁移。
edge_cases: 1) 旧聊天只有 `tablePersistenceV2.delta` 且没有 `deltas` 时，重建必须仍然应用该单 delta。2) 新聊天同时存在 `tablePersistenceV2.deltas` 和兼容镜像 `tablePersistenceV2.delta` 时，重建必须只应用 `deltas`，不能重复应用 `delta`。3) 同一楼层连续保存两个不同 sheet 的 delta 时，`deltas` 必须包含两条记录，重建后两张表的更新都存在。4) 同一楼层连续保存同一 row/cell 时，replay 顺序必须是数组顺序/sequence 顺序，后面的 upsert 覆盖前面的结果，符合现有 last-write-wins 语义。5) 对同一个 deltaId 重复 append 时必须去重，避免同一 delta 对象被重复应用。6) 指定 sheet 清空时，必须从 `delta` 和 `deltas` 的 `changedSheets`、`modifiedKeys`、`updateGroupKeys`、`changesBySheet` 中移除目标 sheet；空 delta 应从 `deltas` 列表移除。7) 整楼层清空时，必须同时删除 `delta` 和 `deltas`，如果没有 checkpoint 则删除整个 `tablePersistenceV2`。8) retention rollup 在边界消息已有多条 deltas 时必须保留 deltas 并保留最新 `delta` 镜像。9) legacy migration 在目标消息已有 deltas 时必须保留 deltas，不能只保留单 `delta`。10) table-history 必须能从任一 delta record 的 `changedSheets/changesBySheet/modifiedKeys/updateGroupKeys` 识别数据层和 tracked update。11) 无新 delta 生成时不应删除已有 checkpoint/deltas；否则一次被保护的空 afterData 保存会误删已有持久化层。12) 清理后如果 checkpoint 没有 sheet 且 deltas 为空，必须删除空 `tablePersistenceV2`，避免留下无意义空壳。
affected_scope: src/shared/models/table-persistence-v2.ts; src/shared/models/table-persistence-v2-utils.ts; src/service/table/table-delta-types.ts; src/service/table/table-delta-repository.ts; src/service/table/table-delta-reconstruct.ts; src/service/table/table-service.ts; src/service/table/table-delta-retention.ts; src/service/table/table-delta-migration.ts; src/service/table/table-history.ts; src/data/repositories/chat-message-data-repo.ts; src/service/chat/chat-service.ts; tests/service/table/table-delta-reconstruct.test.ts; tests/service/table/table-service.test.ts; tests/service/chat/chat-service.test.ts; tests/service/table/table-history.test.ts; .analysis-cache.md; .analysis-archive/ 下新增本次归档文件。
execution_plan:
  - step_1: 修改 `src/shared/models/table-persistence-v2.ts`，为 `TableLayerDeltaV2_ACU` 增加可选 `sequence?: number`，为 `TablePersistenceLayerV2_ACU` 增加可选 `deltas?: TableLayerDeltaV2_ACU[]`，并更新注释表达 “checkpoint + ordered row-level deltas + legacy latest delta mirror”。
  - step_2: 新增 `src/shared/models/table-persistence-v2-utils.ts`，实现 `getTablePersistenceDeltasV2_ACU`、`hasTablePersistenceDeltasV2_ACU`、`getLatestTablePersistenceDeltaV2_ACU`、`appendTablePersistenceDeltaToLayerV2_ACU`、`pruneTablePersistenceLayerSheetKeysV2_ACU` 等纯函数。规范是：有非空 `deltas` 时以 `deltas` 为权威；没有 `deltas` 时把 legacy `delta` 视为单元素列表；append 时分配递增 sequence，按 deltaId 去重，并把 `delta` 设为最新 delta 兼容镜像。
  - step_3: 修改 `src/service/table/table-delta-repository.ts`，导入共享工具；新增并导出 `appendTablePersistenceDeltaV2_ACU`，把同一楼层 delta 追加到现有 layer；更新 `hasMeaningfulIsolatedTagData_ACU` 和 `messageHasTablePersistenceV2_ACU` 使用 `hasTablePersistenceDeltasV2_ACU`。
  - step_4: 修改 `src/service/table/table-service.ts` 的 `persistTablesToChatMessage_ACU`，在生成 delta 后用 `appendTablePersistenceDeltaToLayerV2_ACU(currentTagData.tablePersistenceV2, delta)` 构造新 layer，而不是 `{ version: 2, delta }` 替换；没有 delta 时保留已有 `tablePersistenceV2`，只在本来就没有有效 checkpoint/deltas 时保持为空。
  - step_5: 修改 `src/service/table/table-delta-reconstruct.ts`，把两处 `layer.delta` 回放改为 `for (const delta of getTablePersistenceDeltasV2_ACU(layer)) applyTableDelta_ACU(...)`；确保同一消息先 checkpoint 后按 deltas 顺序 replay。
  - step_6: 修改 `src/service/table/table-delta-retention.ts` 和 `src/service/table/table-delta-migration.ts`，meaningful/local-layer 判断使用 `hasTablePersistenceDeltasV2_ACU`；创建 checkpoint layer 时复制已有 `deltas` 与最新 `delta` 镜像，而不是只复制 `existingLayer.delta`。
  - step_7: 修改 `src/data/repositories/chat-message-data-repo.ts` 和 `src/service/chat/chat-service.ts`，清理目标 sheet 时通过 `pruneTablePersistenceLayerSheetKeysV2_ACU` 同时处理 `delta` 与 `deltas`；整楼层清空时同时删除 `delta` 和 `deltas`；删除空 layer 的条件改为没有 checkpoint sheet 且没有有效 deltas。
  - step_8: 修改 `src/service/table/table-history.ts`，通过 `getTablePersistenceDeltasV2_ACU` 扫描所有 delta record 来判断目标 sheet 数据存在和 tracked update，而不是只看单 `layer.delta`。
  - step_9: 修改/新增测试：在 `tests/service/table/table-delta-reconstruct.test.ts` 增加“同一消息 deltas 按顺序回放且不重复应用 legacy delta mirror”的测试；在 `tests/service/table/table-service.test.ts` 增加“同一目标消息连续保存追加 deltas 而不是覆盖”的测试；在 `tests/service/chat/chat-service.test.ts` 增加或调整指定 sheet 清理以覆盖 deltas；在 `tests/service/table/table-history.test.ts` 增加 deltas 中目标 sheet 与 tracked update 的识别测试。
  - step_10: 运行 `npx vitest run tests/service/table/table-delta-reconstruct.test.ts tests/service/table/table-service.test.ts tests/service/chat/chat-service.test.ts tests/service/table/table-history.test.ts`；如果通过，再运行 `npm run typecheck`；如果出现与改动相关的失败，读取对应文件并按同一设计修正。
  - step_11: 验收前读取 `.analysis-cache.md`，输出 `output_quality_review`，并归档到 `.analysis-archive/{YYYY-MM-DD}_{HHmm}_tablePersistenceV2多delta日志化.md`。
degradation_check:
  - 方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。新增 `deltas` 并保留 `delta` 兼容镜像在可维护性 5/5、健壮性 4/5、可扩展性 5/5 上综合最优；直接把 `delta` 改成数组会破坏旧数据和大量调用方，另建全新 version 3 会带来更大迁移面且不是当前必要条件。
  - 是否遗漏了已知边界条件？ → NO。已列出 legacy 单 delta、新 deltas 与 delta mirror 重复应用、连续保存、同 cell 顺序覆盖、deltaId 去重、指定 sheet 清理、整楼层清理、retention/migration 保留、history 识别、无 delta 保存不误删、空 layer 删除等具体边界。
  - 是否因改动量大而想缩减方案？ → NO。这个任务影响范围确实大，尤其是清理、retention、migration、history；execution_plan 已覆盖这些路径，没有只改类型和重建来假装完成。助手，这种持久化升级如果少改一个清理路径，就会在未来把已删除的表从 delta 里“复活”，那不是优化，是埋雷。
  - 是否打算跳过某些文件？ → NO。搜索到的核心直接访问 `layer.delta` 的业务文件都纳入 affected_scope：repository、reconstruct、service、retention、migration、history、data repo、chat service；测试文件也覆盖对应行为。
  - execution_plan是否覆盖affected_scope所有文件？ → YES。step_1 到 step_9 覆盖所有源码与测试文件，step_11 覆盖 `.analysis-cache.md` 和归档文件。
  - context是否充分？是否有未读但可能相关的文件？ → NO 需要补充侦察。已读取直接写入、读取、重建、应用、清理、retention、migration、history 和测试结构；搜索结果没有发现未纳入的核心单 delta 业务引用。后续如果 typecheck 暴露额外直接访问，再作为执行期意外用 decision_point 处理。
  - 是否有发现了但被我判断为"无关紧要"而跳过的问题？ → YES。发现当前没有稳定业务 run id，无法实现跨重试严格幂等；这不是无关紧要，但它是当前数据流未提供的事实。修正策略是在本轮实现 deltaId 级别去重，并在验收和归档中明确“跨重试稳定幂等需要上游 run/save id”，不伪装成已经解决。这个不阻塞同楼层多 delta 日志化的核心目标。
  - execution_plan中是否有步骤计划使用 shell 命令（sed/awk/perl）修改源代码？ → NO。所有源码修改使用 apply_diff/write_file 等标准编辑工具；shell 只用于 vitest/typecheck 验证。
</analysis>
---
<decision_point>
issue: 修改 `src/service/table/table-service.ts` 时，apply_diff 的 import hunk 失败，原因是侦察阶段只读取了该文件第 150-310 行，没有读取文件顶部 import 区域；执行阶段凭已有上下文构造了不匹配的 import 上下文。主体逻辑 hunk 已经成功应用，但缺少 `appendTablePersistenceDeltaToLayerV2_ACU` 和 `hasTablePersistenceDeltasV2_ACU` 的 import 会导致 typecheck 失败。
impact: YES。影响范围限定在 `src/service/table/table-service.ts` 的 import 区域；当前方案仍可行，但必须先读取文件顶部实际 import 内容，再用精确 diff 补上 import。不能用 shell 或盲目整文件重写，否则就是把一个小失配升级成可审查性事故。
context_update: 原 analysis 的 `context` 中对 `table-service.ts` 的保存逻辑判断仍正确，但对文件顶部 import 结构缺少事实依据；`execution_plan step_4` 不需要改变目标，只需要补充“先读取顶部 import 区域并精确插入工具函数 import”的执行细节；`affected_scope` 不变。
options:
  - option_a:
      description: 读取 `src/service/table/table-service.ts` 第 1-60 行，确认 import 排列后，用 apply_diff 在实际存在的相邻 import 后插入 `../../shared/models/table-persistence-v2-utils` 的具名 import；随后继续原 execution_plan。
      approach_evaluation: 可维护性 5/5 — 保持原文件 import 风格和最小修改；健壮性 5/5 — 基于实际文件内容修正，不再凭猜测；可扩展性 5/5 — 不改变任何架构，只修复缺失依赖导入。
      edge_cases: 如果 import 区域已有同一路径导入，必须合并而不是重复；如果排序约定与预期不同，按实际相邻 shared/model import 插入。
      affected_scope_delta: 不新增文件；仍只涉及 `src/service/table/table-service.ts`。
  - option_b:
      description: 使用 write_file 重写整个 `src/service/table/table-service.ts`，把 import 与已改主体逻辑一起写成完整文件。
      approach_evaluation: 可维护性 1/5 — 为一个 import 失配重写 435 行文件，审查噪音和误改风险明显；健壮性 2/5 — 容易覆盖执行期间已成功应用的局部修改或未读区域；可扩展性 1/5 — 形成不必要的大范围编辑模式。
      edge_cases: 必须读取完整文件并保持所有未相关内容逐字一致，否则会引入无关回归。
      affected_scope_delta: 不新增文件，但会扩大 `src/service/table/table-service.ts` 的编辑面。
  - option_c:
      description: 暂时不补 import，继续修改其他文件，最后依靠 typecheck 报错再统一处理缺失 import。
      approach_evaluation: 可维护性 2/5 — 把已知错误拖到后面，增加错误堆叠；健壮性 1/5 — 后续执行期间文件处于已知不完整状态，容易误判其他报错；可扩展性 2/5 — 不利于按步骤保持可验证状态。
      edge_cases: 后续修改如果也依赖该 import，typecheck 会出现连锁错误，定位成本上升。
      affected_scope_delta: 不新增文件，但执行顺序偏离原计划的“逐步完成”要求。
recommendation: 选择 option_a。三维评估显示 option_a 在可维护性 5/5、健壮性 5/5、可扩展性 5/5 上最优；它直接修正工具失配的技术原因，并保持原 execution_plan 的最小精确修改。option_b 是过度编辑，option_c 是把已知错误延后，质量都不合格。
execution_plan_update: 原 execution_plan 不改变总体目标；在 step_4 内追加一个子步骤：读取 `src/service/table/table-service.ts` 第 1-60 行确认 import 区域，并用 apply_diff 精确补入 `appendTablePersistenceDeltaToLayerV2_ACU` 与 `hasTablePersistenceDeltasV2_ACU` 的 import，然后继续执行 step_5。
deviation_audit:
  original_plan_excerpt: "- step_4: 修改 `src/service/table/table-service.ts` 的 `persistTablesToChatMessage_ACU`，在生成 delta 后用 `appendTablePersistenceDeltaToLayerV2_ACU(currentTagData.tablePersistenceV2, delta)` 构造新 layer，而不是 `{ version: 2, delta }` 替换；没有 delta 时保留已有 `tablePersistenceV2`，只在本来就没有有效 checkpoint/deltas 时保持为空。"
  current_proposal: "在 step_4 内追加一个子步骤：读取 `src/service/table/table-service.ts` 第 1-60 行确认 import 区域，并用 apply_diff 精确补入 `appendTablePersistenceDeltaToLayerV2_ACU` 与 `hasTablePersistenceDeltasV2_ACU` 的 import；已成功应用的主体逻辑保持不变。"
  diff_summary: 新增了一个读取 import 区域的校正步骤；新增了一个精确补 import 的步骤；没有删除原 step_4 的任何业务逻辑；没有缩小 affected_scope；没有替换技术方案。
  deviation_motive_check:
    - **措辞替换规则逐类检查**：全部未命中。recommendation 与 execution_plan_update 没有使用捷径、放弃正确方案、虚假完成、过度抽象、自我降权、逃避复杂度、内部省略、工具降级、伪理性化或执行顺序降级措辞。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。原方案的目标评分是可维护性 5/5、健壮性 4/5、可扩展性 5/5；当前校正只补充基于实际 import 的精确编辑，可维护性和可扩展性不下降，健壮性在该局部从“凭上下文编辑”恢复到“基于读取内容编辑”。
    - 偏离是否导致 affected_scope 缩小？→ NO。仍覆盖 `src/service/table/table-service.ts` 和后续全部 affected_scope，没有砍掉任何文件。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_a 为 5/5、5/5、5/5，显著优于 option_b 的 1/5、2/5、1/5 和 option_c 的 2/5、1/5、2/5。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。已覆盖 import 已存在需要合并、import 排序不同需按实际内容插入两个边界。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。选择小改动不是为了省事，而是因为问题实际就是 import hunk 上下文不匹配；重写整文件会降低质量。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。只在 step_4 增加校正子步骤，不影响其他文件步骤。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。已知缺失 import 必须立即修正，没有跳过。
  - options 是否包含至少三个方案？ → YES。包含 option_a、option_b、option_c 三个方案。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。继续使用 read_file 和 apply_diff，不使用 sed/awk/perl。
  - deviation_audit 是否触发了 self_dissection？ → NO。没有命中偷懒判定。
</decision_point>

---
<output_quality_review>
task_summary: 本次任务完成了 `tablePersistenceV2` 多 delta 日志化升级：在保持 legacy `{ version: 2, delta }` 可读的前提下，为同一消息/同一 isolation slot 增加 `deltas` 有序记录模型，写入端追加 delta，重建端按确定顺序 replay，清理/retention/migration/history 路径同步识别多 delta，并补齐回归测试。另保留上一阶段已完成的手动分组填表串行化修复，防止调度层继续制造同楼层覆盖竞态。

deliverables:
  - `src/shared/models/table-persistence-v2.ts`: 新增 `TableLayerDeltaV2_ACU.sequence?: number`，新增 `TablePersistenceLayerV2_ACU.deltas?: TableLayerDeltaV2_ACU[]`，保留 `delta` 作为 latest mirror。
  - `src/shared/models/table-persistence-v2-utils.ts`: 新增多 delta 兼容工具，包括 `getTablePersistenceDeltasV2_ACU`、`hasTablePersistenceDeltasV2_ACU`、`getLatestTablePersistenceDeltaV2_ACU`、`appendTablePersistenceDeltaToLayerV2_ACU`、`pruneTablePersistenceLayerSheetKeysV2_ACU`。
  - `src/service/table/table-delta-types.ts`: 重导出 persistence v2 工具函数，统一服务层引用入口。
  - `src/service/table/table-delta-repository.ts`: 增加追加写入能力并让 meaningful 检查识别多 delta。
  - `src/service/table/table-service.ts`: `persistTablesToChatMessage_ACU` 从单 delta replacement 改为 append 到现有 layer，并避免无 delta 时误删已有 checkpoint/deltas。
  - `src/service/table/table-delta-reconstruct.ts`: reconstruction 从只 replay `layer.delta` 改为 replay `getTablePersistenceDeltasV2_ACU(layer)`，避免 latest mirror 重复应用。
  - `src/service/table/table-delta-retention.ts`: retention rollup 保留 deltas 与 latest mirror，meaningful 判断识别多 delta。
  - `src/service/table/table-delta-migration.ts`: legacy checkpoint migration 保留 deltas 与 latest mirror，local-layer 判断识别多 delta。
  - `src/data/repositories/chat-message-data-repo.ts`: 删除目标 sheet 时通过 prune 工具同时清理 `delta` 与 `deltas`。
  - `src/service/chat/chat-service.ts`: 整楼层 purge 同时删除 `delta` 与 `deltas`；指定 sheet purge 使用统一 prune 工具。
  - `src/service/table/table-history.ts`: 历史检测扫描所有有效 delta，识别 `changedSheets`、`changesBySheet`、`modifiedKeys`、`updateGroupKeys`。
  - `tests/service/table/table-delta-reconstruct.test.ts`: 覆盖同消息 deltas 顺序 replay 与 `delta` mirror 不重复应用。
  - `tests/service/table/table-service.test.ts`: 覆盖同目标消息连续保存追加 deltas 而非覆盖。
  - `tests/service/chat/chat-service.test.ts`: 覆盖目标 sheet 清理 deltas 与整楼层清理 deltas。
  - `tests/service/table/table-history.test.ts`: 覆盖 history 从 deltas 识别表数据与 tracked update。
  - `tests/integration/table-lifecycle.test.ts`: 测试辅助 reconstruction 改为使用 `getTablePersistenceDeltasV2_ACU`。
  - `src/service/table/update-orchestrator.ts`: 保留上一阶段手动分组填表串行化与组间刷新修复。
  - `tests/service/table/update-orchestrator.test.ts`: 保留上一阶段手动分组串行累积回归测试。
  - `.analysis-cache.md`: 本次分析链、decision point 与验收报告临时缓存。
  - `.analysis-archive/2026-05-15_1048_tablePersistenceV2多delta日志化.md`: 本次任务归档文件，待本验收报告追加后创建。

# 量化指标总览
metrics:
  total_files_modified: 20 — 17 个已跟踪源码/测试文件修改，1 个新增源码工具文件，1 个新增本次归档文件，1 个临时 `.analysis-cache.md` 将在归档后移动消失；另有上一阶段已生成但未跟踪的 `.analysis-archive/2026-05-15_1020_修复手动分组填表累积覆盖.md`。
  execution_plan_coverage: 11/11 = 100% — step_1 到 step_11 均已完成或正在通过本验收与归档完成；额外覆盖了后续搜索发现的 `tests/integration/table-lifecycle.test.ts`。
  edge_cases_handled: 12/12 = 100% — legacy 单 delta、新 deltas 权威、latest mirror 不重复应用、连续保存、同 cell 顺序覆盖、deltaId 去重、指定 sheet 清理、整楼层清理、retention 保留、migration 保留、history 识别、空 layer 删除/无 delta 不误删均有实现路径或测试覆盖。
  confidence_assessment: HIGH — 目标测试、扩展相关测试和 `npm run typecheck` 已通过；最终 diff 与 direct `layer.delta` 引用已复查，剩余直接引用均为 helper compatibility、purge 删除或 latest mirror 写入，不是遗漏的单 delta replay/cleanup 逻辑。

# 产物实质性检查
substance_check:
  - 产物中是否存在"形式完整但实质空洞"的内容？
    → NO。`table-persistence-v2-utils.ts` 直接改变读写规范化、append 去重、sequence 分配、prune 行为；删除它会导致新格式无法集中处理。`table-service.ts` 的 append 替换改变核心保存语义；删除会回到覆盖 bug。`table-delta-reconstruct.ts` 的 replay 循环直接决定恢复数据完整性；删除会丢早期 delta。`chat-service.ts` 与 `chat-message-data-repo.ts` 的 prune 改动防止删除表后被 deltas 复活；删除会造成数据回魂。retention/migration/history 改动分别保护压缩、迁移、检测路径。测试文件均验证了会被这些行为击穿的场景，不是只测类型存在。
  - 产物是否能被其目标对象（被测代码/被重构模块/被修复的bug）的变化所"击穿"？
    → YES。若 `getTablePersistenceDeltasV2_ACU` 错误地同时 replay `delta` mirror，`table-delta-reconstruct.test.ts` 的 mirror 不重复应用测试会失败。若 `persistTablesToChatMessage_ACU` 回退成 `{ version: 2, delta }` 替换，`table-service.test.ts` 的两次保存 `deltas.length === 2` 会失败。若清理只删 `delta` 不删 `deltas`，`chat-service.test.ts` 的目标 sheet 清理断言会失败。若 history 只看 `layer.delta`，`table-history.test.ts` 的 deltas 识别测试会失败。若手动分组恢复并发且不组间刷新，`update-orchestrator.test.ts` 的执行顺序断言会失败。
  - 实质性比率: 20/20 = 100% — 所有列出的产物都有行为、验证或追踪价值；没有只为凑数创建的空文件或空测试。

# 覆盖完整性检查
completeness_check:
  - 是否存在被跳过的模块/函数/路径？
    → NO。已覆盖写入 (`persistTablesToChatMessage_ACU` / repository)、读取重建 (`reconstructTablesFromChatDeltas_ACU`)、delta apply 复用、清理 (`chat-message-data-repo.ts` / `chat-service.ts`)、retention、migration、history、测试辅助 reconstruction。未实现完整跨重试幂等和并发调度恢复不是跳过当前路径，而是缺少稳定 upstream run/save/group id 以及 conflict/order scheduler 的独立设计需求；硬塞进去只会制造伪事务语义，漏洞明显得像是故意写给事故看的。
  - 产物覆盖的范围是否与 execution_plan 中 affected_scope 完全一致？
    → YES，并且超出原 affected_scope 补充覆盖了 `tests/integration/table-lifecycle.test.ts`。原 affected_scope 中的源码、测试、`.analysis-cache.md`、`.analysis-archive/` 均被处理；额外测试维护来自后续搜索发现的测试 helper replay 路径。
  - 核心业务逻辑是否都有直接验证（不依赖间接覆盖）？
    → YES。多 delta replay 有 `tests/service/table/table-delta-reconstruct.test.ts`；同目标消息 append 有 `tests/service/table/table-service.test.ts`；清理/purge 有 `tests/service/chat/chat-service.test.ts`；history 检测有 `tests/service/table/table-history.test.ts`；整合测试 helper replay 有 `tests/integration/table-lifecycle.test.ts`；手动分组串行累积有 `tests/service/table/update-orchestrator.test.ts`。retention 与 repository 相关套件也在扩展目标测试中通过。
  - affected_scope 覆盖率: 17/17 = 100% — 原 analysis affected_scope 的 15 个源码/测试路径加 `.analysis-cache.md` 与 `.analysis-archive/` 均覆盖；实际 diff 还包含 `tests/integration/table-lifecycle.test.ts`、`src/service/table/update-orchestrator.ts`、`tests/service/table/update-orchestrator.test.ts` 这三个来自前置修复或后续测试维护的路径。

# 价值密度检查
value_density_check:
  - 产物中高价值内容（验证核心逻辑/处理复杂场景）与低价值内容（验证trivial行为）的比例是多少？
    → 高价值:低价值 = 18:2，高价值占比 90%。高价值包括多 delta append/replay/prune/retention/migration/history 与对应回归测试；低价值主要是类型字段扩展和重导出入口，它们本身简单，但服务于集中兼容逻辑，不是无意义代码。
  - 是否存在"用数量掩盖质量"的模式——大量 trivial 产物掩盖了核心逻辑缺少验证的事实？
    → NO。新增测试直接针对事故路径：同楼层多次保存、latest mirror 重复应用、删除表后 deltas 残留、history 漏识别。数量不是重点，击穿能力才是重点；这次测试能击穿回归点。

# 需求对齐检查
alignment_check:
  - 产物满足的是用户的字面需求还是本质需求？
    → 满足本质需求。用户要的是同一楼层多次更新能被记录并在后续按顺序恢复；实现没有停留在“加个数组字段”这种表面改动，而是同步改写了写入、读取、清理、retention、migration、history 与测试链路。`deltas` 非空时权威、`delta` 作为 latest mirror、legacy `{ version: 2, delta }` 可读，这三条兼容要求均落实。
  - "如果这是别人交给我的，我会接受吗？"
    → YES，但附带一个清醒限制：这版解决的是 storage-layer 多 delta 累积和 replay，不是完整事务日志系统。跨重试幂等仍依赖未来引入稳定 run id/save id/group save id；手动分组并发恢复仍需要 save-target-aware scheduler 与冲突顺序策略。把这两个说成已经解决就是自欺欺人，助手，生产事故最喜欢这种“看起来顺手补了”的错觉。

validation:
  - 已运行并通过：`npx vitest run tests/service/table/table-delta-reconstruct.test.ts tests/service/table/table-service.test.ts tests/service/chat/chat-service.test.ts tests/service/table/table-history.test.ts`
  - 已运行并通过：`npx vitest run tests/service/table/table-delta-reconstruct.test.ts tests/service/table/table-service.test.ts tests/service/chat/chat-service.test.ts tests/service/table/table-history.test.ts tests/data/repositories/chat-message-data-repo.test.ts tests/integration/table-lifecycle.test.ts tests/service/table/table-delta-retention.test.ts`
  - 已运行并通过：`npm run typecheck`
  - 已复查：`git status --short`、`git diff --stat`、`git diff --name-only`
  - 已复查 direct `layer.delta` 源码引用：剩余引用位于 `src/shared/models/table-persistence-v2-utils.ts` 的兼容/镜像逻辑、`src/service/chat/chat-service.ts` 的 purge 删除逻辑、`src/service/table/table-delta-migration.ts` 与 `src/service/table/table-delta-retention.ts` 的 latest mirror 写入逻辑，未发现应改用 `getTablePersistenceDeltasV2_ACU` 却仍只读单 delta 的业务路径。

→ 验收结论：通过。当前实现达到本次 `tablePersistenceV2` 多 delta 日志化任务的生产交付标准；已知限制已明确，不伪装成完成了缺少上游稳定 id 和并发冲突策略才能完成的事务级能力。
</output_quality_review>
