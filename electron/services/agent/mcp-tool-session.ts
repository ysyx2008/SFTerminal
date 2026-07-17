/**
 * MCP 工具渐进披露会话状态（按 server 整包 sticky）
 *
 * 对齐 Skill：选定一家 MCP → 其下全部工具 schema 进入会话。
 * 已 load 的 server 本会话一直保留，直到 clear（resetSession / cleanup）；
 * 不做「最多 N 家」逐出——任务需要几家就留几家。
 *
 * @see electron/services/MCP_SPEC.md「设计意图：工具渐进式披露」
 */

export { MCP_PRELOAD_THRESHOLD } from '../mcp-progressive-constants'

export class McpToolSession {
  /** 已 load 的 serverId（插入顺序，仅用于稳定遍历） */
  private loadedServers: string[] = []

  clear(): void {
    this.loadedServers = []
  }

  getLoadedServerIds(): string[] {
    return [...this.loadedServers]
  }

  isServerLoaded(serverId: string): boolean {
    return this.loadedServers.includes(serverId)
  }

  /**
   * 整包加载某 MCP server。已在集合中则忽略。
   * @returns 是否为新 load
   */
  loadServer(serverId: string): boolean {
    if (!serverId) return false
    if (this.loadedServers.includes(serverId)) return false
    this.loadedServers.push(serverId)
    return true
  }
}
