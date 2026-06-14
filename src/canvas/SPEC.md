# Canvas Artifact 子系统 SPEC

> Last verified: 2026-06-09

## 职责

独立助手右侧 **产出物工作区**：用户可 revisit 的文件类结果（Word / Excel / Markdown / PPT 预览；未来的图表、浏览器快照等）。

## 分层

| 层 | 路径 | 职责 |
|---|---|---|
| 协议类型 | `shared/types/canvas.ts` | `CanvasData` / `CanvasArtifact` / ID 推导 |
| 领域逻辑 | `src/canvas/artifact-registry.ts` | 纯函数 registry |
| UI 适配 | `src/stores/canvas.ts` | Pinia tab 容器 + 布局比例 |
| 保存逻辑 | `src/canvas/artifact-actions.ts` | Save / Save As / Save All |
| 编辑桥接 | `src/canvas/artifact-save-bridge.ts` | Markdown draft → 面板级保存 |
| 磁盘同步 | `artifact-file-status.ts` + `artifact-disk-sync.ts` | exists 复检；exec 后触发 |
| 右键菜单 | `artifact-context-menu.ts` | 菜单项可见性 |
| 视图 | `src/components/Canvas/*` | CanvasPanel |

## 头部与交互

- **布局**：tab 区横向滚动；右侧 **「保存」+「文件 ▾」** 文字按钮
- **溢出**：4 tab +「+N 更多」（搜索、路径副标题、行内关闭）
- **Tab**：左键切换、中键关闭；**右键无「切换到此产出物」**（左键已可切换）
- **右键菜单**：标题/路径 → 打开组 → 保存组 → 关闭组（按 renderer/dirty/文件是否存在显隐）
- **保存**：Markdown 且有 path + 在盘 + dirty 才可「保存」；预览类仅「另存为」
- **磁盘同步**：path 不存在则移除 tab。触发：exec 完成、切 tab、聚焦、`list_workbench_artifacts`（静默）
- **mv**：旧 path tab 移除；新 path 须重新 open

## CanvasData.action

- `open`：upsert artifact
- `update`：替换 content
- `close`：移除 artifact（用户手动关 tab；**word_close / excel_close 不推送**）

## Artifact ID

- 有 `filePath` → `file:${absolutePath}`
- 否则 → `ephemeral:${renderer}:${title}`

## 测试

- `src/stores/__tests__/artifact-registry.test.ts`
- `src/stores/__tests__/artifact-tab-layout.test.ts`
- `src/canvas/__tests__/artifact-actions.test.ts`
- `src/canvas/__tests__/artifact-file-status.test.ts`
- `src/canvas/__tests__/artifact-disk-sync.test.ts`
- `src/canvas/__tests__/artifact-context-menu.test.ts`

## 历史恢复

- `AgentStepRecord.canvasData` 随会话持久化；`restoreAgentHistory` 调用 `hydrateFromSteps` 重放 steps 中的 canvasData。
- 升级前已保存的历史无 canvasData 字段，Artifact 面板无法恢复（需重新生成产出物）。

## Agent 认知

- 工作台 UI 描述见 `src/workbench/assistant/prompt.ts`；实时状态用 `list_workbench_artifacts`（见 `src/workbench/SPEC.md`）。
