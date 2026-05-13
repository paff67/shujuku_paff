<analysis>
context:
  - 用户追加要求：如果旧聊天记录楼层已经超过保留楼层数量，legacy snapshot 不应无条件写入首个 AI 消息，而应写到“最早的保留楼层数量上”，并随着后续楼层推进而更新。这里的技术含义是：legacy migration 的 durable checkpoint 锚点必须尊重 [`settings_ACU.retainRecentLayers`](src/service/runtime/state-manager.ts:184) 的保留窗口，而不是永久钉在首楼。
  - [`purgeOldLayerData_ACU()`](src/service/chat/chat-service.ts:231) 使用 [`settings_ACU.retainRecentLayers`](src/service/runtime/state-manager.ts:184) 作为保留数量；它从 index 1 开始收集 `messageHasLocalLayerData_ACU()` 命中的消息索引，形成 `dataMessageIndices`，当 `dataMessageIndices.length > retainCount` 时调用 [`rollupCheckpointBeforePurge_ACU()`](src/service/table/table-delta-retention.ts:138)。
  - [`rollupCheckpointBeforePurge_ACU()`](src/service/table/table-delta-retention.ts:138) 当前计算 `cutoffIndex = dataMessageIndices.length - retainCount`，把 `boundaryMessageIndex = dataMessageIndices[cutoffIndex]` 作为保留窗口的最早消息，并在该消息写入 `source: 'retention-rollup'` checkpoint，然后清理更早的 `purgedMessageIndices`。这个逻辑已经实现“随楼层推进而不断更新”的 retention rollup。
  - 当前刚实现的 [`migrateLegacyCheckpointToRootMessage_ACU()`](src/service/table/table-delta-migration.ts:214) 固定用 [`findFirstWritableAiMessageIndex_ACU()`](src/service/table/table-delta-migration.ts:184) 找首个 AI 消息。这满足“未超过保留窗口时首楼存 checkpoint”，但不满足“旧聊天超过保留楼层数量时写到最早保留楼层”。
  - [`reconstructTablesFromChatDeltas_ACU()`](src/service/table/table-delta-reconstruct.ts:36) 在没有 V2 checkpoint 时才触发 legacy fallback；如果 migration 写入过早锚点，再由 retention 清理首楼数据，后续 reconstruct 可以依赖 boundary checkpoint。问题是用户要求 legacy migration 本身在超过保留数量时就落到 boundary，而不是先写首楼再等清理。
  - 现有 [`tests/service/table/table-delta-retention.test.ts`](tests/service/table/table-delta-retention.test.ts) 已覆盖 retention rollup：超过保留层写 boundary checkpoint、连续推进仍可重建、legacy 在 retention 前被 rollup 到 boundary。还缺失“legacy migration 自己根据保留窗口选择锚点”的直接测试。
needs:
  - legacy checkpoint 锚点选择必须变成：当可写 AI 消息/数据消息未超过 retainRecentLayers 时写首个 AI；当已超过 retainRecentLayers 时写最早保留窗口对应的可写 AI 消息。
  - 该锚点选择不能破坏 retention rollup。保留窗口继续由 [`rollupCheckpointBeforePurge_ACU()`](src/service/table/table-delta-retention.ts:138) 在清理阶段随楼层推进更新；legacy migration 只是首次落点也遵守同一窗口。
  - 必须避免把 checkpoint 写到用户消息、空消息或即将被清理的旧楼层。写入目标必须是非 user 消息。
  - 必须明确 retainCount 来源：底层 migration/reconstruct 不能直接强依赖 runtime settings，应该通过 options 注入，调用方可从 [`settings_ACU.retainRecentLayers`](src/service/runtime/state-manager.ts:184) 传入，测试也能精确控制。
key_challenges:
  - `dataMessageIndices` 只包含有本地数据的消息，而“最早保留楼层数量”在 UI 文案里是保留最近 N 层数据。legacy-only 老聊天可能有多个 legacy snapshot；迁移锚点应基于当前可识别的本地数据消息索引来与 purge 语义保持一致，而不是按所有 AI 消息粗暴倒数，否则会和 [`purgeOldLayerData_ACU()`](src/service/chat/chat-service.ts:231) 的行为不一致。
  - 如果 reconstruct 在没有 V2 checkpoint 时需要先迁移 legacy，而此时尚未调用 purgeOldLayerData_ACU，底层无法自动知道 `dataMessageIndices`，除非增加一个轻量扫描函数或从调用方传入 retention 参数。把 settings 直接 import 到 table 层会制造 service/runtime 依赖倒灌，质量不合格。
  - 当 retainCount <= 0 时现有语义是“全部保留”，此时 legacy 应继续写首个 AI 消息，不能把 0 当成“保留 0 层”导致无锚点。
  - 当超过保留数量但 boundary 消息不是可写 AI 时，不能写入；不过 dataMessageIndices 当前来自 messageHasLocalLayerData 或测试传入，仍需防御性处理，向后寻找或回退首个 AI 都会产生语义差异。三维评估需要明确选择。
confidence: HIGH
  - 已确认保留窗口配置字段、purge 调用链、rollup checkpoint 的 boundary 计算、当前 legacy migration 固定首楼的问题点。
  - 未验证点较小：`messageHasLocalLayerData_ACU()` 的完整实现尚未读取，但 chat-service 已明确从 index 1 收集本地数据消息，table-retention 测试也传入 `dataMessageIndices` 验证边界。实现可在 table-delta-migration 内提供可复用的 data-message 扫描，不需要读取全部 chat-service 私有实现。
approach:
  三维评估综合最优的方案是：在 table-delta-migration 层新增“retention-aware legacy checkpoint target resolver”，由 reconstruct options 接收 `retainRecentLayers`，在 legacy migration 写回时根据 chat 中可识别的本地表格数据消息索引选择锚点：未超过保留数量写首个 AI，超过则写 `dataMessageIndices[dataMessageIndices.length - retainCount]` 对应的最早保留 AI 消息。purge 阶段仍由 retention rollup 负责随楼层推进更新，不把滚动清理逻辑复制到 migration。
  三维评分（每个维度 1-5 分，5 为最优）：
  - 可维护性: 5/5 — 锚点选择封装在 migration 层，reconstruct 通过 options 注入 retainCount，避免 table 层直接依赖 runtime settings；retention rollup 继续保持单一职责。
  - 健壮性: 4/5 — 覆盖 retainCount<=0、未超过保留数、超过保留数、boundary 非 AI 防御、legacy 清理；风险点是旧数据的本地数据消息识别必须和 purge 语义尽量一致。
  - 可扩展性: 5/5 — 后续如果保留策略变化，只需调整 resolver 或传入 dataMessageIndices，不需要重写 reconstruct 主链路。
edge_cases:
  - retainRecentLayers 为 0、空、负数或非法值：按“全部保留”处理，legacy checkpoint 写首个 AI 消息。
  - 本地数据消息数量不超过 retainRecentLayers：不应跳过首楼 checkpoint，仍写首个 AI 消息，满足新聊天/短聊天读取源固定。
  - 本地数据消息数量超过 retainRecentLayers：legacy checkpoint 写到最早保留窗口的 AI 消息，即 `dataMessageIndices[length - retainCount]`。
  - boundary 消息为用户消息或不存在：不能写 checkpoint；应回退到首个可写 AI 消息还是跳过需要在实现中选择。为了不制造静默无锚点，推荐从 boundary 开始向后找第一个 AI，找不到再返回 null。
  - 迁移成功后必须继续清理当前 isolation 的 legacy snapshot，否则读取源仍可能双轨。
  - retention rollup 随后再次执行时，应继续能把 checkpoint 推进到新的 boundary，并重建完整数据。
affected_scope:
  - [`src/service/table/table-delta-migration.ts`](src/service/table/table-delta-migration.ts)
  - [`src/service/table/table-delta-reconstruct.ts`](src/service/table/table-delta-reconstruct.ts)
  - [`src/service/table/table-delta-types.ts`](src/service/table/table-delta-types.ts)
  - [`src/service/runtime/helpers-data-merge.ts`](src/service/runtime/helpers-data-merge.ts)
  - [`src/service/chat/chat-service.ts`](src/service/chat/chat-service.ts)
  - [`src/service/table/update-orchestrator.ts`](src/service/table/update-orchestrator.ts)
  - [`tests/service/table/table-delta-reconstruct.test.ts`](tests/service/table/table-delta-reconstruct.test.ts)
  - [`tests/service/table/table-delta-retention.test.ts`](tests/service/table/table-delta-retention.test.ts)
  - [`tests/service/chat/chat-service.test.ts`](tests/service/chat/chat-service.test.ts)
execution_plan:
  - step_1: 读取 [`src/service/table/table-delta-types.ts`](src/service/table/table-delta-types.ts) 确认 reconstruct options 类型，新增可选 `retainRecentLayers` 或等价字段。
  - step_2: 修改 [`src/service/table/table-delta-migration.ts`](src/service/table/table-delta-migration.ts)，新增 data-message 扫描与 retention-aware target resolver；将 [`migrateLegacyCheckpointToRootMessage_ACU()`](src/service/table/table-delta-migration.ts:214) 改为可接收 retainCount/options，并用 resolver 选择写入目标。
  - step_3: 修改 [`src/service/table/table-delta-reconstruct.ts`](src/service/table/table-delta-reconstruct.ts)，把 options 中的 retainRecentLayers 传给 migration，并确保返回 checkpoint 与 messageIndexHint 对齐实际写入目标。
  - step_4: 修改调用方：[`mergeAllIndependentTablesWithMeta_ACU()`](src/service/runtime/helpers-data-merge.ts) 和 [`rollupCheckpointBeforePurge_ACU()`](src/service/table/table-delta-retention.ts) 调用 reconstruct 时传入 retainRecentLayers/retainCount；必要时 [`loadBatchBaseData_ACU()`](src/service/table/update-orchestrator.ts) 也传入设置值，避免不同入口迁移落点不一致。
  - step_5: 补充测试：legacy 数据消息数超过 retainCount 时 checkpoint 写入最早保留层；未超过时仍写首个 AI；retention 连续推进后仍完整重建；chat-service purge 与 migration 锚点不冲突。
  - step_6: 运行目标测试、类型检查、构建、全量测试，并按验收流程归档。
degradation_check:
  - 方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。它不把 settings 硬塞进 table 层，而是通过 options 注入；不复制 retention rollup，只让 legacy 首次落点遵守同一保留窗口。
  - 是否遗漏了已知边界条件？ → NO。retainCount 非法、未超过/超过窗口、boundary 非 AI、legacy 清理、后续 retention 推进都已列入。
  - 是否因改动量大而想缩减方案？ → NO。会处理类型、migration、reconstruct、调用方和测试，不把需求硬塞进单个函数了事。
  - 是否打算跳过某些文件？ → NO。调用方必须同步，否则入口不一致会制造隐性 bug。
  - execution_plan是否覆盖affected_scope所有文件？ → YES。每个 affected_scope 文件都在 step_1 到 step_5 中有对应处理或验证。
  - context是否充分？是否有未读但可能相关的文件？ → YES。仍需读取 [`src/service/table/table-delta-types.ts`](src/service/table/table-delta-types.ts) 和相关调用方局部代码后再改；不会凭猜测修改类型。
  - 是否有发现了但被我判断为"无关紧要"而跳过的问题？ → NO。之前首楼固定写入与保留窗口冲突已明确纳入本轮修复。
  - execution_plan中是否有步骤计划使用 shell 命令（sed/awk/perl）修改源代码？ → NO。源代码修改使用编辑工具；shell 只用于测试和构建。
</analysis>
---
<decision_point>
issue: 目标测试暴露 retention 场景回归：[`rollupCheckpointBeforePurge_ACU()`](src/service/table/table-delta-retention.ts:138) 在 boundary 消息写入 checkpoint 后，重建结果丢失同层 delta。失败原因不是数据缺失，而是 [`reconstructTablesFromChatDeltas_ACU()`](src/service/table/table-delta-reconstruct.ts:69) 扫描到同一 layer 同时存在 checkpoint 和 delta 时会先设 data 为 checkpoint.data，再立即应用 delta；但 retention 测试的 `reconstructRows()` 调用显式设置 `allowLegacyMigration: false`，当前失败收到的结果只包含 checkpoint 基线，说明 boundary layer 在某个路径上 delta 没有被保留或同层 delta 被覆盖。这个问题在原 analysis 中没有具体预见，因为当时只关注 legacy migration 落点，低估了“migration 写到 boundary 后再 retention 写 checkpoint”对同层 delta 的交互。
impact: YES。影响当前保留窗口方案的可行性。如果 retention 写 boundary checkpoint 时丢同层 delta，用户要求的“随着楼层跟进不断更新”会变成数据回退：最早保留层上的本层变动消失。这漏洞明显得像是故意写给事故看的，必须修。
context_update: analysis 的 key_challenges 增加：legacy migration 写入最早保留层后，retention rollup 可能在同一 boundary 上再次写 checkpoint，必须保留 boundary 原有 delta；execution_plan step_5 需要补充同层 checkpoint+delta 回放回归。
options:
  - option_a:
      description: 修正 retention 测试预期，把 boundary delta 视为不需要回放。
      approach_evaluation: 可维护性 1/5，篡改测试掩盖真实语义；健壮性 1/5，会丢失 boundary 层变动；可扩展性 1/5，后续任何同层 checkpoint+delta 都不可靠。
      edge_cases: boundary 消息上既有 delta 的场景会静默丢数据。
      affected_scope_delta: 只改测试，但这是降级，不可接受。
  - option_b:
      description: 在 [`rollupCheckpointBeforePurge_ACU()`](src/service/table/table-delta-retention.ts:138) 写 checkpoint 前显式读取 boundary existingLayer，并保证 nextLayer 保留 existingLayer.delta；如果 failure 是 existingLayer 读取不到，则修正写入/读取路径。
      approach_evaluation: 可维护性 4/5，局部修复 retention 写入语义；健壮性 4/5，直接覆盖当前失败；可扩展性 3/5，只保护 retention，不解决其它写 checkpoint 覆盖 delta 的潜在路径。
      edge_cases: 如果 boundary delta 来源在 legacy migration 后被清理函数误删，仍需处理清理顺序。
      affected_scope_delta: [`src/service/table/table-delta-retention.ts`](src/service/table/table-delta-retention.ts) 与测试。
  - option_c:
      description: 在 migration 清理 legacy 源时避免清理目标锚点上的 V2 delta，并在 retention 写 checkpoint 时继续保留同层 delta；同时补充测试锁定 legacy migration anchor 与 retention boundary 同层时 delta 不丢。
      approach_evaluation: 可维护性 5/5，同时处理根因链路；健壮性 5/5，覆盖 migration 清理和 retention rollup 双重交互；可扩展性 5/5，保证 checkpoint+delta 同层语义在保留窗口推进中稳定。
      edge_cases: 目标锚点自身如果有 legacy fields 和 V2 delta，清 legacy 不能删除 tablePersistenceV2.delta；retention 后 reconstruct 必须应用 checkpoint 后的同层 delta。
      affected_scope_delta: [`src/service/table/table-delta-migration.ts`](src/service/table/table-delta-migration.ts)、[`src/service/table/table-delta-retention.ts`](src/service/table/table-delta-retention.ts)、[`tests/service/table/table-delta-retention.test.ts`](tests/service/table/table-delta-retention.test.ts)。
recommendation: 选择 option_c。三维评估显示 option_c 在可维护性、健壮性、可扩展性上都是 5/5，能处理 migration 锚点和 retention boundary 的真实交互；option_a 是粉饰失败，option_b 可能只修表面。
execution_plan_update: 在原 step_5 前插入一次针对失败链路的修复：读取 migration 清理与 retention 写入后的实际 layer，确认 target anchor 的 delta 是否被 `clearCurrentIsolationLegacyTableSnapshots_ACU()` 或 retention nextLayer 覆盖；随后用最小代码修正，保证 target anchor 上已有 delta 被保留。
deviation_audit:
  original_plan_excerpt: "- step_5: 补充测试：legacy 数据消息数超过 retainCount 时 checkpoint 写入最早保留层；未超过时仍写首个 AI；retention 连续推进后仍完整重建；chat-service purge 与 migration 锚点不冲突。"
  current_proposal: "在 step_5 前先修复测试暴露的 checkpoint+delta 同层丢失问题，并增加对应断言，确保 legacy migration 锚点与 retention boundary 同层时不丢 delta。"
  diff_summary: 新增了失败驱动的修复步骤；没有删除原测试和验证计划；扩大覆盖到同层 delta 保留。
  deviation_motive_check:
    - 措辞替换规则逐类检查：全部未命中。变更是测试暴露真实回归，不是为了减少工作。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。健壮性提高，因为新增了失败场景的直接处理。
    - 偏离是否导致 affected_scope 缩小？→ NO。affected_scope 增加而非缩小。
  self_dissection: 未触发。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_c 三维均为 5/5。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。同层 checkpoint+delta 已纳入。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。没有选择只改测试或只修单点的方案。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。新增 migration/retention/test 覆盖。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。测试失败即真实回归，不会跳过。
  - options 是否包含至少三个方案？ → YES。包含 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。继续使用编辑工具。
  - deviation_audit 是否触发了 self_dissection？ → NO。
</decision_point>
---
<output_quality_review>
summary:
  - 已实现 legacy checkpoint 锚点的保留窗口感知：[`resolveLegacyCheckpointAnchorMessageIndex_ACU()`](src/service/table/table-delta-migration.ts:238) 会在本地数据层数量超过 `retainRecentLayers` 时选择最早保留层，否则仍选择首个可写 AI 消息。
  - 已把 `retainRecentLayers` 作为 reconstruct options 传递，而不是让 table 层直接依赖 runtime settings。相关入口包括 [`mergeAllIndependentTablesWithMeta_ACU()`](src/service/runtime/helpers-data-merge.ts)、[`rollupCheckpointBeforePurge_ACU()`](src/service/table/table-delta-retention.ts:138)、[`loadBatchBaseData_ACU()`](src/service/table/update-orchestrator.ts)。
  - 已修复同层 checkpoint 覆盖 delta 的真实回归：[`migrateLegacyCheckpointToMessage_ACU()`](src/service/table/table-delta-migration.ts:172) 写 checkpoint 前读取既有 V2 layer，并保留 `delta`，避免 legacy migration 锚点与 retention boundary 重合时丢失本层变动。
  - 已补充/更新回归覆盖：[`tests/service/table/table-delta-reconstruct.test.ts`](tests/service/table/table-delta-reconstruct.test.ts) 覆盖超过保留数量时 legacy checkpoint 写入最早保留层、未超过时仍写首个 AI；[`tests/service/table/table-delta-retention.test.ts`](tests/service/table/table-delta-retention.test.ts) 的 legacy+retention 链路重新通过，锁住 checkpoint+delta 同层语义。
validation:
  - `npx vitest run tests/service/table/table-delta-reconstruct.test.ts tests/service/table/table-delta-retention.test.ts tests/service/chat/chat-service.test.ts` → PASS，3 files / 45 tests passed。
  - `npm run typecheck` → PASS。
  - `npm run build` → PASS，生成 [`dist/index.bundle.js`](dist/index.bundle.js)，架构护栏 0 违规。
  - `npm test` → PASS，100 files / 2654 tests passed。
quality_self_audit:
  - 这版没有采用“先写首楼再等 retention 清”的偷懒路径，而是让 legacy 首次落点与保留窗口一致；读取源仍锁定 checkpoint + 后续 delta，不再依赖并行 legacy snapshot。
  - 这版处理了同层 checkpoint+delta 的边界，否则看似通过迁移、实则会在 retention boundary 上吞掉一层变动。那种实现能跑，但不配交付。
  - 当前实现仍有一个明确取舍：当 boundary 不是可写 AI 时，resolver 从 boundary 开始向后找第一个 AI；这是防御性策略，避免写入用户消息。该行为与现有聊天数据结构兼容，且测试覆盖了主路径。若未来要支持用户消息持久化，需要单独调整持久层约束，而不是在这里偷偷放宽。
final_status: PASS。实现、回归、类型检查、构建、全量测试均完成。
</output_quality_review>
