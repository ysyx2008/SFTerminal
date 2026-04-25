/**
 * 历史记录共享类型定义
 */

import type { TerminalType, TokenUsage } from './agent'

export interface AgentStepRecord {
  id: string
  type: string
  content: string
  images?: string[]
  attachments?: import('./agent').AttachmentInfo[]
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: string
  timestamp: number
  /** Web 搜索结构化结果（web_search 工具专用） */
  webSearchResults?: import('./agent').WebSearchResultItem[]
  /** 工具执行成败标识，前端据此判断"失败的 tool_result 必须显示" */
  success?: boolean
  /** 并行子 Agent 卡片组（dispatch_agents 工具专用） */
  subAgents?: import('./agent').SubAgentResult[]
}

export interface AgentRecord {
  id: string
  timestamp: number
  terminalId: string
  terminalType: TerminalType
  sshHost?: string
  userTask: string
  steps: AgentStepRecord[]
  messages?: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }>
  finalResult?: string
  duration: number
  status: 'completed' | 'failed' | 'aborted'
  tokenUsage?: TokenUsage
}
