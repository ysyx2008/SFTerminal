# 助手产出物（Artifact）子系统 SPEC

> Last verified: 2026-06-14

## 职责

**assistant 工作台专属**：右侧产出物工作区，用户可 revisit 的文件类结果（Word / Excel / Markdown / PPT 预览；未来的图表、浏览器快照等）。

**定位**：本次助手会话产出的、可 revisit 的文件类成果索引 + 内嵌预览/轻编辑。不是文件管理器，不替代 Finder。

**命名说明**：Agent 协议层仍称 `CanvasData`（`shared/types/canvas.ts`）；前端 UI 域统一称 **artifact**，模块位于 `src/workbench/assistant/artifact/`。

## 目录

```
src/workbench/assistant/artifact/
  SPEC.md
  index.ts                 # 对外统一导出
  store.ts                 # Pinia：useAssistantArtifactStore
  domain/                  # 纯函数领域逻辑
  renderers/
    registry.ts            # 能力元数据
    ui-registry.ts         # Vue 组件 + 图标
  components/
    ArtifactPanel.vue      # 主面板
    *Renderer.vue
  __tests__/
```

## 分层

| 层 | 路径 | 职责 |
|---|---|---|
| 协议类型 | `shared/types/canvas.ts` | `CanvasData` / `CanvasArtifact` / ID 推导 |
| 渲染器能力 | `renderers/registry.ts` | editable / saveStrategy / defaultExt（纯函数） |
| 渲染器 UI | `renderers/ui-registry.ts` | Vue 组件 + 图标映射 |
| 领域逻辑 | `domain/artifact-registry.ts` | 纯函数 registry |
| UI 适配 | `store.ts` | Pinia tab 容器 + 布局比例 + 溯源跳转 |
| 保存逻辑 | `domain/artifact-actions.ts` | Save / Save As / Save All（查注册表） |
| 编辑桥接 | `domain/artifact-save-bridge.ts` | Markdown draft → 面板级保存 |
| 磁盘同步 | `domain/artifact-file-status.ts` + `artifact-disk-sync.ts` | exists 复检；exec 后触发 |
| 右键菜单 | `domain/artifact-context-menu.ts` | 菜单项可见性（查 editable） |
| 视图 | `components/*` | ArtifactPanel |

## 数据模型（CanvasArtifact）

- `origin`: `'agent' | 'user'` — upsert 时填充，默认 agent
- `editable`: 派生自 renderer 注册表，消除 UI 层 `renderer === 'markdown'` 硬判断
- `sourceStepId`: 产生该产出物的 `AgentStep.id`，仅 UI 溯源，不复制 step 内容
- `hadArtifacts`（Tab 级）：本会话是否曾出现产出物；全部关闭后保留轻量空态

## 渲染器注册表

新增 renderer 时只改两处：

1. `renderers/registry.ts` — 能力（editable / saveStrategy / defaultExt）
2. `renderers/ui-registry.ts` — 组件 + 图标

`ArtifactPanel` 通过 `<component :is="getRendererComponent(type)">` 动态渲染。

## 头部与交互

- **布局**：tab 区横向滚动；右侧 **「保存」+「文件 ▾」** 文字按钮
- **Tab 条**：全部 tab 横向滚动（隐藏滚动条）；≥2 个时在右侧固定「数量 ▾」打开完整列表（含搜索）
- **Tab**：左键切换、中键关闭；**右键无「切换到此产出物」**
- **列表内右键**：保持列表打开，右键菜单置于列表之上；Esc 分层关闭
- **右键菜单**：标题/路径 → 打开组 → 保存组 → 关闭组（按 editable/dirty/文件是否存在显隐）
- **保存**：editable 且有 path + 在盘 + dirty 才可「保存」；预览类仅「另存为」
- **来源**：`sourceStepId` 指向 UI 可见的 `tool_call`（canvasData 多在隐藏的 `tool_result` 上，入库时按 `toolCallId` 解析）；右键「跳到生成处」滚动对话流并高亮
- **空态**：全部 tab 关闭后会话内仍占位；用户可「关闭面板」恢复初始隐藏
- **磁盘同步**：path 不存在则移除 tab。触发：exec 完成、切 tab、聚焦、`list_workbench_artifacts`（静默）
- **mv**：旧 path tab 移除；新 path 须重新 open

## CanvasData.action

- `open`：upsert artifact（宿主注入 `sourceStepId`）
- `update`：替换 content
- `close`：移除 artifact

## Artifact ID

- 有 `filePath` → `file:${absolutePath}`
- 否则 → `ephemeral:${renderer}:${title}`

## 兼容导出

- `src/canvas/index.ts`、`src/stores/canvas.ts` 保留 `@deprecated` re-export，供旧 import 路径过渡。

## 测试

- `src/stores/__tests__/artifact-registry.test.ts`
- `src/stores/__tests__/artifact-tab-layout.test.ts`
- `__tests__/artifact-actions.test.ts`
- `__tests__/artifact-file-status.test.ts`
- `__tests__/artifact-disk-sync.test.ts`
- `__tests__/artifact-context-menu.test.ts`
- `__tests__/renderer-registry.test.ts`
- `__tests__/artifact-source.test.ts`

## 历史恢复

- `AgentStepRecord.canvasData` 随会话持久化；`restoreAgentHistory` 调用 `hydrateFromSteps` 重放 steps 中的 canvasData，并从 `step.id` 回填 `sourceStepId`。
- 升级前已保存的历史无 canvasData 字段，Artifact 面板无法恢复（需重新生成产出物）。

## Agent 认知

- 工作台 UI 描述见 `../prompt.ts`；实时状态用 `list_workbench_artifacts`（见 `src/workbench/SPEC.md`）。
