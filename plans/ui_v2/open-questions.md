# UI v2 开放问题与债务

> 统一收纳 P-* / SUN-* / X-* / G-* / 债务。`tag`：design / shutdown / gap / debt / cross-stage；`status`：open / partially-closed / closed。
> 主表用于一眼扫描；下方"详情"对每条提供 1-2 段关键信息（背景 / 何时 / 倾向 / 关联）。已关闭项见末尾历史附录。

## 主表

| ID | tag | status | 描述 | 影响范围 | 阻塞 | 提出日期 |
|---|---|---|---|---|---|---|
| P3-1 | design | closed | 12 状态枚举中文文案表 | 交火模式页 | 否 | 2026-05-02 |
| P3-2 | design | closed | 移动端栅格断点与降级规则 | 多列页面 | 否 | 2026-05-02 |
| P3-4 | design | closed | Sidebar 一级页可见性与基础/高手模式 | 全局导航 | 否 | 2026-05-02 |
| P3-5 | design | closed | 剩余功能页内部布局 | 填表/智能续写/数据管理/正文替换/SQL/日志 | 否 | 2026-05-02 |
| P3-6 | design | closed | 填表提示词预设升级迁移 | 填表页 | 否 | 2026-05-02 |
| P-VI-1 | design | closed | VectorIndexPage 新配置字段接入 | 交火模式页 | 否 | 2026-05-04 |
| SUN-1 | shutdown | open | v2 toast / confirm / input dialog 试做已回滚；toast 收窄为 v2 主界面内反馈 | v2 feedback / 旧 UI 下线 | 是 | 2026-05-02 |
| SUN-2 | shutdown | partially-closed | 工具窗口 Vue 化 + 全屏化；剩余 visualizer | visualizer | 是 | 2026-05-02 |
| SUN-3 | shutdown | closed | 自定义主题导入导出删除 | 主题系统 | 否 | 2026-05-02 |
| SUN-4 | shutdown | open | 旧 settings_ACU 处置 | data/service/runtime | 是 | 2026-05-02 |
| SUN-5 | shutdown | open | 旧 window-system.ts 废弃 | 工具窗口 | 是 | 2026-05-02 |
| SUN-6 | shutdown | closed | api-registry 接口扩展暂不做 | 对外 API | 否 | 2026-05-02 |
| SUN-7 | shutdown | open | 旧 presentation 文件删除清单 | 旧 UI 下线 | 是 | 2026-05-02 |
| SUN-8 | shutdown | open | api-registry 搬出 presentation | 对外 API | 是 | 2026-05-03 |
| X-1 | cross-stage | open | 双产物体积监控（30% 警戒线） | 每阶段收尾 | 否 | 2026-05-02 |
| X-4 | cross-stage | partially-closed | 组件统一性守护，防裸基础元素 | v2 页面 | 否 | 2026-05-04 |
| X-6 | cross-stage | closed | 正文替换升一级页 | 正文替换 | 否 | 2026-05-03 |
| X-7 | cross-stage | open | v2 全量 Vitest 并跑稳定性 | 测试/CI | 否 | 2026-05-09 |
| G-1 | gap | closed | AI 注入流程未在 v2 接通 | 外部导入/下线旧 UI | 否 | 2026-05-03 |
| G-2 | gap | open | ImportPage 真机目视验收 | 外部导入 | 否 | 2026-05-03 |
| G-3 | gap | open | PlotPage 真机目视验收 | 剧情推进 | 否 | 2026-05-03 |
| G-6 | gap | open | v2 测试版真实酒馆 smoke | 全部 v2 一级页 | 是 | 2026-05-09 |
| G-4 | gap | closed | PresetDropdown 复用形态 | 预设三件套 | 否 | 2026-05-03 |
| G-5 | gap | open | 默认任务名差异 | 剧情推进 | 否 | 2026-05-03 |
| D-API-PRESET-SERVICE | debt | open | API 预设管理逻辑下沉到 service 层 | API 预设/store/service | 否 | 2026-05-07 |
| D-SURFACE-CONTROL | debt | open | 表面层级与控件底色收敛 | v2 视觉系统 | 否 | 2026-05-18 |

---

## 详情

### P3-1. 12 状态枚举中文文案表
**2026-05-09 已关闭**：交火模式页已在 [useVectorIndexConfig.ts](../../src/presentation-v2/composables/useVectorIndexConfig.ts) 中落地状态文案与 badge variant。覆盖 building / uploading / ready / missing / corrupt / incompatible / upload_failed / rebuild_required / delete_pending / delete_failed / superseded / 未加载。

### P3-2. 移动端栅格断点与降级规则
**2026-05-18 已关闭**：移动端规则已从单页实现收敛为共享骨架。主应用导航在 720px 以下切为抽屉；一级功能页面板区统一使用 [AcuPanelGrid.vue](../../src/presentation-v2/components/_lib/AcuPanelGrid.vue)，默认 860px 以下单列、`collapse-at="lg"` 支持 1080px 以下单列，并固定 `align-items: stretch`；长配置页补充 [AcuMobilePanelNav.vue](../../src/presentation-v2/components/_lib/AcuMobilePanelNav.vue) 作为移动端面板跳转。约束已升格到 [02-principles.md](02-principles.md) §9 / §17 / §19，并有 `acu-panel-grid.test.ts`、`acu-mobile-panel-nav.test.ts` 与 `panel-grid-conventions.test.ts` 覆盖。

真实移动端目视验收不再作为本设计问题阻塞，统一归入 [G-6](#g-6-v2-测试版真实酒馆-smoke) 的全量 smoke。

### P3-4. Sidebar 一级页可见性的设置项
**2026-05-18 已关闭**：Sidebar 不再单独承载一组“隐藏页面”配置。当前采用两层可见性：一是 [ui-mode-store.ts](../../src/presentation-v2/stores/ui-mode-store.ts) 的基础模式 / 高手模式，基础模式只显示“基础配置”，高手模式恢复完整工作台；二是 [page-registry.ts](../../src/presentation-v2/router/page-registry.ts) 的 feature gate / `visibleWhen`，剧情推进、正文替换、交火模式与开发者页按运行状态显示。切换入口放在 Sidebar 顶部，开发者页仍由仪表盘“启用开发者选项”控制。

后续如需“自定义隐藏任意一级页”，应另开新需求，不再挂在 P3-4。

### P3-5. 各功能页内部布局
**2026-05-09 已关闭**：填表、手动填表、智能续写、数据管理、正文替换、SQL、运行日志、交火模式均已落为真实 v2 页面。

**2026-05-15 修订**：手动填表不再保留独立一级页，已作为等宽面板并入"更新参数"页，减少执行前来回切换配置的路径成本。

### P3-6. 填表提示词预设升级的迁移
**2026-05-09 已关闭（方案修订）**：填表提示词不升预设库，保持单一提示词组，迁入侧抽屉编辑，并保留 JSON 导入 / 导出 / 恢复默认。该修订已同步到 [00-charter.md](00-charter.md) 的 D13 与更新参数页说明。

### P-VI-1. VectorIndexPage 新配置字段接入
**2026-05-09 已关闭**：[VectorIndexPage.vue](../../src/presentation-v2/pages/VectorIndexPage.vue) 已接入交火模式状态、维护操作、关键词 API、关键词提示词、召回参数和归档分块字段。高级参数受开发者选项 gate 控制；embedding / rerank 仍归 API 页。

迁移说明：旧开放问题文档中这条曾使用 `P3-7`，与阶段 3 剧情推进页的 `P3-7` 决议撞号。拆分后改名为 `P-VI-1`，保留提出日期与内容不变。

### SUN-1. toast / custom-confirm Vue 化
[charter D14](00-charter.md) 选择 A 推迟。“下线旧 UI 时”在这里不是指等旧 UI 文件全部删除后才开始，而是指：v2 主界面已覆盖主要功能，只剩 toast / confirm / 可视化表格编辑器等少数表层能力仍沿用旧实现的收尾时间点。当前已经进入这个时间点。

**2026-05-18 修订**：v2 toast 先行落地，作为 `src/presentation-v2/**` 内部能力实现，不复用旧 `src/presentation/theme/toast` / `showToastr_ACU`，也不要求同阶段完成 custom-confirm。旧 UI 全项目 `showToastr_ACU` / `customConfirm` 调用替换、旧 toast 删除，仍保留为旧 UI 下线清理项。

**2026-05-21 修订**：v2 toast / confirm / input dialog 表层试做已回滚，当前实现层不保留新 toast 痕迹。toast 的下一步收窄为 v2 主界面内短反馈：不接管旧 `showToastr_ACU`，不做常驻全局 layer，不要求 v2 关闭时仍显示新 toast；旧 runtime / 旧 UI 全局反馈后续在下线旧 UI 时重新处理。

**2026-05-11 补充**：toast 核心原则：实时保存普通参数成功不 toast；显式保存 dirty 草稿、导入/导出摘要、复杂失败短反馈使用 toast；警告/错误详情进入运行日志；局部 `AcuMessage` 只保留可修正或需持续展示的信息。

**当前实现审计**：截至 2026-05-21 回滚后，`src/presentation-v2/` 不保留 `toast-store` / `confirm-store` / `input-dialog-store` 及对应 viewport。SUN-1 保持 open：v2 面板内 toast 尚待重做；旧 `showToastr_ACU` 仍是旧 runtime / 旧 UI 的主要入口，暂不通过 v2 toast 收敛；visualizer 与旧 UI 删除也尚未完成。

### SUN-2. 工具窗口 Vue 化 + 全屏化
**2026-05-09 部分关闭**：SQL 控制台和运行日志已 Vue 化为 v2 全屏一级页。剩余阻塞项是 visualizer：体量大（[visualizer.ts](../../src/presentation/pages/visualizer.ts) 等多文件），且承担 DDL 编辑、SQLite 模式、模板 AI 助手挂载（[实现地图 §2.5](01-architecture-map.md)），全屏化时需一起迁移。

### SUN-3. 自定义主题导入导出
**2026-05-19 已关闭**：v2 主题菜单已支持自定义主题导入、导出和删除。格式采用 v2 自有 JSON：`kind: "acu-v2-theme"`、`version: 1`、`theme.tokens` 只包含 v2 稳定 token；导出内置主题时不携带 custom id，可作为新自定义主题模板导入。旧 `ACUThemeFile` 不兼容，符合 [charter D14](00-charter.md) 的丢弃决策。

### SUN-4. 旧 settings_ACU 处置
data / service 层有大量代码读 `settings_ACU`，全部改造成本巨大。是否完全移除，还是保留作为新 store 的 storage adapter？关系到 [charter D1](00-charter.md) "presentation 层重写但不动业务层"原则的边界。

### SUN-5. 旧 window-system.ts 废弃
[charter D15](00-charter.md) 说下线旧 UI 时一并废弃。2026-05-18 审计：`src/presentation-v2/**` 已不依赖 `window-system.ts`；剩余依赖集中在旧主弹窗与 visualizer（如 [visualizer.ts](../../src/presentation/pages/visualizer.ts)、`visualizer-main-*`、旧 `main-popup.ts`）。该项阻塞仍绑定 SUN-2 / SUN-7：visualizer Vue 化和旧主弹窗删除前不能关闭。

### SUN-6. api-registry 接口扩展
**2026-05-18 已关闭**：当前不为 v2 新增对外深链或页面跳转 API。页面切换只作为 [router-store.ts](../../src/presentation-v2/stores/router-store.ts) 内部状态使用；旧 `api-registry` 对外契约保持不动，搬迁位置由 [SUN-8](#sun-8-api-registry-搬出-presentation下线前置) 单独跟踪。未来如果真实外挂需要 `openV2Page(id)` / `setActivePage(id)`，应作为新 API 需求重新评审。

### SUN-7. 旧 presentation 文件删除清单
预期范围：`pages/main-popup-*.ts`（除 visualizer）、`pages/popup-bindings-*.ts`、`pages/popup-helpers.ts`、`state/ui-refs.ts`、`triggers/settings-ui-sync/*`（先拆出仍属于运行时的部分，见 [实现地图 §2.8](01-architecture-map.md)）、`triggers/auto-loop.ts` / `update-trigger.ts` / `update-process.ts` / `import-process.ts`（DOM 胶水部分删；流程逻辑视情况搬到 `service/flows/` 或在 v2 composable 已重写后整段删）、旧主题相关 `theme/theme-registry.ts` / `theme-selector.ts` / 4 个 builtins。**何时**：下线决策落地后。

### SUN-8. api-registry 搬出 `presentation/`（下线前置）
`src/presentation/bootstrap/api-registry.ts` 与 `api-groups/*` 是对外契约，不是 UI。**倾向位置**：`src/host-api/`（与 service / data / shared 同级）。搬迁要以"目录改名 + 旧路径暂时 re-export"做，或确认外部插件读取的是函数本体而非 import 路径。**何时**：下线旧 UI 决策前必须完成，否则 SUN-7 删 `presentation/` 时会破坏外部契约。

**2026-05-18 审计**：入口文件仍直接 import `./presentation/bootstrap/api-registry`，尚无 `src/host-api/` 目录；该项保持 open。

### X-1. 双产物体积监控
每阶段末测一次产物大小，超出基线 30% 时警告。**状态**：持续执行中，追踪表见 [metrics.md](metrics.md)。最近完整记录仍是 2026-05-09“主弹窗覆盖审查”；当前工作区已进入 toast / 表面层级 / 基础模式等收尾改动，下一次构建收尾时应补采三产物 raw/gzip。

### X-4. 组件统一性守护（防裸基础元素）
**2026-05-18 部分关闭**：业务页和表单控件基本已回写到 `_lib/` 组件，`check-arch` 也已增加部分 v2 控件守护：禁止 `_lib` 隐藏 checkbox/radio、禁止 clipped focusable controls、禁止页面手写非等宽 panel columns；本次运行 `node scripts/check-arch.mjs` 为 0 违规。

仍未完全关闭的原因：尚未加“所有非 `_lib` `.vue` 禁止裸 `<input>` / `<button>` / `<select>`”的强规则；当前裸 `<button>` 仍存在于 [App.vue](../../src/presentation-v2/App.vue)、[Sidebar.vue](../../src/presentation-v2/components/Sidebar.vue) 等 shell 级组件，需决定这些是否改用 `AcuButton` / `AcuIconButton`，或作为明确例外写入架构守卫。

### X-6. 正文替换升一级页（P3-15 后续）
**2026-05-09 已关闭**：[ContentReplacePage.vue](../../src/presentation-v2/pages/ContentReplacePage.vue) 已升为 v2 一级页；入口仍保留旧的 `loopSettings.maxRetries === 49` 解锁条件和正文替换自身 enabled gate。

### X-7. v2 全量 Vitest 并跑稳定性
2026-05-09 验证时，`npm test -- --run tests/presentation-v2` 一次性全量运行会出现 Vitest 超时 / DOM 未挂载类失败；同一失败文件单独或小批次重跑通过。判断为测试隔离或并发稳定性问题，不代表页面实现必然失败。**2026-05-18 复验**：同一命令 4 分钟未结束并超时，债务仍存在。**何时**：测试版发布前可接受为已知测试债务；进入 CI 阶段前需修复或调整测试运行策略。

### G-1. AI 注入流程未在 v2 接通（阶段 2 缺口）
**2026-05-09 已关闭**：外部导入注入流程已在 [useImportFlow.ts](../../src/presentation-v2/composables/useImportFlow.ts) 中接到 `service/table/update-orchestrator` 的纯业务入口，不再回旧 `presentation/triggers/update-process.ts`。

### G-2. ImportPage 真机目视验收（阶段 2 缺口）
jsdom 通过，真实 SillyTavern 中 split / clear / delete / 完整注入流程未目视验收。仍归入 G-6 的全量 smoke，但保留本条用于追踪外部导入主路径。

### G-3. PlotPage 真机目视验收（阶段 3 缺口）
jsdom 通过，真实 SillyTavern 中"切预设 / 抽屉编辑 / 关闭重开 / 基础模式复用剧情预设面板"流程未目视验收。仍归入 G-6 的全量 smoke，但保留本条用于追踪剧情推进主路径。

### G-4. PresetDropdown 复用形态（阶段 3 缺口）
**2026-05-08 已关闭**：`AcuPresetDropdown` 已升级为通用预设下拉，支持旧 `{name, meta}` 与新 `{value, label, meta}` 形态，并由 API、剧情推进、表格模板三处直接消费；剧情页不再使用 API 预设形状 shim。

### G-5. 默认任务名差异（阶段 3 缺口）
`normalizePlotTasks_ACU` 兼容旧数据时默认兜底为"默认任务"，v2 抽屉中新建任务使用"剧情任务N"。当前测试只断言名称包含“任务”，未强制统一。该差异不影响运行，但会造成默认任务命名来源不一致；若不再要求统一，可在后续直接关闭。

### G-6. v2 测试版真实酒馆 smoke
2026-05-09 代码侧覆盖审查通过后，仍需在真实 SillyTavern / TavernHelper 环境中跑一轮测试版 smoke。2026-05-18 更新后的重点：打开 / 关闭 v2、基础/高手模式切换、切聊天刷新、外部导入完整注入、剧情推进预设编辑、基础配置页四面板、手动填表、交火构建、SQL 查询、运行日志筛选、移动端导航与移动端面板跳转。该项阻塞“面向测试人员发布测试版”的最终打包确认，但不阻塞继续开发。

### D-API-PRESET-SERVICE. API 预设管理逻辑需要下沉到 service 层
**问题**：API 预设的 CRUD、默认预设、当前聊天绑定、删除引用清理等规则当前集中在 [api-preset-store.ts](../../src/presentation-v2/stores/api-preset-store.ts)；service 层只提供运行时按名称解析（如 `getApiConfigByPreset_ACU` / `resolveCurrentChatApiPresetName_ACU`），不是完整预设管理服务。

**风险**：Pinia store 承担业务规则与 settings schema 归一化职责，边界偏厚；删除预设时需清理填表 / 剧情推进 / 正文替换 / 交火关键词等多处引用，新增 override 容易漏改；其他入口若需管理预设可能复制 store 规则或错误依赖 presentation-v2；settings 形状迁移隐藏在 UI store 的 refresh 流程中。

**后续方向**：新增 `service/ai/api-preset-service.ts` 或 `service/settings/api-preset-service.ts`，把预设归一化、增删改、默认项、当前聊天绑定、引用清理迁入 service。v2 store 只保留响应式包装和 UI 状态。迁移时保留现有 settings 字段契约：`apiPresets`、`defaultApiPresetName`、`apiPresetBindingsByChat`、`tableApiPreset`、`plotApiPreset` 等。

**测试版处理**：不阻塞 2026-05-09 的并行测试版。填表提示词已按单一提示词编辑器落地，避免复制 API 预设当前的架构债务；API 预设服务下沉仍作为后续架构债务保留。

### D-SURFACE-CONTROL. 表面层级与控件底色收敛
**问题**：`--acu-bg-2` 同时被控件底色、弱按钮、内嵌静态表面和说明块使用，导致浅色主题下输入框放进同色容器后边界不清，也造成面板内“卡片套卡片”的视觉噪音。

**当前方案**：先做 P1/P2：移除吞掉控件的静态内嵌表面，扁平化 `AcuInfoBanner` / 说明块 / 只读摘要；不在本轮重写主题系统，不给输入控件新增边框。P3/P4 再逐页清理并收敛 token。

**验收重点**：浅色/深色主题下 FormFill、API、剧情预设抽屉、面板 description、下拉和按钮 hover/focus 都能区分控件与静态信息块；页面不再出现明显卡片嵌套。

---

## 历史附录：已关闭条目

<details><summary>阶段 1：API 侦察页（P1-1 ~ P1-5，随实现落地）</summary>

- P1-1 API 页内部布局 → 阶段 1 实现时确定
- P1-2 useApiPresetStore state shape → 阶段 1 实现时确定
- P1-3 侧抽屉形态 → 右侧滑入 480px + dim，移动端全屏 sheet
- P1-4 "标记为活动 API" UI → 阶段 1 实现时确定
- P1-5 预设导出格式契约 → 阶段 1 实现时确定

</details>

<details><summary>阶段 2：第二页 + 组件提取（P2-1 ~ P2-3 → D21；D7 撤销 → 删除 P3-3）</summary>

阶段 2 启动决议（2026-05-03）：P2-1 / P2-2 / P2-3 锁定为 D21。

</details>

<details><summary>阶段 3+：仪表盘重构（P-DB-* 全部决议落定 → 2026-05-07，P-DB-7 于 2026-05-08 由 D24 修订）</summary>

详见仪表盘开发者页相关实现与测试。

</details>

<details><summary>阶段 3：剧情推进页（P3-7 ~ P3-16 全部决议落定 → D23）</summary>

`P3-3 触发式按钮"集中识别"` 已于 2026-05-03 撤销，降级为操作区布局惯例（[charter D7](00-charter.md) / [02-principles §15](02-principles.md)）。`P3-9` 对应"剧情推进不留空操作区"，已并入 [02-principles §15](02-principles.md) 的 D21.8 修订。

</details>

<details><summary>X-2 / X-3 / X-5（已确认惯例）</summary>

- **X-2 测试模板与覆盖率**：阶段 1-2 中已确立三档测试范式（store / composable / 页面集成），见 `tests/presentation-v2/`。
- **X-3 D17 中间层守护**：`scripts/check-arch.mjs` 已在阶段 2 实施 D17 + D21.2 双规则守护，每次验证 0 违规。
- **X-5 service 层契约稳定性**：composable 层做适配，service 层非必要不动。阶段 2-3 均按此执行。

</details>
