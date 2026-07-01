# 技能（Skill）工作台 SPEC

> Last verified: 2026-07-01
> 范围：`src/workbench/skill/`（描述符 + prompt 归属地）+ 渲染组件 `src/components/workbench/SkillWorkbench.vue` + 数据 composable `src/composables/useSkillCatalog.ts`。
> 工作台体系通用规则见 `src/workbench/SPEC.md`；产品定位见 `.cursor/rules/product-philosophy.mdc`「能力扩展」与 `.cursor/rules/project-architecture.mdc`。

---

## 一、职责

技能（`__skill__`）工作台 = **能力档案仪表盘**。

定位是「**秘书会什么**作为可见的身份属性」——一眼看到秘书当前具备的能力、哪些是开着的、状态如何。区别于「设置 → 技能」子页（重配置管理、市场源、env 批量管理），这里重「档案呈现」：

- 主视图是**能力一览**（内置 + 扩展），卡片化呈现名称/描述/状态
- 副视图是**技能市场**（与设置子页共用数据源）
- **不含对话锚点区（AiPanel）**——需要追问时让 AI 在任务/联络 tab 里回答即可
- **不含后端 Agent 实例**——纯前端视图，无会话 / 历史

## 二、与工作台体系的关系

- `kind = 'skill'`，与 `companion` **平级**（都是 `tab.type='assistant'` 但外观独立的工作台）。
- `tab.type` 仍是 `'assistant'`（后端 Agent context mode 不变；技能 tab 不运行后端 Agent）；靠 `resolveWorkbenchKind(tab)` 按 `agentId === '__skill__'` 映射到 skill 工作台。这是 `tab.type ≠ WorkbenchKind` 的典型例子（同 companion）。
- 渲染走 `renderer`（自定义组件），不使用 `regions` 声明式布局。

## 三、常驻 Tab 机制

技能 tab 与联络 tab 一样是**常驻、不可关闭、启动时不抢首页激活**：

| 维度 | 实现 |
|---|---|
| agentId | `__skill__`（常量 `SKILL_TAB_AGENT_ID`，单一来源 `@shared/types`） |
| 创建 | `terminalStore.ensureSkillTab()`，App 启动时调用 |
| 不可关闭 | `closeTab()` 按 `agentId === SKILL_TAB_AGENT_ID` 拦截 |
| 不进拖拽排序 | `displayedTabs` 过滤掉；TabBar 用独立 `skillTab` computed 固定渲染 |
| 不被助手名同步覆盖 | `agentName` watcher 跳过 `agentId === SKILL_TAB_AGENT_ID` |
| Steam 构建 | `availableInSteam: false`，回退到 `TerminalTabView`（与 assistant / companion 一致） |

## 四、关键文件

| 文件 | 职责 |
|---|---|
| `descriptor.ts` | 声明 `kind='skill'` / renderer，注册到体系 |
| `prompt.ts` | Agent prompt 片段归属地；当前无界面能力 → `undefined` |
| `SkillWorkbench.vue` | 渲染器（在 `src/components/workbench/`），呈现能力档案 + 市场两个子视图 |
| `useSkillCatalog.ts` | composable（在 `src/composables/`），封装 builtinSkill/userSkill/skillMarket IPC 调用，给 tab 与设置子页共用 |

## 五、数据来源（IPC）

技能 tab 不持有后端 Agent，所有数据来自现有 IPC（`window.electronAPI.*`）：

- `builtinSkill.list()` / `builtinSkill.toggle()` —— 内置技能
- `userSkill.list()` / `userSkill.toggle()` / `userSkill.refresh()` / `userSkill.getContent()` / env key 管理
- `skillMarket.list()` / `skillMarket.install()` / `skillMarket.uninstall()` / `skillMarket.update()` / 分类与 registry

后端服务层（`user-skill.service.ts` 等）**不动**——技能 tab 只是前端视图层叠加。

## 六、注意事项

- **UI 与 prompt 一致**：技能 tab 不挂对话能力，且 `resolveWorkbenchAgentPrompt('skill', …)` 返回 `undefined`。两者必须保持一致——别只改一处。
- **身份判断**用稳定常量 `'__skill__'`（见 `registry.ts SKILL_AGENT_ID`），不要用标题等脆弱匹配。
- **与设置子页的关系**：`Settings/SkillSettings.vue` 保留不动（继续承载配置管理）。`useSkillCatalog` composable 抽出共用数据加载逻辑，两者各自实例化、互不干扰。
- **后续扩展**：若技能 tab 长出对话能力（如对单个技能追问），在 `SkillWorkbench.vue` 加 AiPanel 区域、在 `prompt.ts` 导出片段即可。
