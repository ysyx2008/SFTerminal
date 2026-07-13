/**
 * 工作台能力装配：遍历已注册 descriptor，连接声明的 MCP；skills 目前做声明收集/日志
 * （内置 skill 由 Agent 侧注册；业务包可通过 side-effect registerSkill）。
 */
import { listWorkbenchDescriptors } from './registry-store'

const log = {
  info: (...args: unknown[]) => console.info('[WorkbenchBootstrap]', ...args),
  warn: (...args: unknown[]) => console.warn('[WorkbenchBootstrap]', ...args),
}

export interface WorkbenchBootstrapResult {
  mcpConnected: string[]
  mcpFailed: Array<{ id: string; error: string }>
  skillsDeclared: string[]
}

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
