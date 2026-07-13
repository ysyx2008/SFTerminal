/**
 * 历史记录共享类型定义
 */

import type { ConversationKind, TerminalType, TokenUsage } from './agent'

export interface AgentStepRecord {
  id: string
  type: string
  content: string
  images?: string[]
  /**
   * 「活图」载荷的持久化形态。重新打开历史会话时，前端从这里恢复出可交互的
   * ECharts 图表。详见 `EChartsStepPayload` 注释（shared/types/agent.ts）。
   *
   * 体积说明：典型 ECharts option 序列化后 5-30KB，比同等画面的 SVG base64
   * （80KB+）小一个数量级——所以同时持久化两路图依旧让历史文件总体变小。
   */
  echartsOption?: import('./agent').EChartsStepPayload
  attachments?: import('./agent').AttachmentInfo[]
  toolName?: string
  /** 关联的 tool_call ID，用于配对 tool_call ↔ tool_result（老记录可能缺失） */
  toolCallId?: string
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
  /** Canvas 预览数据（仅 UI / Artifact 面板消费，不发给 AI；历史重开时重放） */
  canvasData?: import('./canvas').CanvasData
}

export interface AgentRecord {
  id: string
  timestamp: number
  terminalId: string
  /** Agent 的身份 key（如 '__companion__'、'__watch__'，或 tabId）。存盘时由 agent._agentId 写入 */
  agentKey?: string
  /**
   * 会话类别（task/companion/watch）。缺失（老记录）时由 `inferConversationKind(agentKey)`
   * 推断补默认，见 normalizeAgentRecord。形态用 terminalType 表达，不另设 workbenchType。
   */
  kind?: ConversationKind
  terminalType: TerminalType
  sshHost?: string
  userTask: string
  steps: AgentStepRecord[]
  messages?: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }>
  finalResult?: string
  duration: number
  status: 'completed' | 'failed' | 'aborted'
  tokenUsage?: TokenUsage
  /**
   * 产出物面板的持久化清单。
   * 由 Agent 完成后或用户在面板做增删操作时写入，加载历史时直接恢复（不再 replay steps）。
   * 字段缺失时（老记录）退化为按 steps 重放，保持向后兼容。
   */
  artifacts?: import('./canvas').CanvasArtifact[]
}

/**
 * Agent 历史列表行（来自磁盘索引，无 steps）。
 * 用于「最近对话」弹窗一次拉全量标题后本地筛选，点开时再 `getAgentRecordById`。
 */
export interface AgentHistorySummary {
  id: string
  timestamp: number
  duration: number
  userTask: string
  terminalType: TerminalType
  /** Agent 身份 key（如 '__companion__'、'__watch__'）。用于把联络/关切会话从「任务」侧栏剔除 */
  agentKey?: string
  /** 会话类别（task/companion/watch）。缺失时由 inferConversationKind(agentKey) 推断 */
  kind?: ConversationKind
  sshHost?: string
  status: 'completed' | 'failed' | 'aborted'
}
