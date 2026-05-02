/**
 * Agent 服务
 * 
 * OOP 重构版本：AgentService 作为工厂和生命周期管理器
 * 实际执行逻辑在 Agent 基类和 SailFish 子类中
 */
import os from 'os'
import type { AiService } from '../ai.service'
import type { PtyService } from '../pty.service'
import type { SshService } from '../ssh.service'
import type { SftpService } from '../sftp.service'
import type { McpService } from '../mcp.service'
import type { ConfigService } from '../config.service'
import { UnifiedTerminalService } from '../unified-terminal.service'

import type {
  AgentConfig,
  AgentStep,
  AgentContext,
  AgentCallbacks,
  HostProfileServiceInterface,
  RiskLevel,
  AgentServices,
  RunStatus,
  AgentExecutionPhase
} from './types'
import { SailFish } from './sailfish'
import { assessCommandRisk, analyzeCommand } from './risk-assessor'
import type { CommandHandlingInfo } from './risk-assessor'
import { setConfigService as setI18nConfigService } from './i18n'
import { getTerminalStateService } from '../terminal-state.service'
import { createLogger } from '../../utils/logger'

const log = createLogger('AgentService')

// 重新导出类型，供外部使用
export type {
  AgentConfig,
  AgentStep,
  AgentContext,
  RiskLevel,
  CommandHandlingInfo,
  AgentServices,
  RunStatus
}
export { assessCommandRisk, analyzeCommand }

// 导出 Agent 类
export { Agent } from './agent'
export { SailFish } from './sailfish'
/** @deprecated Use SailFish instead */
export { SailFish as TerminalAgent } from './sailfish'

/**
 * Agent 服务 - 工厂和生命周期管理器
 * 
 * 概念模型（v2）：一个 tab = 一个 Agent + N 个终端窗格。
 *   - 终端 Agent：agentKey = tabId（前端的 tab.id，跨多个窗格稳定）
 *   - 助手 Agent：agentKey = agentId（前端生成的 UUID）
 *   - 固定 Agent：__companion__（IM/桌面）、__watch__（关切）
 *
 * Agent 实例的生命周期独立于底层 PTY/SSH。窗格关闭、SSH 断开都不应清理 Agent；
 * 只在 tab 关闭时由前端显式调 cleanupAgent(tabId) 清理。
 *
 * 职责：
 * - 创建和管理 SailFish 实例
 * - 管理全局回调
 */
export class AgentService {
  /** 陪伴 Agent 固定 ID：IM 对话、桌面助手共用同一实例 */
  static readonly COMPANION_AGENT_ID = '__companion__'
  /** Watch Agent 固定 ID：关切系统（含觉醒唤醒）独立实例，与 Companion 隔离 */
  static readonly WATCH_AGENT_ID = '__watch__'

  /** Agent 实例映射（按 agentKey 索引：终端 Agent 用 tabId，助手/固定 Agent 用 agentId） */
  private agents: Map<string, SailFish> = new Map()
  
  /** 依赖服务集合 */
  private services: AgentServices
  
  /** 默认回调 */
  private defaultCallbacks: AgentCallbacks = {}

  constructor(
    aiService: AiService, 
    ptyService: PtyService,
    hostProfileService?: HostProfileServiceInterface,
    mcpService?: McpService,
    configService?: ConfigService,
    sshService?: SshService,
    sftpService?: SftpService
  ) {
    // 创建统一终端服务
    let unifiedTerminalService: UnifiedTerminalService | undefined
    if (sshService) {
      unifiedTerminalService = new UnifiedTerminalService(ptyService, sshService)
    }
    
    // 组装服务集合
    this.services = {
      aiService,
      ptyService,
      sshService,
      sftpService,
      unifiedTerminalService,
      hostProfileService,
      mcpService,
      configService
    }
    
    // 初始化 i18n
    if (configService) {
      setI18nConfigService(configService)
    }
  }
  
  // ==================== 服务设置（延迟初始化） ====================

  /**
   * 设置 SSH 服务
   */
  setSshService(sshService: SshService): void {
    this.services.sshService = sshService
    if (this.services.ptyService) {
      this.services.unifiedTerminalService = new UnifiedTerminalService(
        this.services.ptyService, 
        sshService
      )
    }
  }

  /**
   * 设置 SFTP 服务
   */
  setSftpService(sftpService: SftpService): void {
    this.services.sftpService = sftpService
  }

  /**
   * 设置 MCP 服务
   */
  setMcpService(mcpService: McpService): void {
    this.services.mcpService = mcpService
  }

  /**
   * 设置历史记录服务
   */
  setHistoryService(historyService: import('../history.service').HistoryService): void {
    this.services.historyService = historyService
  }

  /**
   * 设置插件注册表
   */
  setPluginRegistry(pluginRegistry: import('../plugin/registry').PluginRegistry): void {
    this.services.pluginRegistry = pluginRegistry
  }

  // ==================== 工厂方法 ====================

  /**
   * 获取或创建 Agent 实例
   *
   * @param agentKey Agent 标识符。终端 Agent 传 tabId，固定 Agent 传 __companion__/__watch__。
   *   形参名保留为 ptyId 仅为向后兼容；新代码请按 agentKey 语义传入。
   */
  getOrCreateAgent(ptyId: string): SailFish {
    let agent = this.agents.get(ptyId)
    if (!agent) {
      agent = new SailFish(this.services, ptyId)
      agent.setCallbacks(this.defaultCallbacks)
      this.agents.set(ptyId, agent)
      log.info(`Created agent: agentKey=${ptyId}`)
    }
    return agent
  }

  /**
   * 获取 Agent 实例（不创建）
   * @param ptyId 实际语义为 agentKey（终端 = tabId，助手 = agentId UUID）
   */
  getAgent(ptyId: string): SailFish | undefined {
    return this.agents.get(ptyId)
  }

  /**
   * 检查是否存在 Agent 实例
   * @param ptyId 实际语义为 agentKey
   */
  hasAgent(ptyId: string): boolean {
    return this.agents.has(ptyId)
  }
  
  /**
   * 创建独立助手 Agent（无终端绑定）
   */
  createAssistantAgent(agentId: string): SailFish {
    let agent = this.agents.get(agentId)
    if (!agent) {
      agent = new SailFish(this.services)
      agent.setAgentId(agentId)
      agent.setCallbacks(this.defaultCallbacks)
      this.agents.set(agentId, agent)
      log.info(`Created assistant agent: ${agentId}`)
    }
    return agent
  }

  /**
   * 运行独立助手 Agent
   */
  async runAssistant(
    agentId: string,
    userMessage: string,
    context: AgentContext,
    config?: Partial<AgentConfig>,
    profileId?: string,
    callbacks?: AgentCallbacks
  ): Promise<string> {
    const agent = this.createAssistantAgent(agentId)
    
    if (config) {
      agent.updateConfig(config)
    }
    
    // assistant 模式无终端，用 HOME 目录兜底（避免系统提示词显示"未成功获取"触发 AI 执行 pwd）
    const enrichedContext: AgentContext = {
      ...context,
      cwd: context.cwd || os.homedir()
    }
    
    return agent.run(userMessage, enrichedContext, {
      profileId,
      callbacks
    })
  }

  // ==================== 生命周期管理 ====================

  /**
   * 清理 Agent 实例
   *
   * @param ptyId 实际语义为 agentKey（终端 = tabId，助手 = agentId UUID）。
   *   ⚠️ 不应在 PTY 销毁/SSH 断开时调用——Agent 与底层连接生命周期解耦。
   *   仅在以下场景调用：
   *   - 用户关闭 tab（前端 closeTab 显式触发）
   *   - Worker Agent 任务完成（与 worker 终端 1:1 绑定）
   *   - 固定 Agent 的 IM/Web 会话彻底结束
   */
  cleanupAgent(ptyId: string): void {
    const agent = this.agents.get(ptyId)
    if (agent) {
      agent.cleanup()
      this.agents.delete(ptyId)
      log.info(`Cleaned up agent: agentKey=${ptyId}`)
    }
  }

  /**
   * 清理所有 Agent 实例
   */
  cleanupAllAgents(): void {
    Array.from(this.agents.entries()).forEach(([agentKey, agent]) => {
      agent.cleanup()
      log.info(`Cleaned up agent: agentKey=${agentKey}`)
    })
    this.agents.clear()
  }

  // ==================== 全局设置 ====================
  
  /**
   * 设置默认回调
   */
  setCallbacks(callbacks: AgentCallbacks): void {
    this.defaultCallbacks = callbacks
    // 更新已存在的 agents
    Array.from(this.agents.values()).forEach(agent => {
      agent.setCallbacks(callbacks)
    })
  }

  // ==================== 便捷方法（向后兼容） ====================

  /**
   * 运行 Agent
   * 
   * 向后兼容的便捷方法，内部委托给 SailFish
   */
  async run(
    ptyId: string,
    userMessage: string,
    context: AgentContext,
    config?: Partial<AgentConfig>,
    profileId?: string,
    workerOptions?: import('./types').WorkerAgentOptions,
    callbacks?: AgentCallbacks
  ): Promise<string> {
    const agent = this.getOrCreateAgent(ptyId)
    
    // 更新配置
    if (config) {
      agent.updateConfig(config)
    }
    
    // 将 CWD 刷新延迟到 user_task 步骤发出之后，避免阻塞用户消息上墙
    const terminalStateService = getTerminalStateService()
    const cwdResolver = async () => {
      const cwd = await terminalStateService.refreshCwd(ptyId, 'initial')
      return (cwd && cwd !== '~') ? cwd : os.homedir()
    }
    
    return agent.run(userMessage, context, {
      profileId,
      workerOptions,
      callbacks,
      cwdResolver
    })
  }
  
  /**
   * 中止运行
   */
  abort(ptyId: string): boolean {
    const agent = this.getAgent(ptyId)
    return agent?.abort() ?? false
    }
    
  /**
   * 确认工具调用
   */
  confirmToolCall(
    ptyId: string,
    toolCallId: string,
    approved: boolean,
    modifiedArgs?: Record<string, unknown>,
    alwaysAllow?: boolean
  ): boolean {
    const agent = this.getAgent(ptyId)
    return agent?.confirmToolCall(toolCallId, approved, modifiedArgs, alwaysAllow) ?? false
  }
  
  /**
   * 添加用户消息
   */
  addUserMessage(ptyId: string, message: string, attachments?: import('@shared/types').AttachmentInfo[], documentContext?: string, images?: string[]): boolean {
    const agent = this.getAgent(ptyId)
    return agent?.addUserMessage(message, attachments, documentContext, images) ?? false
  }
  
  /**
   * 重置 Agent 会话状态（前端"新对话"时调用）
   */
  resetSession(ptyId: string): void {
    const agent = this.getAgent(ptyId)
    agent?.resetSession()
  }

  /**
   * 开始新的持久化会话（保留工作记忆，仅重置 session 追踪）
   */
  startNewSession(agentId: string): void {
    const agent = this.getAgent(agentId)
    agent?.startNewSession()
  }
  
  /**
   * 更新配置
   */
  updateConfig(ptyId: string, config: Partial<AgentConfig>): void {
    const agent = this.getAgent(ptyId)
    agent?.updateConfig(config)
  }
  
  /**
   * 获取运行状态
   */
  getRunStatus(ptyId: string): RunStatus | undefined {
    const agent = this.getAgent(ptyId)
    return agent?.getRunStatus()
  }

  /**
   * 获取执行阶段
   */
  getExecutionPhase(ptyId: string): AgentExecutionPhase {
    const agent = this.getAgent(ptyId)
    return agent?.getExecutionPhase() ?? 'idle'
  }

  /**
   * 检查是否正在运行
   */
  isRunning(ptyId: string): boolean {
    const agent = this.getAgent(ptyId)
    return agent?.isRunning() ?? false
  }
}
