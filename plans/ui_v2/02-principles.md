# UI v2 开发原则

> 每次编辑 `src/presentation-v2/` 前先读本文或触发 `.claude/skills/ui-v2-principles/SKILL.md`。本文只放会反复约束落地的规则。

**设计基调**：专业工具质感。以清晰的结构、收敛的色彩、干脆的交互为核心，通过排版的秩序感和微交互的准确性来建立高级感，而非通过装饰性视觉元素。

---

## 1. 视觉层次必须显式设计

页面不能只有"内容"，必须有**视觉节奏**——用户的视线需要有锚点。

- 标题区的字号/字重必须与正文拉开明显差距（至少 1.5 倍以上的字号比）
- 页面内不同区块之间要有**间距梯度**：标题区 → 摘要区 → 列表区 → 操作区，间距逐层变化，不能全部使用相同的 gap
- 同一层级的元素用相同样式，不同层级的元素必须有可感知的视觉区分（背景色、边距、字号三者至少变一个）

**反面案例**：全页从上到下都是 `padding: 16px` + `gap: 14px` + `font-size: 13px`，视觉上一片粥。

---

## 2. 卡片/列表项需要"可交互"的暗示

用户看到一个矩形区域时，必须能在 0.3 秒内判断出"这是静态展示"还是"可以点击/操作"。

- 可交互的卡片必须有 **hover 态**（背景色变化、微抬升 shadow、或 border 加深），仅靠 cursor: pointer 不够
- 选中/活动态不能只靠 border-color 变化——人眼对 1px 线条颜色的感知很弱。至少附加一项：背景色变化、更大面积的 glow、完整内描边、文字/图标色阶变化、或状态徽章
- **选中/活动态禁止使用左侧粗线强调**。左侧色条容易把列表项误读成警告/引用块，也会在紧凑工具界面里制造不必要的方向性装饰；需要强调当前项时，优先使用整项背景高亮、完整 focus/active ring、accent 底色、分段控件滑块或明确的状态徽章
- 操作按钮（编辑/删除）如果平时都可见，会造成视觉噪音；考虑 hover 时才完全显示，或者用低对比度默认 + hover 加深
- **区块分割优先用边框或浅底色差异**，而非阴影。阴影仅用于真正浮在页面之上的元素（下拉菜单、模态框、tooltip），用来表达 Z 轴层级关系
- **圆角收敛在 4-8px**。过大的圆角（16px+、胶囊状）会削弱工具的紧凑感和严谨感

---

## 3. 按钮系统要有一致的设计语言

- 所有按钮必须有 `transition`（至少 `background` 和 `border-color`，建议 `0.15s ease`）。没有过渡的按钮点击感觉像坏了
- 按钮至少分三个层级并保持全局一致：
  - **Primary**：强调色底 + 白字，用于页面主操作（每屏最多 1-2 个）
  - **Secondary/Default**：边框底 + 常规文字，用于次要操作
  - **Danger**：默认态低调，hover 时才显示红色底（避免页面"到处都是红色警告"）
- 图标按钮不要用裸 emoji/文字字符（★☆×），应使用 SVG 或 icon font，保证不同平台渲染一致

---

## 4. 表单控件必须有 focus 状态

浏览器原生 input/select 的 focus outline 在深色主题下几乎不可见。

- 每个 input/select/textarea 必须自定义 `:focus` 样式：`border-color` 变为 accent + `box-shadow` 做 focus ring
- 自绘 button 型控件（如下拉触发器、分段选择、checkbox/radio/toggle）使用 `:focus-visible` 展示 focus ring；触屏或鼠标点击后的普通 `:focus` 不应残留视觉外框
- focus 样式必须有 `transition`，突然出现的 ring 显得廉价
- checkbox/radio 如果在可见区域使用，需要自定义样式（toggle switch / 自定义 radio dot），原生控件在深色主题和不同系统下表现差异太大

---

## 5. 面板/抽屉/弹层必须有出入场动画，但要克制

没有动画的弹出层会让用户产生"页面闪了一下"的感觉，降低对工具的信任感。但动效不能喧宾夺主——专业工具的动画应当干脆利落。

- 遮罩层（overlay/dim）必须有 opacity fade（0.15-0.2s）
- 抽屉/侧面板必须有 slide 动画，使用简单的 `ease-out`（进入）和 `ease-in`（退出）即可
- **全局过渡时长控制在 100-200ms**。消费级产品可能用 300ms 甚至更长，但专业工具需要更快的节奏
- **不使用弹性/回弹动画**（spring / bounce），那会显得不够严肃
- 如果框架支持，关闭时也应有反向动画（Vue 用 `<Transition>` 可以低成本实现）

---

## 6. 需要微交互反馈

用户每一次操作都应该有即时视觉反馈，即使只是一个微小的动画。但动效的目的是告诉用户"操作已收到"或"状态已改变"，不是为了纯粹的视觉愉悦。

- **加载态**：任何超过 200ms 的异步操作必须显示 spinner 或 skeleton，不能只放一行文字"加载中"
- **成功态**：保存成功后的提示应该有 fade-in 动画，不要瞬间出现
- **开关/切换**：toggle 控件必须有滑动过渡，不能是 checkbox 的瞬间勾选
- **Segmented Control**：选中项需要有明确的视觉标记（背景高亮 + 滑块过渡），不能只靠 radio 的原生圆点
- 如果一个动画去掉后用户不会感到任何信息损失，说明它是装饰性的，应该移除

---

## 7. 色彩对比度和层次

- 同一页面内不要出现超过 3 个层级的背景色（`bg-0` / `bg-1` / `bg-2` 够用了），否则会变得混乱
- hover/pressed 不使用“背景层级 +1”表达；普通 hover 使用 `--acu-hover-overlay`、文字色变化、轻量阴影或明确的 active/accent 状态
- 文字颜色严格分层使用：
  - `text-1`：标题和关键信息
  - `text-2`：正文和表单标签
  - `text-3`：辅助说明、时间戳、占位符
- 全站只维护**一种 accent 色**，仅用于"当前活动项标记"、"Primary 按钮"和"Focus Ring"。如果到处都是 accent 色则失去引导作用
- danger/warning/success 色只在需要传达状态语义时使用，不要用作装饰
- **深色模式下语义色需要降低饱和度**。高饱和度的红/绿/黄在深色背景上非常刺眼；可以用降低亮度/饱和度的暗色版本配合亮色文字或图标，或者仅用这些颜色做细指示条而非大面积色块

---

## 8. 排版细节

- 页面内的字号应该形成明确梯度，建议：页标题 ≥ 22px → 区块标题 15-16px → 正文/标签 13px → 辅助文字 11-12px。如果多个层级用同一个字号，层次感会消失
- 标签与其对应值之间的间距要足够小（紧耦合），不同字段之间的间距要足够大（松耦合）——这是格式塔的接近性原则
- 长文本（如 endpoint URL、model name）必须处理溢出：`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`，或 `word-break: break-all`
- 数字输入（max_tokens / temperature）建议限制输入框宽度，不要让一个数字字段独占整行
- **数据型文本使用等宽字体**：ID、API Key、Endpoint URL、token 数值、参数值等应使用 monospace 字体（Consolas / Menlo / 系统等宽栈）。等宽字符天然具备对齐的秩序感，也能帮助用户区分"这是数据"和"这是说明文字"
- **数值列右对齐**：在列表或表格中涉及数值时（温度、token 数、体积），采用右对齐方便用户做位数的视觉比较

---

## 9. 响应式不是"一个断点切单列"

- 至少需要两个断点思路：
  - **紧凑态**（< 768px）：单列、抽屉全屏、sidebar 折叠
  - **舒适态**（≥ 1024px）：双列/多列布局
  - 中间地带（768-1024px）应该有适当的过渡策略，而不是在某个点突然变化
- 双列网格的 `minmax()` 值要合理——如果最小宽度设得太大（如 360px），中等屏幕下两列会被挤得很丑而不是优雅降级
- 抽屉在移动端应该变成全屏 sheet，不能保留 PC 端的侧边窄条形态

---

## 10. 信息密度

消费级 App 偏好大量留白，但专业工具的用户通常希望一屏内看到更多信息。

- 不需要害怕紧凑的布局。只要通过第 1 条的"字号/字重对比"和"间距梯度"做好了视觉层级，即使用户在一个屏幕内看到很多参数和表单，也不会觉得杂乱
- 留白应该用于**区分不同逻辑区块**（区块间 gap 大），而不是在每个元素周围均匀撒一圈空白（元素内 padding 应当克制）
- 避免为了"看起来高级"而人为降低信息密度（比如一个开关独占一整行 + 大量上下 margin）。用户打开设置面板是为了高效完成配置，不是欣赏排版

---

## 11. 不要让功能原型变成最终形态

阶段式开发中最常见的问题是：先写了一个"能用的"样式，然后就再也没有回来改过。

- 每个页面实现完功能后，**必须做一轮纯视觉 review**，专门审查以上 1-10 条
- 不要等所有页面都写完再统一"美化"——到那时积累的视觉债务量会让人不想动
- 阶段 2 提取 `_lib/` 基础组件时，组件的默认样式就应该是"精致版"，不是"先凑合版"

---

## 12. 页面 header 仅承载标题与状态徽章

`AcuPageHeader` 的右侧（`#actions` slot）**不放任何触发型控件**。包括但不限于：

- 刷新 / 重载按钮（应由 store / composable 自动响应数据变化驱动）
- 切换 toggle（启停功能、模式切换都属于配置，应放进对应面板内部）
- 导出 / 管理 / 跳转按钮
- 主操作 / 次操作的 AcuButton

**仅允许放**：状态指示徽章（`AcuBadge`），用于"当前状态"信息展示，不可点击或承载副作用。

**理由**：header 只承担"我在哪一页"的识别；功能控件统一收敛到面板内部，避免用户在 header / panel header / panel body 之间判断该点哪里。

**当前债务**：

- ApiPage "流式" toggle：仍挂在 API 预设面板的 actions 槽，待 sweep 阶段迁入面板正文。
- PlotPage "已启用" toggle：已迁出 page header；页面可见性由仪表盘功能开关控制。
- FormFillPage 状态 Badge：合规（仅状态展示），可保留。

**面板级标题右侧**（`AcuPanel #actions`）同样只放状态徽章，不放功能按钮。

`subtitle` prop 已于 D22.3 从 `AcuPageHeader` 移除，说明文字使用 `AcuPanel.description` 或顶部 `AcuInfoBanner`。


## 13. 工程边界

### D17. 服务层调用边界（三档）

Vue 组件**禁止直接 import service 函数或单例状态**（特别是 `settings_ACU` / `state-manager`）。必须通过中间层：

| 调用形态 | 中间层 | 例 |
|---|---|---|
| 持有响应式状态（值会变，UI 跟随更新） | **Pinia store** | `useApiPresetStore()` 当前活动 API + 预设列表 |
| 业务流编排（多个 service 调用 + 局部 ref） | **composable** | `useVectorIndex()` 包 status + archiveNow + refresh |
| 一次性副作用（触发下载 / 显示 toast，无返回状态） | **直接 import 函数** | `exportCurrentJsonData_ACU()` |

理由：
1. service 返回 plain values，组件需 reactive 包装——包装责任归一到 store / composable
2. 物理屏障，防止 Vue 组件耦合旧单例
3. 测试时只 mock store / composable

### D21.2 `presentation/` 物理边界

- `src/presentation-v2/**` 任何代码（含 `.vue` / `.ts` / 测试）**禁止 import `src/presentation/`**。
- 阶段 2 起，`scripts/check-arch.mjs` 增加该规则。
- 老 `src/presentation/` 的归档 / 删除发生在"下线旧 UI"阶段，**前置任务**见 D21.6。
- 与 D17 关系：D17 限制 `.vue` 不直 import service / state-manager；D21.2 进一步禁掉 `.vue` 与 `.ts` 跨进 `presentation/`。两者叠加，新 UI 与旧 UI 在源码层物理隔离。

### D25. 页面生命周期与重开刷新

- 新 UI 关闭时只隐藏根节点，保留根 Vue app、Pinia store 与当前路由；重新打开时由 `MainArea` 根据 `root-shell-store.openRefreshTick` **remount 当前页面组件**。
- 新页面不允许手写"UI 打开刷新"订阅；读取 settings、宿主世界书、当前聊天数据等外部状态的逻辑放在页面 `onMounted()` 调用的 `refreshAll()` / store action / composable refresh 中。这样新增页面天然获得"关闭后重开即刷新"。
- 需要跨关闭 / 重开保留的内容必须是用户明确编辑过的状态，并进入对应 store / settings / draft store，且有明确 dirty 语义；页面本地 `ref` 只用于临时 UI 状态（搜索词、展开项、loading/error、临时列表缓存等），允许在重开后丢弃并重读。
- 架构守卫禁止页面层重新引入 `useUiOpenRefreshTick` 一类逐页订阅模式。重开刷新是 shell / MainArea 的职责，不是每个页面的职责。

## 14. 组件抽取与命名

### D21.7 `_lib/` 组件库布局

- 目录平铺：`src/presentation-v2/components/_lib/AcuButton.vue` / `AcuPanel.vue` / ……不再分子目录。
- 命名前缀统一 `Acu`。
- 抽取阈值：**两次出现 + 接口稳定**才抽。不预先抽象。

- X-4：`_lib/` 组件稳定后，用 check-arch 禁止 `.vue` 中出现裸 `<input>` / `<button>` / `<select>` 等基础元素；必须使用 `_lib/` 组件。

## 15. 操作区惯例

### D21.8 操作区布局惯例（替代撤销的 D7）

- 功能页**如果存在触发按钮**，则在底部留一块视觉上独立的"操作区"（间距 + 顶分隔线 + 按钮组）。
- 这是**布局惯例**，不是注册机制。每个按钮就是普通 `<AcuButton>`。
- 撤销原 D7 "集中识别便于外挂" 要求；外挂走 api-registry，与 UI 无关。
- **2026-05-03 修订（P3-9 决议）**：对没有触发按钮的页面，**不强制留空操作区**。原"功能页底部必须有操作区"被弱化为"有触发按钮才有操作区"。剧情推进相关的"立即触发"概念由发送消息时的拦截链触发，UI 上无单独按钮；这类页面按运行配置归入"配置"。

## 16. 外部导入占位符规则

### D21.9 移除"屏蔽外部导入世界书条目占位符"开关

- 旧 UI 该 toggle 在外部导入页存在；新 UI **不再呈现**该开关，且在新 UI 接入的运行时上下文中**强制视作开启**（即填表提示词中世界书条目占位符永久屏蔽带 `外部导入-` 标签的条目）。
- 实现：v2 `useImportFlow` 不读取 `acu_import_prompt_exclude_imported_worldbook_entries` 设置字段；填表提示词构建侧若仍走老分支，需在阶段 2 落地一条最小改动，使该字段在 v2 上下文中被强制 true 等价。
- 旧设置字段保留以避免破坏数据结构；下线旧 UI 时再彻底清理。

## 17. 常驻信息条与写作惯例

### D22.3 决策：常驻信息条 + 行级等高

- **新增 `<AcuInfoBanner>`**：[components/_lib/AcuInfoBanner.vue](../../src/presentation-v2/components/_lib/AcuInfoBanner.vue)。永远可见，内容可自动换行。tone 三档：`info`（默认 / 解释性）/ `tip`（操作建议）/ `warning`（注意事项）。
- **`<AcuPanel>` 的 `description` prop / slot**：[components/_lib/AcuPanel.vue](../../src/presentation-v2/components/_lib/AcuPanel.vue)。提供时自动在 body 顶部渲染一个 `<AcuInfoBanner>`，省去页面层重复样板。
- **`subtitle` prop 移除**：旧 `subtitle` 是 height bug 的源头，不保留也不软兼容。
- **一级功能页面板分栏统一用 `<AcuPanelGrid>`**：[components/_lib/AcuPanelGrid.vue](../../src/presentation-v2/components/_lib/AcuPanelGrid.vue)。所有一级功能页都进入这个左右等宽骨架；只有一个主面板时左列放内容、右列保留空占位并在移动端隐藏。它固定提供 `repeat(2, minmax(0, 1fr))` 等宽左右列、`gap: 16px`、`align-items: stretch` 和统一单列断点；页面不得再手写 `0.9fr / 1.1fr`、`360px / 520px` 这类左右比例。
- **网格 `align-items: stretch`**：所有多列页面（ImportPage / ApiPage / ……）的 grid 必须用 `stretch`（默认值，去掉显式 `start`），同行面板自动等高，矮的底部留空可接受。

### D22.4 内容写作惯例

- 描述目标用户：完全不懂电脑的新手。
- 必须解释"是什么 / 为什么 / 出问题怎么办"，而不是只罗列字段。
- 优先解释完整，但保持可扫读；行高 1.55 阅读舒适。
- 内嵌 UI 名词时使用全角引号 `"` `"` 或代码 `` ` ``，避免与 HTML 属性引号冲突。
- 涉及"敏感词"（例如 ApiPage 的 "导入"/"导出" 文案与既有断言冲突）需在写作时回避或更新断言。

### D22.5 新页面强制约定

- 阶段 3+ 新增的所有一级页：每个 `<AcuPanel>` 都必须提供 `description`（即便短）。空 description 视作设计缺漏，code review 必拒。
- 一级功能页外层面板区必须使用 `<AcuPanelGrid>`；只有断点可以通过 `collapse-at="md|lg"` 选择，不能在页面 CSS 中重写左右列宽比例。单主面板页面也必须保留右列空占位，保证所有页面的左右节奏一致。
- 多列布局必须 `align-items: stretch`，禁止 `align-items: start` / `flex-start`。
- 出现 `description` 不能塞下的复杂操作步骤时，使用页面顶部 hero / 单独的 `<AcuInfoBanner tone="tip">`，而不是堆到面板里。

### D22.6 测试守护

- [tests/presentation-v2/components/acu-info-banner.test.ts](../../tests/presentation-v2/components/acu-info-banner.test.ts) 覆盖 AcuInfoBanner / AcuPanel.description 行为，包含"subtitle prop 必须无效"的反向断言以防回退。
- 每个一级页的集成测试都必须加一条"所有面板渲染常驻说明信息条"的断言（参考 [import-page.test.ts](../../tests/presentation-v2/import/import-page.test.ts) 的 "每个面板都渲染常驻说明信息条" 用例）。

## 18. 测试三档

- store：持有响应式状态、settings 读写和迁移归一化的 Pinia store 必须有单测。

- composable：业务流编排、service 调用适配、局部 ref 状态必须有单测。

- 页面集成：每个一级页至少覆盖关键面板渲染、主路径操作、说明信息条、开发者 gated / feature gate 分支。

## 19. 落地前自检清单

- [ ] Vue 组件没有直接 import service 函数或单例状态，除一次性副作用例外。

- [ ] `src/presentation-v2/**` 没有 import `src/presentation/**`。

- [ ] 新组件两次出现且接口稳定后才抽到 `_lib/`，命名前缀使用 `Acu`。

- [ ] 页面和面板标题右侧只放状态徽章，不放触发按钮或配置开关。

- [ ] 每个 `AcuPanel` 都有 `description` 或等价常驻信息条。

- [ ] 一级功能页面板区使用 `<AcuPanelGrid>`，单主面板页有右列空占位，且没有手写非等宽 `fr` 分栏。

- [ ] 多列布局没有 `align-items: start` / `flex-start`。

- [ ] 表单控件使用 `_lib/` 组件，不新增裸基础元素。

- [ ] 触发按钮只在所属功能页内的操作区出现。

- [ ] 新手说明解释“是什么 / 为什么 / 出问题怎么办”。

- [ ] 新页面把外部状态读取放进 `onMounted()` 刷新链；不要手写 UI-open 刷新订阅。需保留的编辑草稿进入 store / settings / draft store。

- [ ] store / composable / 页面集成测试覆盖新增行为。
