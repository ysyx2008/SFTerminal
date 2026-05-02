/**
 * 工具执行器类型定义
 */
import type { HistoryService } from '../../history.service'
import type { McpService } from '../../mcp.service'
import type { UnifiedTerminalInterface } from '../../unified-terminal.service'
import type { SftpService } from '../../sftp.service'
import type { SshConfig } from '../../ssh.service'
import type { 
  AgentConfig, 
  AgentStep, 
  ToolResult, 
  RiskLevel,
  HostProfileServiceInterface,
  AgentPlan
} from '../types'
import type { SkillSession } from '../skills'
import type { TaskMemoryStore } from '../task-memory'

// 错误分类
export type ErrorCategory = 'transient' | 'permission' | 'not_found' | 'timeout' | 'fatal'

// 需要进行路径解码的参数名
export const PATH_PARAM_NAMES = new Set([
  'path', 'file_path', 'target_path', 'source_path', 
  'dest_path', 'directory', 'dir', 'folder'
])

/**
 * 工具执行器配置
 */
export interface ToolExecutorConfig {
  /** Agent 实例的逻辑 ID（用于 talk_to_user 等工具路由 proactive message） */
  agentId?: string
  /** 统一终端服务（支持 PTY 和 SSH） */
  terminalService: UnifiedTerminalInterface
  hostProfileService?: HostProfileServiceInterface
  mcpService?: McpService
  addStep: (step: Omit<AgentStep, 'id' | 'timestamp'>) => AgentStep
  updateStep: (stepId: string, updates: Partial<Omit<AgentStep, 'id' | 'timestamp'>>) => void
  waitForConfirmation: (
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    riskLevel: RiskLevel,
    /** 可选的人类可读动作名，用于前端确认卡片显示（如"覆盖生成 Word 文档"） */
    displayName?: string
  ) => Promise<boolean>
  isAborted: () => boolean
  getHostId: () => string | undefined
  hasPendingUserMessage: () => boolean
  peekPendingUserMessage: () => string | undefined
  consumePendingUserMessage: () => string | undefined
  getRealtimeTerminalOutput: () => string[]
  // Plan/Todo 功能
  getCurrentPlan: () => AgentPlan | undefined
  setCurrentPlan: (plan: AgentPlan | undefined) => void
  // Task Memory（任务记忆）
  getTaskMemory: () => TaskMemoryStore
  // SFTP 功能（用于 SSH 终端的文件写入）
  getSftpService?: () => SftpService | undefined
  getSshConfig?: (terminalId: string) => SshConfig | null
  // 技能系统
  skillSession?: SkillSession
  // 插件系统
  pluginRegistry?: import('../../plugin/registry').PluginRegistry
  // 上下文管理（compress_context / recall_compressed 工具使用）
  compressCurrentContext?: (summary: string, keepRecent: number) => {
    beforeTokens: number
    afterTokens: number
    freedTokens: number
    archiveId: string
  } | null
  getCompressedArchives?: () => Array<{ id: string; summary: string; messageCount: number; timestamp: number }>
  getCompressedArchive?: (archiveId: string) => import('../../ai.service').AiMessage[] | null
  // 历史记录服务（search_history 工具使用）
  historyService?: HistoryService
  // AI 服务（remember_info 等工具触发 LLM 更新时使用）
  getAiService?: () => import('../../ai.service').AiService | undefined
  getActiveProfileId?: () => string | undefined
  /** 获取父 Agent 的 fork 上下文（消息历史 + 工具列表），用于子 Agent 共享 prompt cache */
  getParentContext?: () => {
    messages: import('../../ai.service').AiMessage[]
    tools: import('../../ai.service').ToolDefinition[]
  } | undefined
  /**
   * 切换 Agent 当前默认操作的 ptyId（写入 run.ptyId / run.context.ptyId）。
   *
   * 用途：分屏场景下 focus_pane / close_pane 关掉当前窗格后，让 Agent 的"操作指针"
   * 无缝迁移到剩余的某个窗格，不必依赖 args.pane_id 显式指定。
   */
  setCurrentPtyId?: (ptyId: string) => void
  /**
   * 读取 Agent 当前默认操作的 ptyId（即 run.ptyId / Agent 的 owner pty）。
   *
   * 用途：工具失败诊断时反查 Agent 所在 tab——例如 paneGoneResult 在目标
   * 窗格已死的情况下，需要用"还活着的 owner ptyId"找到对应 tab 拉最新窗格列表。
   * 不能依赖入参里那个目标 ptyId，因为它可能恰好就是已死的那个。
   */
  getCurrentPtyId?: () => string | undefined
}

/** 常见图片扩展名（AI Vision 模型可直接处理的格式） */
export const VISION_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'
])

/** 扩展名到 MIME 类型映射 */
export const IMAGE_MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp'
}

/** 需要转换后才能发给 Vision 模型的图片格式 */
export const CONVERTIBLE_IMAGE_EXTENSIONS = new Set(['.ico'])

// 重新导出常用类型
export type { AgentConfig, AgentStep, ToolResult, RiskLevel, AgentPlan }
