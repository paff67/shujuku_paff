# UI v2 实现地图

> 用于检索定位旧 UI、业务层边界和 v2 一级页归属；不承载阶段决议。

### 2. 当前 UI 实现地图（用于检索定位，已按 3.4.1 代码校准）

#### 2.1 技术栈

- 构建：**Rollup 4** + `@rollup/plugin-typescript`，双产物（油猴 IIFE / 酒馆扩展 ESM）
- 语言：TypeScript 5.7
- 运行时依赖：jQuery（来自酒馆宿主环境）、sql.js 1.14.x
- 前端框架：**无**
- 测试：Vitest
- 样式：CSS 字符串内联在 TS 模块中（如 `main-popup-styles.ts`）+ 内联 style

#### 2.2 入口

| 路径 | 作用 |
|---|---|
| `src/index.ts` | 油猴脚本入口；按层导入 shared / data / service / presentation，最后在 jQuery ready 中调用 `mainInitialize_ACU()`，并通过 `checkAndMarkInstance()` 防重复加载 |
| `src/entry-extension.ts` | 酒馆扩展入口；先 `_forceExtensionMode()`，等待 TavernHelper / SillyTavern.getContext 就绪后调用 `mainInitialize_ACU()`，并初始化可视化模板助手 addon |
| `src/entry-extension-plus-assistantembedded.ts` | plus 包装入口；先导入原扩展入口，再额外挂载 template-assistant addon，供嵌入助手构建使用 |
| `src/presentation/bootstrap/init.ts` | 启动初始化 |
| `src/presentation/bootstrap/startup.ts` | 在酒馆 `#extensionsMenu` 里挂菜单按钮，点击触发 `openAutoCardPopup_ACU()` |

#### 2.3 主弹窗（7 个一级入口，4 个分组）

`src/presentation/pages/main-popup.ts` 在 sidebar 中已经使用 4 个分组：

```
概览：仪表盘
配置：更新 / API / 表格
功能：核心功能 / 数据管理
工具：高级工具
```

| 路径 | 作用 |
|---|---|
| `src/presentation/pages/main-popup.ts` | 主弹窗组装入口；PC 端表现为左侧 sidebar，分组通过 `acu-nav-section-title` 渲染 |
| `src/presentation/pages/main-popup-styles.ts` | 主弹窗整体样式骨架（CSS 字符串）；PC 为 200px 左栏，窄屏变横向滚动导航 |

7 个一级入口各自的 HTML 生成器：

| 路径 | 对应一级入口 | 分组 |
|---|---|---|
| `pages/main-popup-status.ts` | 仪表盘 | 概览 |
| `pages/main-popup-update.ts` | 更新 | 配置 |
| `pages/main-popup-api.ts` | API | 配置 |
| `pages/main-popup-table.ts` | 表格 | 配置 |
| `pages/main-popup-plot.ts` | 核心功能（剧情推进 + 智能续写 + 外部导入嵌入区块） | 功能 |
| `pages/main-popup-datamgmt.ts` | 数据管理 | 功能 |
| `pages/main-popup-advanced.ts` | 高级工具壳（含子 tab 切换） | 工具 |

3.4.1 当前内容归属：

| 一级入口 | 当前承载内容 |
|---|---|
| 仪表盘 | 数据库状态、快速手动更新、手动更新表选择、核心功能开关、表格存储模式（原生 / SQLite） |
| 更新 | 自动更新参数、内容筛选规则、填表任务提示词 |
| API | 自定义 API / 酒馆连接预设模式、流式开关、模型加载、API 预设管理 |
| 表格 | 表格模板预设（全局 / 当前聊天）、世界书注入、交火模式纪要索引参数、可视化表格编辑器入口、立即构建交火纪要索引 |
| 核心功能 | 剧情推进、剧情任务列表与并发阶段、智能续写循环、剧情世界书选择、外部 TXT 导入 |
| 数据管理 | 数据隔离、备份与恢复、删除与清理、交火模式索引状态 / 缓存 / 外置资产管理 |
| 高级工具 | 正文替换（受隐藏条件控制）、SQL 控制台（仅 SQLite 模式）、运行日志 |

嵌入页 / 子页面 HTML 生成器：

| 路径 | 当前挂载位置 |
|---|---|
| `pages/main-popup-import.ts` | 嵌入 `main-popup-plot.ts` 的核心功能页内部，不是一级入口 |
| `pages/main-popup-optimization.ts` | 高级工具 - 正文替换子页面；DOM 默认生成，但 `popup-helpers.ts` 会按隐藏条件控制入口显示（当前条件为剧情推进循环最大重试次数等于 49），重构需保留这类 feature gate |
| `pages/sql-console.ts` | 高级工具 - SQL 控制台子页面，仅 SQLite 模式下显示 |
| `pages/log-viewer.ts` | 高级工具 - 运行日志子页面 |

已确认的遗留死代码（无任何文件 import 其导出函数）：

- `pages/main-popup-data.ts` — 导出 `generateDataTabHTML()`，0 处引用；功能已被 `main-popup-datamgmt.ts` 取代
- `pages/main-popup-prompt.ts` — 导出 `generatePromptTabHTML()`，0 处引用；功能已被 `main-popup-update.ts` 内的提示词区块取代
- `pages/main-popup-worldbook.ts` — 导出 `generateWorldbookTabHTML()`，0 处引用；功能已分散到 `main-popup-table.ts` 等页面内的世界书选择器

#### 2.4 主弹窗交互绑定（jQuery + ui-refs 模式）

| 路径 | 作用 |
|---|---|
| `pages/popup-bindings.ts` | 绑定主入口 |
| `pages/popup-bindings-status.ts` | 仪表盘绑定；包含存储模式切换、更新参数按钮、核心开关等 |
| `pages/popup-bindings-plot.ts` | 核心功能绑定；包含剧情推进、剧情任务、智能续写、外部导入等 |
| `pages/popup-bindings-data.ts` | 数据管理 + 表格工具绑定；包含数据隔离、备份恢复、可视化编辑器入口、交火索引状态 / 清缓存 / 删除 / 手动构建 |
| `pages/popup-bindings-worldbook.ts` | 表格页世界书注入与交火模式配置绑定 |
| `pages/popup-bindings-optimization.ts` | 正文替换绑定 |
| `pages/sql-console.ts` | SQL 控制台 HTML 与绑定同文件 |
| `pages/log-viewer.ts` | 运行日志 HTML 与绑定同文件；需在窗口关闭时清理订阅 |
| `pages/popup-helpers.ts` | 绑定辅助 |
| `state/ui-refs.ts` | jQuery DOM 引用集中存放（旧体系核心，新 UI 不沿用） |

#### 2.5 可视化表格编辑器（独立窗口）

| 路径 | 作用 |
|---|---|
| `pages/visualizer.ts` | 编辑器主入口 |
| `pages/visualizer-styles.ts` | 编辑器样式 |
| `pages/visualizer-main-render.ts` | 主体渲染 |
| `pages/visualizer-main-config.ts` | 配置部分 |
| `pages/visualizer-main-save.ts` | 保存逻辑 |
| `pages/visualizer-sidebar.ts` | 侧栏 |
| `pages/visualizer-template-assistant.ts` | 模板 AI 助手主体 |
| `pages/visualizer-template-assistant-apply.ts` | 模板应用 |
| `bootstrap/visualizer-template-assistant-addon.ts` | 模板助手 addon 注册 |

> 可视化编辑器已经不是单纯表格编辑窗口：3.4.1 中还承担 DDL 编辑、SQLite 模式支持、保存时交火纪要索引归档，以及模板 AI 助手挂载点。新 UI 重构若保留独立编辑器形态，需要把这些入口一起迁移。

#### 2.6 共享 UI 基础设施

窗口系统（外壳、拖拽、缩放）：

| 路径 | 作用 |
|---|---|
| `window/window-system.ts` | 窗口实例创建（`createACUWindow()` 等） |
| `window/window-styles.ts` | 窗口样式 |

主题系统（同时影响主弹窗、所有自定义窗口、toast、confirm、visualizer）：

| 路径 | 作用 |
|---|---|
| `theme/theme-registry.ts` | 主题注册表与 token |
| `theme/theme-selector.ts` | 主题选择 UI |
| `theme/theme-types.ts` | 主题类型 |
| `theme/builtins/*.ts` | 内置主题（默认明 / 暗 / 经典墨 / 经典丝） |
| `theme/toast.ts` | 自定义 toast |
| `theme/custom-confirm.ts` | 自定义 confirm |

通用：

| 路径 | 作用 |
|---|---|
| `presentation/dom-utils.ts` | jQuery 封装与 DOM 工具 |
| `presentation/component-base.ts` | 组件基类约定 |

#### 2.7 跨页面复用组件

| 路径 | 作用 |
|---|---|
| `components/optimization-ui/index.ts` | 正文优化 UI 汇总导出 |
| `components/optimization-ui/optimization-ui-diff.ts` | 正文优化 diff 展示 |
| `components/optimization-ui/optimization-ui-exec.ts` | 正文优化执行 |
| `components/optimization-ui/optimization-ui-overlay.ts` | 正文优化 overlay |
| `components/optimization-ui/optimization-ui-rules.ts` | 正文优化规则 |
| `components/plot-editors.ts` | 剧情提示词段落编辑器 |
| `components/plot-planning-ui.ts` | 剧情规划 UI |
| `components/template-preset-ui.ts` | 模板预设 UI |
| `components/worldbook-selector.ts` | 世界书选择器（已存在复用） |
| `components/table-selector.ts` | 表选择器 |
| `components/import-status-ui.ts` | 导入状态 UI |
| `components/status-display.ts` | 状态展示 |
| `components/update-status-display.ts` | 更新状态展示 |
| `components/remote-memory-archive-progress.ts` | 远记忆归档进度 |
| `components/summary-vector-index-ui.ts` | 交火模式发送前召回的 UI 包装（进度 toast / 结果提示） |
| `components/pipeline-ui-helpers.ts` | 流水线 UI helper |
| `components/settings-ui-helpers.ts` | 设置 UI helper |

#### 2.8 业务-UI 同步层（settings 改动后同步到旧 UI）

| 路径 | 作用 |
|---|---|
| `triggers/settings-ui-sync/index.ts` | 同步入口 |
| `triggers/settings-ui-sync/settings-ui-config.ts` | 配置同步 |
| `triggers/settings-ui-sync/settings-ui-connect.ts` | 连接同步 |
| `triggers/settings-ui-sync/settings-ui-api.ts` | API 同步 |
| `triggers/settings-ui-sync/settings-ui-trigger.ts` | 触发同步 |
| `triggers/admin-ui.ts` | 管理 UI 触发 |
| `triggers/data-admin-ui.ts` | 数据管理 UI 触发 |
| `triggers/auto-loop.ts` | 自动循环（智能续写） |
| `triggers/import-process.ts` | 导入流程 |
| `triggers/update-trigger.ts` | 更新触发 |
| `triggers/update-process.ts` | 更新流程 |

> 这一层名称叫 settings-ui-sync，但当前职责混合了旧 UI 同步、宿主 API 初始化、API 配置 UI、自动更新触发、合并纪要兼容字段导入等内容。新 UI 不沿用其中的 DOM 同步机制，但不能把整个目录简单丢弃；需要先拆出仍属于运行时 / 业务触发的部分，再由 Vue 响应式状态接管 UI 刷新。3.4.1 中合并纪要手动 UI 已停用，但相关设置字段和自动合并服务仍可能被导入、导出或运行时读取。

#### 2.9 前端 API 注册

| 路径 | 作用 |
|---|---|
| `bootstrap/api-registry.ts` | 对外 API 注册中心 |
| `bootstrap/api-groups/callback-api.ts` | 回调 API 组 |
| `bootstrap/api-groups/core-data-api.ts` | 核心数据 API 组 |
| `bootstrap/api-groups/data-admin-api.ts` | 数据管理 API 组 |
| `bootstrap/api-groups/plot-preset-api.ts` | 剧情预设 API 组 |
| `bootstrap/api-groups/settings-config-api.ts` | 设置配置 API 组 |
| `bootstrap/api-groups/table-crud-api.ts` | 表格 CRUD API 组 |
| `bootstrap/api-groups/table-lock-api.ts` | 表格锁 API 组 |
| `bootstrap/api-groups/template-preset-api.ts` | 模板预设 API 组 |
| `bootstrap/api-groups/worldbook-ai-api.ts` | 世界书 AI API 组 |

> api-registry 对外暴露给酒馆宿主或其他扩展的 API 契约，新 UI 重构不应破坏这些接口。

#### 2.10 当前 7 tab 字段全清单

本节原始盘点来自 3.4.1 主弹窗字段清单；表格页 / 数据管理页中的“交火模式纪要索引”字段已按当前主线描述，不再沿用旧“远记忆总结管理 / Medusa 手动合并 UI”命名。

#### 2.11 不动层规模概览（shared / data / service）

以下三层在本次重构中保持原样，但新 UI 的 Vue 组件需要调用其中的函数，故在此记录规模和模块划分。

**shared 层**：常量、环境检测、宿主 API 代理、工具函数、HTML/JSON 辅助、日志缓冲（`log-buffer.ts`）、文本优化、模板预设工具、DDL 工具、表格存储 provider 接口、导入暂存等。

**data 层**：
- `gateways/` — AI、角色卡、聊天、宿主状态、世界书、向量 embedding、向量 rerank
- `models/`（3 文件）— settings-model、template-model、chat-message-data
- `repositories/`（3 文件）— isolation-repo、profile-repo、chat-message-data-repo
- `sqlite/`（4 文件）— schema-mapper、sql-normalizer、sqlite-engine、sync-bridge
- `storage/` — chat-history、config-storage、optimization-cache-storage、tavern-storage、交火索引临时缓存、ST 文件存储

**service 层**（65+ 文件）：
- `ai/`（6 文件）— API 调用、提示词构建（prompt-builder 子目录含 4 文件）
- `chat/`（1 文件）— 聊天服务
- `host/`（1 文件）— 宿主状态服务
- `import/`（1 文件）— 导入执行
- `loop/`（2 文件）— 循环控制 & 评估
- `optimization/`（1 文件）— 正文替换
- `plot/`（4 文件）— 剧情推进逻辑、编排、状态、向量召回
- `runtime/`（16 文件）— 状态管理器、消息处理、上下文标签/数据合并/表格锁等 helpers、剧情运行时（6 文件）、模板变量（7 文件）
- `settings/`（2 文件）— 设置服务 & 设置读取
- `summary/`（2 文件）— 纪要合并逻辑 & 执行
- `table/`（8 文件）— 表格服务、更新调度器/编排器、存储模式/策略、原生/SQL 适配器、表格历史
- `template/`（7 文件）— 模板预设服务、chat-scope 子目录（5 文件 + index）
- `template-assistant/`（3 文件）— 模板助手编译器、参考文档、服务
- `vector/` — 交火模式纪要索引的归档、运行时召回、状态、外置存储、临时缓存预热、类型定义，以及向量配置
- `worldbook/`（9 文件）— 注入引擎（主体 + config/custom/entries/order/state）、pipeline、清理、世界书服务

#### 2.12 入口文件与新 UI 入口

当前存在三个构建入口 / 包装入口：

| 入口 | 格式 | 特殊行为 |
|---|---|---|
| `src/index.ts` | IIFE（油猴） | 依赖 `checkAndMarkInstance()` 防重复加载；在 jQuery ready 后启动 |
| `src/entry-extension.ts` | ESM（酒馆扩展） | 额外调用 `_forceExtensionMode()`；等待 TavernHelper / SillyTavern.getContext 就绪；启动模板助手 addon |
| `src/entry-extension-plus-assistantembedded.ts` | ESM 包装入口 | 先导入原扩展入口，再挂载模板助手 addon，用于 plus assistant embedded 构建 |

新 UI 引入后，上述入口的 presentation 层导入部分都需要指向新的 Vue 入口模块或兼容桥；shared / data / service 层导入保持原有边界。不能只改 `index.ts` 和 `entry-extension.ts`，否则 plus embedded 构建会继续拉起旧 UI。

2026-05-09 当前状态：

- `src/index.ts` 与 `src/entry-extension.ts` 已在旧 UI 初始化后调用 `bootstrapAcuV2()`，新旧入口并存。
- `src/entry-extension-plus-assistantembedded.ts` 通过包装 `entry-extension.ts` 间接获得 v2 入口。
- v2 一级页已覆盖旧主弹窗主要功能面。
- 下线旧 UI 前仍需搬迁 `presentation/bootstrap/api-registry.ts` 与 `api-groups/*`，见 [open-questions SUN-8](open-questions.md)。

---

> v2 一级页清单与各页骨架见 [00-charter.md §4](00-charter.md#4-一级页清单)。本文件仅承载旧 UI 实现地图，不复述新 UI 决策。
