<analysis>
context:
  - 用户反馈的运行时错误来自 SQLite 导出链路：[`SqliteEngine.query()`](src/data/sqlite/sqlite-engine.ts:98) 执行 `SELECT * FROM _acu_sheet_meta;` 报 `no such table: _acu_sheet_meta`，调用栈进入 [`SyncBridge._loadAllMeta()`](src/data/sqlite/sync-bridge.ts:210) → [`SyncBridge.exportToTableData()`](src/data/sqlite/sync-bridge.ts:73) → [`SqlTableService.getCurrentData()`](src/service/table/sql-table-service.ts:183) → 刷新/世界书更新。
  - [`SyncBridge.loadFromTableData()`](src/data/sqlite/sync-bridge.ts:40) 会在加载 JSON 快照时执行 `META_TABLE_DDL` 创建 `_acu_sheet_meta`；但 [`SqlTableService.loadFromChat()`](src/service/table/sql-table-service.ts:57) 在新开卡或空壳结构场景下明确不调用 `loadFromTableData()`，只初始化 engine 并等待第一次写操作建表。这会让 engine ready 但元表不存在。
  - [`SqlTableService.getCurrentData()`](src/service/table/sql-table-service.ts:183) 只判断 `_initialized` 和 `engine.isReady`，随后无条件调用 [`SyncBridge.exportToTableData()`](src/data/sqlite/sync-bridge.ts:73)。因此新开卡/空壳结构下刷新世界书或导出当前数据会触发 `_acu_sheet_meta` 查询。
  - [`SyncBridge._loadAllMeta()`](src/data/sqlite/sync-bridge.ts:210) 已经 try/catch 并在 catch 后返回空 map，但它内部调用的是 [`SqliteEngine.query()`](src/data/sqlite/sqlite-engine.ts:98)，该方法会先记录 error log 再 throw。于是虽然业务层没有崩掉，但用户看到了错误日志；这不是可接受的“正常空结果”，而是错误路径被当控制流使用。能跑不等于能交付，别把异常日志当分支判断。
  - [`SqliteEngine.getTableNames()`](src/data/sqlite/sqlite-engine.ts:181) 排除了 `_acu_%` 内部表；[`SyncBridge.exportToTableData()`](src/data/sqlite/sync-bridge.ts:73) 遍历用户表前必须能安全获得元数据 map。
  - [`tests/data/sqlite/sync-bridge.test.ts`](tests/data/sqlite/sync-bridge.test.ts) 目前只覆盖了有 `loadFromTableData()` 后导出、未初始化导出、同步 JSON 等路径，缺少“engine 已初始化但还没有元表时导出应无错误返回 mate-only 数据”的回归。
needs:
  - 在 SQLite engine ready 但尚未加载任何表/元数据的场景下，`exportToTableData()` 必须返回 `{ mate }`，不能触发错误日志，也不能依赖异常控制流。
  - 保持“新开卡 executeQuery 不触发建表”的既有语义。修复不能为了消除元表缺失而把所有模板表提前建出来，否则会破坏用户首次填表前可改 DDL 的设计。
  - `loadFromTableData()` 仍必须创建元表并写入元数据；修复应集中在元表存在性保证或导出前检查，而不是吞掉所有 SQLite query 错误。
  - 测试要直接覆盖 `SyncBridge.exportToTableData()` 在空数据库下的行为，并确保不会调用 `logError_ACU` 记录 `no such table`。
key_challenges:
  - 不能把 `_loadAllMeta()` 的 catch 当作合格修复，因为日志已经在 engine 层打出，用户仍会看到红色错误。这类“捕获但先污染日志”的路径在真实运行时等价于假报错。
  - 不能在 `SqlTableService.loadFromChat()` 的 empty 分支调用完整 `loadFromTableData()` 来创建模板表，因为这会破坏按需建表策略。
  - 元表是内部结构，创建一个空 `_acu_sheet_meta` 不等于创建用户表，不会锁定 DDL；但需要避免把该行为误扩展为用户表初始化。
  - 如果未来数据库里存在用户表但元表缺失，单纯返回空 map 会导致导出为空。这个状态理论上不应出现；本次错误栈是空库元表缺失。需要用测试覆盖空库，保留对异常不一致状态的可诊断性。
confidence: HIGH
  - 侦察已确认触发链路、元表创建位置、空壳/新开卡分支不会创建元表、错误日志来源在 `SqliteEngine.query()`。根因明确：导出路径用 `SELECT _acu_sheet_meta` 探测元表存在性，导致正常空库场景走错误日志。
approach:
  三维评估综合最优的方案是：在 [`SyncBridge`](src/data/sqlite/sync-bridge.ts) 内部增加元表存在性检查/确保方法，使导出路径在读取元数据前先用 `sqlite_master` 判断 `_acu_sheet_meta` 是否存在；若不存在则直接返回空 meta map 或显式创建空元表。为保持职责清晰，推荐在 `exportToTableData()` 前确保元表存在但不创建任何用户表。这样空库导出不会打错误日志，已有数据加载路径仍正常。
  三维评分（每个维度 1-5 分，5 为最优）：
  - 可维护性: 5/5 — 元表生命周期收敛在 `SyncBridge`，不把特殊判断散落到 `SqlTableService.getCurrentData()`、世界书、刷新链路。调用方继续只关心 TableDataObject。
  - 健壮性: 5/5 — 消除异常控制流，覆盖空库、空壳结构、新开卡刷新、后续按需建表；不会吞掉真实 SQL 错误。
  - 可扩展性: 4/5 — 后续如果元表 schema 演进，可集中在 `SyncBridge` 的元表 ensure 方法中处理；目前不做迁移版本管理，因为现有 schema 没有版本字段。
edge_cases:
  - engine 未初始化：`exportToTableData()` 仍应抛出“未初始化”，不能被本次修复吞掉。
  - engine 已初始化但没有任何用户表和元表：导出返回 `{ mate }`，不记录错误日志。
  - engine 已初始化且只存在元表无用户表：导出返回 `{ mate }`。
  - engine 已初始化且有通过 `loadFromTableData()` 加载的用户表和元表：导出行为保持原样，保留 sheet 的 uid/name/sourceData/updateConfig/exportConfig。
  - 空壳结构下 `SqlTableService.getCurrentData()`：应返回当前 JSON 视图或 mate-only 导出，不再污染日志；不提前建用户表。
  - 手工破坏状态：若存在用户表但元表缺失，本次方案创建空元表后导出无法映射用户表，会返回 mate-only；这是可诊断的数据一致性问题，后续可单独加恢复策略，但不能在本轮凭空推断 sheet 元数据。
affected_scope:
  - [`src/data/sqlite/sync-bridge.ts`](src/data/sqlite/sync-bridge.ts)
  - [`tests/data/sqlite/sync-bridge.test.ts`](tests/data/sqlite/sync-bridge.test.ts)
  - [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts)
execution_plan:
  - step_1: 修改 [`SyncBridge`](src/data/sqlite/sync-bridge.ts)，新增私有 `ensureMetaTable_ACU` 或等价方法，用 `CREATE TABLE IF NOT EXISTS _acu_sheet_meta` 创建内部元表；在 [`exportToTableData()`](src/data/sqlite/sync-bridge.ts:73) 和 [`loadFromTableData()`](src/data/sqlite/sync-bridge.ts:40) 中统一调用，替代散落的直接 DDL 执行。
  - step_2: 调整 [`_loadAllMeta()`](src/data/sqlite/sync-bridge.ts:210)，让它在读取前确保元表存在，避免 `SELECT * FROM _acu_sheet_meta` 走 [`SqliteEngine.query()`](src/data/sqlite/sqlite-engine.ts:98) 的错误日志路径；catch 只保留 JSON 解析/意外错误兜底，不用作表存在性判断。
  - step_3: 在 [`tests/data/sqlite/sync-bridge.test.ts`](tests/data/sqlite/sync-bridge.test.ts) 增加空数据库导出回归：engine init 后不调用 `loadFromTableData()`，直接 `exportToTableData(makeMate())`，断言返回只有 mate、不会 throw、用户表仍为空。
  - step_4: 在 [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts) 增加 SQL service 新开卡/空壳后 `getCurrentData()` 不污染错误日志、不提前创建用户表的回归；利用现有 `logError_ACU` mock 验证不出现 `_acu_sheet_meta` 错误。
  - step_5: 运行目标测试 `tests/data/sqlite/sync-bridge.test.ts`、`tests/service/table/sql-table-service.test.ts`，再运行 `npm run typecheck`、`npm run build`、`npm test`。
degradation_check:
  - 方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。它在 `SyncBridge` 内收敛元表生命周期，直接消除异常控制流，不改动按需建表架构。
  - 是否遗漏了已知边界条件？ → NO。未初始化、空库、只有元表、正常加载、空壳 getCurrentData、用户表存在但元表缺失都已列出。
  - 是否因改动量大而想缩减方案？ → NO。会同时改生产代码与两类测试，不只是在 catch 里静默吞掉错误。
  - 是否打算跳过某些文件？ → NO。生产路径和服务层回归都会覆盖。
  - execution_plan是否覆盖affected_scope所有文件？ → YES。三个 affected_scope 文件分别对应 step_1/2、step_3、step_4。
  - context是否充分？是否有未读但可能相关的文件？ → NO。已读取 sqlite engine、sync bridge、sql service、相关测试；当前修复不需要改 presentation 或 worldbook，因为问题源头在 provider 导出。
  - 是否有发现了但被我判断为"无关紧要"而跳过的问题？ → NO。用户表存在但元表缺失已作为边界记录；不在本轮做元数据反推是因为缺少可靠 sheetKey/name/sourceData 来源，强行猜测会制造数据污染。
  - execution_plan中是否有步骤计划使用 shell 命令（sed/awk/perl）修改源代码？ → NO。修改使用编辑工具；shell 仅用于测试和构建。
</analysis>
---
<decision_point>
issue: 目标测试执行时 [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts) 的 `vi.mock('../../../src/shared/utils', factory)` 发生 hoist 初始化错误：`Cannot access 'mockLogError' before initialization`。这是执行阶段才暴露的问题，原因是我为了断言日志污染把 `mockLogError` 作为普通顶层常量放进 hoisted mock factory；Vitest 会提升 `vi.mock`，导致 factory 在变量初始化前访问它。
impact: YES。影响当前回归测试可运行性，不影响生产修复方向。测试如果不能运行，等于没有验证，不能交付。这里不是业务逻辑错，而是测试 mock 方式违反 Vitest hoist 规则。
context_update: analysis 的 execution_plan step_4 需要细化：服务层测试不能通过普通顶层变量传入 hoisted mock factory，必须使用 Vitest 支持的 hoisted mock 声明，或从 mocked module 动态取出 `logError_ACU` 后断言。
options:
  - option_a:
      description: 删除服务层日志断言，只保留 `getCurrentData()` 不 throw 的断言。
      approach_evaluation: 可维护性 2/5，测试变短但丢掉用户反馈中的核心“红色错误日志”验证；健壮性 1/5，无法防止 `_acu_sheet_meta` 错误日志回归；可扩展性 2/5，未来其他 provider 错误日志污染也测不出来。
      edge_cases: 业务返回正常但控制台继续报错的场景会漏检。
      affected_scope_delta: 缩小 [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts) 断言范围。
  - option_b:
      description: 使用 `vi.hoisted(() => ({ mockLogError: vi.fn() }))` 创建可被 hoisted factory 安全访问的 mock 函数，并在测试中断言该 mock 未收到 `_acu_sheet_meta` 错误。
      approach_evaluation: 可维护性 5/5，符合 Vitest mock 机制；健壮性 5/5，保留对日志污染的直接验证；可扩展性 5/5，后续其它日志断言可复用同一 hoisted mock。
      edge_cases: `beforeEach` 的 `vi.clearAllMocks()` 会清理 hoisted mock 调用记录，符合现有测试隔离。
      affected_scope_delta: 只调整 [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts) mock 声明。
  - option_c:
      description: 不在 mock factory 中暴露变量，而是在测试用例内 `await import('../../../src/shared/utils')` 后读取 `logError_ACU` 并用 `vi.mocked(logError_ACU)` 断言。
      approach_evaluation: 可维护性 4/5，不需要 hoisted 变量但每个断言要动态 import；健壮性 4/5，可验证日志调用，但类型和引用可读性略弱；可扩展性 3/5，多个测试用例重复 import 会变啰嗦。
      edge_cases: 如果模块 mock 返回的是匿名 `vi.fn()`，动态读取仍可断言；但需要在用例内确保读取的是同一个 mock 实例。
      affected_scope_delta: 调整 [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts) 测试用例断言方式。
recommendation: 选择 option_b。三维评估 option_b 在可维护性、健壮性、可扩展性均为 5/5；它既不削弱测试，又符合 Vitest 的 hoist 约束。
execution_plan_update: 将原 step_4 中的服务层日志断言实现方式改为 `vi.hoisted`：在 [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts) mock 区域定义 `const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }));`，mock factory 使用该函数，用例继续断言没有 `_acu_sheet_meta` 错误日志。
deviation_audit:
  original_plan_excerpt: "- step_4: 在 [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts) 增加 SQL service 新开卡/空壳后 `getCurrentData()` 不污染错误日志、不提前创建用户表的回归；利用现有 `logError_ACU` mock 验证不出现 `_acu_sheet_meta` 错误。"
  current_proposal: "在 [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts) 使用 `vi.hoisted` 暴露 `mockLogError`，保留 SQL service 新开卡/空壳后 `getCurrentData()` 不污染错误日志、不提前创建用户表的回归。"
  diff_summary: 不改变测试目标；只替换 mock 声明机制，避免 Vitest hoist 初始化错误。
  deviation_motive_check:
    - 措辞替换规则逐类检查：全部未命中。调整原因是明确的测试框架 hoist 约束，不是缩减范围。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。测试目标不变，可靠性提高。
    - 偏离是否导致 affected_scope 缩小？→ NO。仍覆盖同一测试文件与同一生产场景。
  self_dissection: 未触发。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_b 三维均为 5/5。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。保留日志污染断言和不提前建用户表断言。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。没有选择删除断言的 option_a。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。仍覆盖服务层回归测试。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。测试框架错误必须修，否则验证无效。
  - options 是否包含至少三个方案？ → YES。包含 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。继续使用编辑工具修正测试。
  - deviation_audit 是否触发了 self_dissection？ → NO。
</decision_point>
---
<output_quality_review>
task_summary: 修复 SQLite 空库/新开卡场景下导出当前数据时 `_acu_sheet_meta` 不存在导致控制台错误日志的问题。产物包括元表生命周期修复、空库导出回归、SQL provider 新开卡 getCurrentData 回归。
deliverables:
  - 修改 [`src/data/sqlite/sync-bridge.ts`](src/data/sqlite/sync-bridge.ts)：新增 [`SyncBridge._ensureMetaTable()`](src/data/sqlite/sync-bridge.ts:119)，在 [`SyncBridge.loadFromTableData()`](src/data/sqlite/sync-bridge.ts:40) 与 [`SyncBridge.exportToTableData()`](src/data/sqlite/sync-bridge.ts:73) 中统一确保内部元表存在。
  - 修改 [`tests/data/sqlite/sync-bridge.test.ts`](tests/data/sqlite/sync-bridge.test.ts)：新增空数据库直接导出 mate-only 且不创建用户表的回归。
  - 修改 [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts)：新增新开卡无数据后 [`SqlTableService.getCurrentData()`](src/service/table/sql-table-service.ts:183) 不触发 `_acu_sheet_meta` 错误日志、不提前创建用户表的回归，并用 `vi.hoisted` 修正 Vitest mock 约束。
metrics:
  total_files_modified: 3 — 1 个生产文件、2 个测试文件。
  execution_plan_coverage: 5/5 = 100% — 元表 ensure、导出路径、sync-bridge 回归、sql-service 回归、验证命令全部完成。
  edge_cases_handled: 6/6 = 100% — 未初始化仍抛错、空库导出、仅元表无用户表、正常加载导出、空壳/新开卡 getCurrentData、用户表存在但元表缺失的边界已按分析策略处理或明确不做危险反推。
  confidence_assessment: HIGH — 目标测试、类型检查、构建、全量测试均通过，无已知遗漏。
substance_check:
  - 产物中是否存在"形式完整但实质空洞"的内容？
    → NO。生产代码改变了空库导出路径：`exportToTableData()` 现在先创建 `_acu_sheet_meta` 内部表，不会让正常空状态走 `SqliteEngine.query()` 错误日志。测试能击穿该行为：删除 `_ensureMetaTable()` 调用会让服务层日志断言失败或空库导出路径重新出现错误。
  - 产物是否能被其目标对象的变化所"击穿"？
    → YES。若 [`SyncBridge.exportToTableData()`](src/data/sqlite/sync-bridge.ts:73) 不再确保元表，空库导出回归会暴露；若 [`SqlTableService.getCurrentData()`](src/service/table/sql-table-service.ts:183) 在新开卡后继续污染日志，服务层测试会暴露；若误提前创建用户表，`executeQuery('SELECT * FROM inventory')` 的 throw 断言会暴露。
  - 实质性比率: 3/3 = 100%。
completeness_check:
  - 是否存在被跳过的模块/函数/路径？
    → NO。问题源头在 [`SyncBridge`](src/data/sqlite/sync-bridge.ts)，触发入口在 [`SqlTableService`](src/service/table/sql-table-service.ts)，两层都已有回归。presentation/worldbook 是调用方，不应在调用方吞掉 provider 的内部元表错误。
  - 产物覆盖的范围是否与 execution_plan 中 affected_scope 完全一致？
    → YES。三个 affected_scope 文件均已修改并验证。
  - 核心业务逻辑是否都有直接验证？
    → YES。核心逻辑一：空库 export 返回 mate-only，不创建用户表，在 [`tests/data/sqlite/sync-bridge.test.ts`](tests/data/sqlite/sync-bridge.test.ts) 直接验证。核心逻辑二：新开卡 getCurrentData 不污染 `_acu_sheet_meta` 错误日志且不提前建用户表，在 [`tests/service/table/sql-table-service.test.ts`](tests/service/table/sql-table-service.test.ts) 直接验证。核心逻辑三：正常 loaded 数据导出仍由原有 sync-bridge/sql-service 测试覆盖。
  - affected_scope 覆盖率: 3/3 = 100%。
value_density_check:
  - 产物中高价值内容与低价值内容的比例是多少？
    → 高价值:低价值 = 3:0，高价值占比 100%。新增测试都针对真实运行时错误链路，不是验证 getter/setter 之类的废测试。
  - 是否存在"用数量掩盖质量"的模式？
    → NO。只新增必要回归，没有用大量 trivial case 堆数量。
alignment_check:
  - 产物满足的是用户的字面需求还是本质需求？
    → 满足本质需求。用户给的是错误栈，真正需求不是“隐藏报错”，而是让 SQLite provider 在新开卡/空库状态下具备合法内部状态，不把正常空状态当 SQL 错误打出来。
  - "如果这是别人交给我的，我会接受吗？"
    → YES。修复点收敛、测试直接覆盖错误链路、没有破坏按需建表策略、验证完整。若只在 catch 里吞掉错误日志，那是事故粉饰；这版没有这么做。
validation:
  - `npx vitest run tests/data/sqlite/sync-bridge.test.ts tests/service/table/sql-table-service.test.ts` → PASS，2 files / 82 tests passed。
  - `npm run typecheck` → PASS。
  - `npm run build` → PASS，生成 [`dist/index.bundle.js`](dist/index.bundle.js)，架构护栏 0 违规。
  - `npm test` → PASS，100 files / 2656 tests passed。
</output_quality_review>
