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
| 视图 | `src/components/Canvas/*` | 头部最多 4 个 tab +「+N 更多」下拉 |

## CanvasData.action

- `open`：upsert artifact
- `update`：替换 content
- `close`：移除 artifact（用户手动关 tab；**word_close / excel_close 不推送**）

## Artifact ID

- 有 `filePath` → `file:${absolutePath}`
- 否则 → `ephemeral:${renderer}:${title}`

## 测试

- `src/stores/__tests__/artifact-registry.test.ts`

## 历史恢复

- `AgentStepRecord.canvasData` 随会话持久化；`restoreAgentHistory` 调用 `hydrateFromSteps` 重放 steps 中的 canvasData。
- 升级前已保存的历史无 canvasData 字段，Artifact 面板无法恢复（需重新生成产出物）。
