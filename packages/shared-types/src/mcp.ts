/**
 * MCP 服务器配置（前后端 / 工作台 descriptor 共用）
 */

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  /** 'http' = Streamable HTTP；'sse' = 旧 SSE（兼容）；'stdio' = 本地进程 */
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}
