# UI v2 文档索引

> 本目录是 UI v2 的主文档入口；新开发以本目录为唯一入口。
> 在编辑 `src/presentation-v2/` 前，Claude 使用本仓库 skill：[../../.claude/skills/ui-v2-principles/SKILL.md](../../.claude/skills/ui-v2-principles/SKILL.md)；Codex 使用用户级 skill：`ui-v2-principles`。

## 这套文档怎么用

- **新接手 UI v2**：先读 `00-charter.md` 理解目标与不可变决策，再读 `01-architecture-map.md` 定位旧/新实现。
- **落地中**：每次编辑 v2 文件前读/触发 `ui-v2-principles` skill；遇到范围、边界、视觉写作问题查 [02-principles.md](02-principles.md)。
- **复查收尾**：看 [10-spv4.6.2-porting-notes.md](10-spv4.6.2-porting-notes.md)、[metrics.md](metrics.md) 和 [open-questions.md](open-questions.md)。

## 文件清单

| 文件 | 何时读 | 内容 |
|---|---|---|
| `00-charter.md` | 判断范围与顶层方向时 | 设计目的、验收标准、稳定决策、入口与挂载 |
| `01-architecture-map.md` | 找旧代码、页面归属、实现地图时 | 旧 UI 地图、业务层规模、v2 一级页清单 |
| `02-principles.md` | 每次 v2 开发前 | 视觉、工程边界、组件抽取、写作和测试原则 |
| `10-spv4.6.2-porting-notes.md` | 复查 4.6.2 移植时 | 本次移植中保留上游实现后需要 v2 重新适配的 API/行为 |
| `open-questions.md` | 开新页面或下线旧 UI 前 | P/SUN/X/G/债务统一列表 |
| `metrics.md` | 阶段收尾或构建体积变化时 | 产物体积、check-arch、测试规模追踪 |

## 当前阶段

已完成：阶段 -1 / 0 / 2 / 3、组件库扩充、仪表盘开发者页修订、主弹窗 14 个 v2 一级页覆盖审查、自定义主题导入 / 导出 / 删除。

当前状态（2026-05-21）：v2 已覆盖旧主弹窗主要功能面，自定义主题能力已保留；仍不可作为旧 UI 下线依据。v2 toast / confirm / input dialog 试做实现已回滚，下一步 toast 收窄为 v2 主界面内短反馈；旧 `showToastr_ACU` 暂时仍服务旧 runtime / 旧 UI，visualizer、旧 `presentation/` runtime 胶水、旧窗口系统和 api-registry 搬迁仍属于下线前置债务。

长期节奏见 [00-charter.md](00-charter.md)。

## 修订规则

- 顶层不可变目标或已锁定长期决策 → 改 [00-charter.md](00-charter.md)。
- 旧/新实现定位资料 → 改 [01-architecture-map.md](01-architecture-map.md)；一级页归属在 charter §4。
- 每次开发都必须遵守的规则 → 改 [02-principles.md](02-principles.md)（**单一来源**）；SKILL.md 是 thin wrapper，仅在自检清单变动时需同步。
- 未决问题、债务、缺口 → 改 [open-questions.md](open-questions.md)。
- 体积、测试数量、架构守护规则演进 → 改 [metrics.md](metrics.md)。
