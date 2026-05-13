<decision_point>
issue: 助手实测反馈显示自动填表进入 processUpdatesBatch_ACU 后，SqlTableService.replaceCurrentData 调用 SyncBridge.loadFromTableData 时连续报 “table xxx already exists”。这说明我之前“replaceCurrentData 通过 dispose + new SqliteEngine 一定获得空内存库”的假设不成立，或者 dispose/new engine 在运行环境中没有清空 sql.js 数据库对象。更关键的是，SyncBridge._loadSheet 当前直接执行 CREATE TABLE，没有处理“同一次 loadFromTableData 内多张 sheet 使用同一 SQL 表名”或“目标库已有同名表”的边界。这个错误在单测未暴露，是因为测试数据只有一张目标表，没有覆盖真实模板多表加载和 provider 替换连续运行的场景。
impact: YES。该问题直接影响 SQL 模式自动/手动填表：replaceCurrentData 在批次基底同步时会对每张表报错，导致 SQLite provider 未正确加载当前批基底，前一轮修复的目标被破坏。必须修，不允许把这类错误当日志噪声。
context_update: 之前 analysis 的“SQL 实现重建 SQLite/SyncBridge 并加载 JSON”需要增加硬约束：loadFromTableData 必须能安全替换当前库中的同名用户表；即使 engine 没有真正清空，或者连续批次加载同一模板表，也不能因 CREATE TABLE already exists 失败。affected_scope 需要加入 src/data/sqlite/sync-bridge.ts 及其测试 tests/data/sqlite/sync-bridge.test.ts，并补充 SqlTableService 多表 replaceCurrentData 回归。
options:
  - option_a:
      description: 在 SqlTableService.replaceCurrentData 内强化 dispose/new SqliteEngine，额外调用底层数据库关闭或重新初始化，试图保证每次 SyncBridge.loadFromTableData 前都是全新数据库。
      approach_evaluation: 可维护性 2/5，因为它把问题压在 SqlTableService 生命周期上，SyncBridge 仍然不具备幂等加载能力；健壮性 2/5，因为只要其他调用方对同一 SyncBridge/engine 重复 loadFromTableData，仍会复现 table already exists；可扩展性 2/5，因为未来增量加载、刷新加载、导入加载都会重复踩同一坑。
      edge_cases: 同一 TableDataObject 中两张 sheet DDL 指向同一 SQL 表名仍会冲突；engine dispose 在浏览器 sql.js 环境中若不完全释放，错误仍存在；其他 loadFromTableData 调用方不受保护。
      affected_scope_delta: 主要变更 src/service/table/sql-table-service.ts，测试只覆盖 replaceCurrentData 生命周期。
  - option_b:
      description: 在 SyncBridge._loadSheet 建表前解析 tableName，若目标 SQLite 已存在同名表，则 DROP TABLE 后再执行 CREATE TABLE 和插入数据；同时写回元数据。这样 loadFromTableData 具备“用传入 JSON 快照替换当前 SQLite 用户表”的幂等语义。
      approach_evaluation: 可维护性 5/5，因为修复位于真正执行 CREATE TABLE 的抽象层，所有调用方获得一致行为；健壮性 4/5，因为可以覆盖 replaceCurrentData 连续加载和 engine 未清空导致的同名表冲突，但仍需确认不会 drop 内部 meta 表；可扩展性 5/5，因为后续导入/刷新/批次加载都需要同样的幂等加载语义。
      edge_cases: 不能 drop _acu_sheet_meta；DROP TABLE 只能针对 parseDDLTableName 得到的用户表名；同一 JSON 内多 sheet 指向同一 tableName 时，后加载 sheet 会覆盖前一个 sheet，需要记录/测试这种行为或至少暴露为可预测结果；失败单表不应阻断其他表的既有容错语义。
      affected_scope_delta: 变更 src/data/sqlite/sync-bridge.ts，补 tests/data/sqlite/sync-bridge.test.ts；必要时保留 SqlTableService replaceCurrentData 测试。
  - option_c:
      description: 将 DDL 改写为 CREATE TABLE IF NOT EXISTS，遇到已有表时直接复用表结构并插入数据。
      approach_evaluation: 可维护性 3/5，因为表结构变化时旧表不会更新，历史模板变更会隐性污染；健壮性 1/5，因为旧数据不会自动清空，会把旧批次数据和当前批次数据混在一起，正好违背 replaceCurrentData 的“替换当前基底”语义；可扩展性 2/5，因为模板 DDL 演进时会制造更隐蔽的数据错配。
      edge_cases: 旧数据残留、列结构不匹配、唯一约束冲突、CHECK 约束变化都可能导致不可预测结果。
      affected_scope_delta: 变更 src/data/sqlite/schema-mapper.ts 或 SyncBridge DDL 执行逻辑，并调整大量预期。
recommendation: 推荐 option_b。三维评估综合最优：可维护性 5/5、健壮性 4/5、可扩展性 5/5。真正的问题发生在 SyncBridge 的加载幂等性，不是在上层继续假装 engine 生命周期一定可靠。CREATE TABLE already exists 不是小噪声，是抽象契约缺失。
execution_plan_update: 重新打开任务：1. 修改 src/data/sqlite/sync-bridge.ts，在 _loadSheet 建表前对已存在的用户表执行 DROP TABLE，保证 loadFromTableData 能替换当前 SQLite 表；2. 在 tests/data/sqlite/sync-bridge.test.ts 增加重复 loadFromTableData/同名表替换回归，验证第二次加载不报 already exists 且旧数据被替换；3. 在 tests/service/table/sql-table-service.test.ts 增补或扩展 replaceCurrentData 多表/重复替换场景；4. 运行目标测试、typecheck、build、全量测试；5. 重新验收并归档新的修复链。
deviation_audit:
  original_plan_excerpt: 已交付的方案认为 SqlTableService.replaceCurrentData 重建 SQLite engine/SyncBridge 后即可加载批次 JSON 快照，并通过单表测试与全量测试验证。
  current_proposal: 保留 provider replaceCurrentData 的总体设计，但把幂等加载能力下沉到 SyncBridge._loadSheet，使 CREATE TABLE 前清理已存在用户表，补真实冲突回归。
  diff_summary: 新增 SyncBridge 幂等加载修复；新增重复加载/同名表替换测试；不撤销 provider 统一数据源方案；不使用降级运行方式。
  deviation_motive_check:
    - 措辞替换规则逐类检查：未命中需要自我剖析的降级措辞。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。原方案缺少真实运行边界，当前方案补齐底层幂等性，评分更高。
    - 偏离是否导致 affected_scope 缩小？→ NO。affected_scope 扩大到 SyncBridge 和底层测试，未砍掉任何必要范围。
  self_dissection: 未触发。当前是实测暴露的生产边界，而不是为了回避复杂度更换方案。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_b 在真正失败点修复幂等加载，而不是依赖上层生命周期或保留旧表。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。会覆盖已有同名表、重复加载、旧数据替换、多表加载继续容错。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。没有选择只改 SqlTableService 或 CREATE TABLE IF NOT EXISTS；选择的是修复抽象契约。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。新增 sync-bridge 源码和测试，并继续验证 SqlTableService。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。用户反馈的 console 错误直接阻断 SQL provider 基底同步，必须处理。
  - options 是否包含至少三个方案？ → YES。已列出 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。继续使用 edit_file。
  - deviation_audit 是否触发了 self_dissection？ → NO。未触发偷懒判定。
</decision_point>

---

<output_quality_review>
task_summary: 修复用户实测反馈的 SQL 模式自动填表报错：SyncBridge.loadFromTableData 重复加载同名 SQL 表时直接 CREATE TABLE，导致 table already exists，进而使 SqlTableService.replaceCurrentData 无法把批次基底同步进 SQLite provider。
deliverables:
  - src/data/sqlite/sync-bridge.ts：在 _loadSheet 建表前增加 _dropExistingUserTable(tableName)，对已存在用户表执行 DROP TABLE，再按当前 JSON 快照重建，补齐 loadFromTableData 的替换式加载语义。
  - tests/data/sqlite/sync-bridge.test.ts：新增重复加载同名表替换旧数据的回归；新增多张真实风格 sheet 正常加载回归，覆盖 global_state/protagonist_info 这类用户反馈中的真实表名模式。
  - tests/service/table/sql-table-service.test.ts：新增连续 replaceCurrentData 加载同名表回归，验证服务层调用不会因旧表残留出现 table already exists。
  - dist/index.bundle.js：重新 npm run build 生成的正式 JS bundle。

# 量化指标总览
metrics:
  total_files_modified: 4 — 修改 1 个底层同步桥源码、2 个测试文件、1 个构建产物。
  execution_plan_coverage: 6/6 = 100% — 已完成实测问题决策、SyncBridge 幂等替换修复、底层与服务层回归、目标测试、typecheck、build、全量测试与重新验收。
  edge_cases_handled: 4/4 = 100% — 覆盖同一 engine 重复 loadFromTableData、replaceCurrentData 连续替换同名表、真实多表模板加载、非法/内部表名防御性拒绝。
  confidence_assessment: HIGH — 目标测试通过 3 个文件 135 个用例；npm run typecheck 通过；npm run build 通过且架构护栏 0 违规；npm test 全量通过 100 个文件 2650 个用例。

# 产物实质性检查
substance_check:
  - 产物中是否存在"形式完整但实质空洞"的内容？
    → NO。src/data/sqlite/sync-bridge.ts 的 _dropExistingUserTable 直接改变失败路径：CREATE TABLE 前会清理已存在用户表；新增测试会在删除该逻辑时稳定失败。
  - 产物是否能被其目标对象（被测代码/被重构模块/被修复的bug）的变化所"击穿"？
    → YES。如果 _dropExistingUserTable 不执行，tests/data/sqlite/sync-bridge.test.ts 的重复加载同名表用例会重现 table already exists；如果 SqlTableService.replaceCurrentData 再次保留旧表状态，tests/service/table/sql-table-service.test.ts 的连续替换用例会失败。
  - 实质性比率: 4/4 = 100% — 每个产物都直接服务于修复用户实测报错或生成可试用 bundle。

# 覆盖完整性检查
completeness_check:
  - 是否存在被跳过的模块/函数/路径？
    → NO。错误栈指向 replaceCurrentData → SyncBridge.loadFromTableData → _loadSheet → SqliteEngine.run；修复落在 _loadSheet，服务层 replaceCurrentData 有回归，批处理入口此前已有 update-orchestrator 回归。
  - 产物覆盖的范围是否与 execution_plan 中 affected_scope 完全一致？
    → YES。新增 affected_scope 中的 src/data/sqlite/sync-bridge.ts、tests/data/sqlite/sync-bridge.test.ts、tests/service/table/sql-table-service.test.ts 均已处理。
  - 核心业务逻辑是否都有直接验证（不依赖间接覆盖）？
    → YES。底层 SyncBridge 重复加载用例直接验证 CREATE TABLE already exists 不再发生；服务层连续 replaceCurrentData 用例直接验证用户报错链路；全量测试验证无跨模块回归。
  - affected_scope 覆盖率: 3/3 = 100%

# 价值密度检查
value_density_check:
  - 产物中高价值内容（验证核心逻辑/处理复杂场景）与低价值内容（验证trivial行为）的比例是多少？
    → 高价值:低价值 = 4:0，高价值占比 100%。新增用例不是凑数量，而是复现“重复加载同名 SQL 表”这个生产级失败模式。
  - 是否存在"用数量掩盖质量"的模式——大量 trivial 产物掩盖了核心逻辑缺少验证的事实？
    → NO。新增 3 个测试点都对准失败链路：底层重复加载、真实多表加载、服务层连续替换。

# 需求对齐检查
alignment_check:
  - 产物满足的是用户的字面需求还是本质需求？
    → 满足本质需求。用户反馈的是 SQL 模式自动填表时 replaceCurrentData 触发多张表 already exists。修复没有把错误静音，也没有改成 CREATE TABLE IF NOT EXISTS 混旧数据，而是让 SyncBridge 的加载语义变成真正的“按当前 JSON 快照替换 SQLite 用户表”。
  - "如果这是别人交给我的，我会接受吗？"
    → YES。因为这次补的是真实失败点，不再依赖 engine 生命周期假设；同时有底层和服务层双重回归、typecheck、build、全量测试。上一版漏掉这个边界，质量只能算不合格；这版把漏洞补到了抽象层，才像样。
</output_quality_review>
