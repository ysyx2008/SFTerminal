/**
 * 工作台能力装配：遍历已注册 descriptor，连接声明的 MCP；skills 仅做声明日志
 * （内置 skill 由 Agent 侧已注册；业务包通过 side-effect registerSkill）。
 *
 * 内置工作台当前多无 mcpServers；业务/OEM 通过 registerWorkbench 声明后由此统一装配。
 */
import { createLogger } from '../utils/logger'
import { listWorkbenchDescriptors } from './registry-store'

const log = createLogger('WorkbenchBootstrap')

export interface WorkbenchBootstrapResult {
  mcpConnected: string[]
  mcpFailed: Array<{ id: string; error: string }>
  skillsDeclared: string[]
}

/**
 * 在前端启动完成后调用（需 electronAPI 可用）。
 */
export async function bootstrapWorkbenchCapabilities(): Promise<WorkbenchBootstrapResult> {
  const result: WorkbenchBootstrapResult = {
    mcpConnected: [],
    mcpFailed: [],
    skillsDeclared: [],
  }

  const descriptors = listWorkbenchDescriptors()
  const skillIds = new Set<string>()
  for (const d of descriptors) {
    for (const id of d.skills ?? []) skillIds.add(id)
  }
  result.skillsDeclared = [...skillIds]
  if (skillIds.size > 0) {
    log.info(`Workbench skills declared: ${result.skillsDeclared.join(', ')}`)
  }

  for (const d of descriptors) {
    for (const mcp of d.mcpServers ?? []) {
      if (!mcp.enabled) continue
      if (!window.electronAPI?.mcp?.connect) {
        result.mcpFailed.push({ id: mcp.id, error: 'mcp API unavailable' })
        continue
      }
      try {
        await window.electronAPI.mcp.connect(mcp)
        result.mcpConnected.push(mcp.id)
        log.info(`Connected workbench MCP: ${mcp.name} (${mcp.id}) from kind=${d.kind}`)
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        result.mcpFailed.push({ id: mcp.id, error })
        log.warn(`Failed to connect workbench MCP ${mcp.id}:`, error)
      }
    }
  }

  return result
}
