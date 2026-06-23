# 工作台（Workbench）体系 SPEC

> Last verified: 2026-06-23
> 范围：`src/workbench/`（体系类型、注册、prompt 解析）+ `src/components/workbench/`（渲染组件）。
> 单个工作台的契约见各自子目录的 SPEC（assistant 见 `assistant/HUB_SPEC.md` + `assistant/artifact/SPEC.md`；联络见 `companion/SPEC.md`）。

---

## 一、心智模型

- **一个 Tab = 一个工作台实例**。工作台 = 一个常驻**锚点区** + 若干可显隐的**辅助区**，区域间可拖分隔条调比例。
- **工作台类型 ≠ 终端类型**。`WorkbenchKind` 是 `TerminalType`（`local`/`ssh`/`assistant`）的**超集**：同一 `tab.type='assistant'` 可以映射到不同工作台（如普通助手 `assistant` vs 联络 `companion`）。这就是为什么需要一个 `tab → kind` 映射函数，而不能直接拿 `tab.type` 当工作台类型。
- **渲染两种方式**（见 `types.ts`）：
  - **renderer（逃生口）**：工作台有特殊 chrome 时给一个专属组件，直接渲染整个工作台。当前所有内置工作台都走这条。
  - **regions（声明式）**：无特殊 chrome 时只声明区域，交给通用 `WorkbenchShell` 渲染（预留）。

---

## 二、核心概念（`types.ts`）

| 概念 | 说明 |
|---|---|
| `WorkbenchKind` | 工作台类型，`TerminalType \| 'companion'`。registry 的查表 key。 |
| `WorkbenchDescriptor` | 一种工作台一条：`{ kind, renderer?, regions?, availableInSteam? }`，集中登记在 registry。 |
| `RegionSpec` | 区域声明（anchor / toggle、左右侧、默认显隐、可否调尺寸），声明式工作台用。 |

---

## 三、两个注入入口（最易漏）

新增工作台**必须**接通这两处，否则只是建了个孤岛：

| 入口 | 函数 | 调用点 | 作用 |
|---|---|---|---|
| **渲染** | `resolveWorkbenchRenderer(kind)` (`registry.ts`) | `App.vue`（`<component :is>`） | 决定 tab 用哪个组件渲染 |
| **Prompt** | `resolveWorkbenchAgentPrompt(kind, tab)` (`resolve-workbench-agent-prompt.ts`) | `useAgentMode.ts` | 注入工作台专属 system prompt 片段（→ `AgentContext.workbenchPrompt`，后端 `prompt-builder.ts` 原样透传） |

两处调用点都先经 **`resolveWorkbenchKind(tab)`**（`registry.ts`）把 tab 映射成 `WorkbenchKind`——这是"tab → 工作台类型"的**唯一**映射点，所有按身份分流的逻辑都收敛于此，不散落到组件里。

---

## 四、目录约定

| 层 | 位置 | 内容 |
|---|---|---|
| **逻辑 / 描述符** | `src/workbench/<kind>/` | `descriptor.ts`（注册）+ `prompt.ts`（Agent prompt 片段）+ 子 `SPEC.md` |
| **渲染组件** | `src/components/workbench/` | `<Kind>Workbench.vue`（与 `WorkbenchShell.vue` 同级） |

> 终端类工作台（local/ssh）的 renderer 复用 `TerminalTabView`（Terminal 实例 Teleport 保命池所需），不在 `components/workbench/` 下。

---

## 五、新增一个工作台 Checklist

以新增 `companion` 为例（一种 `tab.type='assistant'` 但外观独立的工作台）：

1. **建目录** `src/workbench/companion/`。
2. **`descriptor.ts`** — `{ kind: 'companion', renderer: CompanionWorkbench, availableInSteam: false }`。
3. **`prompt.ts`** — 导出 prompt 片段与注入判据；若无界面能力可注入，让 `resolveWorkbenchAgentPrompt` 对该 kind 返回 `undefined`。
4. **渲染组件** `src/components/workbench/CompanionWorkbench.vue`。
5. **注册** `registry.ts`：加入 `DESCRIPTORS`。
6. **映射**（仅当 `kind ≠ tab.type`）：在 `resolveWorkbenchKind(tab)` 里按稳定身份（如 `agentId === '__companion__'`）返回该 kind。
7. **prompt 解析** `resolve-workbench-agent-prompt.ts`：处理新 kind 分支。
8. **导出** `index.ts`：按需 re-export descriptor / prompt 常量。
9. **测试** `__tests__/prompts.test.ts`：补该 kind 的注入用例。
10. **文档**：写 `companion/SPEC.md`（指向类型而非复制），必要时同步 `assistant/HUB_SPEC.md`。

---

## 六、约定与注意

- **Steam 构建回退**：`availableInSteam: false` 的工作台在 Steam 版回退到 `TerminalTabView`（见 `resolveWorkbenchRenderer`）。助手类（assistant/companion）均为 false。
- **不要为 tab.type 复制第二套枚举**：`WorkbenchKind` 只在"工作台外观确实独立于终端类型"时才扩展（如 companion），扩展后必须配套 `resolveWorkbenchKind` 映射，否则 `tab.type` 永远查不到它。
- **prompt 注入条件改动**需同步 `prompts.test.ts`。
- **身份判断用稳定常量**（如 `COMPANION_TAB_AGENT_ID`），不要用标题/关键词等脆弱匹配。
