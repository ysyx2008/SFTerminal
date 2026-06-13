/**
 * 工作台 introspection 工具（状态在渲染进程，经 workbench-bridge 查询）
 */
import { workbenchBridge } from '../../workbench-bridge.service'
import type { ToolExecutorConfig, ToolResult } from './types'

function ok(output: string, data?: unknown): ToolResult {
  return {
    success: true,
    output: data === undefined ? output : `${output}\n${JSON.stringify(data, null, 2)}`
  }
}

function fail(error: string): ToolResult {
  return { success: false, output: '', error }
}

export async function listWorkbenchArtifactsTool(executor: ToolExecutorConfig): Promise<ToolResult> {
  const ownerAgentKey = executor.agentId
  if (!ownerAgentKey) {
    return fail('list_workbench_artifacts 需要桌面助手 Agent 上下文')
  }

  const result = await workbenchBridge.exec({ type: 'list_artifacts' }, ownerAgentKey)
  if (!result.ok) {
    return fail(result.error || '查询产出物面板失败')
  }

  const snapshot = result.data as { panelVisible?: boolean; artifacts?: unknown[] } | undefined
  const count = Array.isArray(snapshot?.artifacts) ? snapshot!.artifacts!.length : 0
  const visible = snapshot?.panelVisible === true
  const summary = visible
    ? `产出物面板已展开，共 ${count} 个文件类 artifact。`
    : count > 0
      ? `产出物面板当前未展开，但仍有 ${count} 个已注册 artifact。`
      : '产出物面板未展开，尚无文件类 artifact。'

  return ok(summary, result.data)
}
