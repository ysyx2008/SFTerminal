import { AiService, AiMessage, ToolDefinition, ToolCall, ChatWithToolsResult } from './ai.service'
import { CommandExecutorService, CommandResult } from './command-executor.service'
import { PtyService } from './pty.service'
import * as fs from 'fs'
import * as path from 'path'

// Agent 配置
export interface AgentConfig {
  enabled: boolean
  maxSteps: number              // 最大执行步数，默认 20
  commandTimeout: number        // 命令超时时间（毫秒），默认 30000
  autoExecuteSafe: boolean      // safe 命令自动执行
  autoExecuteModerate: boolean  // moderate 命令是否自动执行
  strictMode: boolean           // 严格模式：所有命令都需确认，在终端执行
}

// 命令风险等级
export type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked'

// Agent 执行步骤
export interface AgentStep {
  id: string
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'confirm' | 'streaming'
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: RiskLevel
  timestamp: number
  isStreaming?: boolean  // 是否正在流式输出
}

// Agent 上下文
export interface AgentContext {
  ptyId: string
  terminalOutput: string[]  // 最近的终端输出
  systemInfo: {
    os: string
    shell: string
  }
  hostId?: string  // 主机档案 ID
  historyMessages?: { role: string; content: string }[]  // 历史对话记录
  documentContext?: string  // 用户上传的文档内容
}

// 工具执行结果
export interface ToolResult {
  success: boolean
  output: string
  error?: string
}

// 待确认的工具调用
export interface PendingConfirmation {
  agentId: string
  toolCallId: string
  toolName: string
  toolArgs: Record<string, unknown>
  riskLevel: RiskLevel
  resolve: (approved: boolean, modifiedArgs?: Record<string, unknown>) => void
}

// Agent 运行状态
interface AgentRun {
  id: string
  ptyId: string
  messages: AiMessage[]
  steps: AgentStep[]
  isRunning: boolean
  aborted: boolean
  pendingConfirmation?: PendingConfirmation
  config: AgentConfig
  context: AgentContext  // 运行上下文
}

export class AgentService {
  private aiService: AiService
  private commandExecutor: CommandExecutorService
  private ptyService: PtyService
  private hostProfileService?: { 
    generateHostContext: (hostId: string) => string
    addNote: (hostId: string, note: string) => void
    getProfile: (hostId: string) => { 
      os?: string
      osVersion?: string
      shell?: string
      hostname?: string
      installedTools?: string[]
      notes?: string[]
    } | null
  }
  private runs: Map<string, AgentRun> = new Map()

  // 事件回调
  private onStepCallback?: (agentId: string, step: AgentStep) => void
  private onNeedConfirmCallback?: (confirmation: PendingConfirmation) => void
  private onCompleteCallback?: (agentId: string, result: string) => void
  private onErrorCallback?: (agentId: string, error: string) => void
  private onTextChunkCallback?: (agentId: string, chunk: string) => void  // 流式文本回调

  // 默认配置
  private readonly defaultConfig: AgentConfig = {
    enabled: true,
    maxSteps: 20,
    commandTimeout: 30000,
    autoExecuteSafe: true,
    autoExecuteModerate: true,
    strictMode: false           // 默认关闭严格模式
  }

  constructor(
    aiService: AiService, 
    ptyService: PtyService,
    hostProfileService?: { 
      generateHostContext: (hostId: string) => string
      addNote: (hostId: string, note: string) => void
      getProfile: (hostId: string) => { 
        os?: string
        osVersion?: string
        shell?: string
        hostname?: string
        installedTools?: string[]
        notes?: string[]
      } | null
    }
  ) {
    this.aiService = aiService
    this.ptyService = ptyService
    this.hostProfileService = hostProfileService
    this.commandExecutor = new CommandExecutorService()
  }

  /**
   * 设置事件回调
   */
  setCallbacks(callbacks: {
    onStep?: (agentId: string, step: AgentStep) => void
    onNeedConfirm?: (confirmation: PendingConfirmation) => void
    onComplete?: (agentId: string, result: string) => void
    onError?: (agentId: string, error: string) => void
    onTextChunk?: (agentId: string, chunk: string) => void  // 流式文本回调
  }): void {
    this.onStepCallback = callbacks.onStep
    this.onNeedConfirmCallback = callbacks.onNeedConfirm
    this.onCompleteCallback = callbacks.onComplete
    this.onErrorCallback = callbacks.onError
    this.onTextChunkCallback = callbacks.onTextChunk
  }

  /**
   * 获取可用工具定义
   */
  private getTools(): ToolDefinition[] {
    return [
      {
        type: 'function',
        function: {
          name: 'execute_command',
          description: '在当前终端执行 shell 命令。命令会在用户可见的终端中执行，用户可以看到完整的执行过程。',
          parameters: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: '要执行的 shell 命令'
              }
            },
            required: ['command']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_terminal_context',
          description: '获取终端最近的输出内容，用于了解当前终端状态和之前命令的执行结果。',
          parameters: {
            type: 'object',
            properties: {
              lines: {
                type: 'string',
                description: '要获取的行数，默认 50'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: '读取文件内容',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: '文件路径（绝对路径或相对于当前目录）'
              }
            },
            required: ['path']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: '写入或创建文件',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: '文件路径'
              },
              content: {
                type: 'string',
                description: '文件内容'
              }
            },
            required: ['path', 'content']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'remember_info',
          description: `记住用户项目的关键路径。只在发现用户自定义的、非常规的配置或日志路径时使用。不要记录系统默认路径（如/etc/nginx/）或动态信息。`,
          parameters: {
            type: 'object',
            properties: {
              info: {
                type: 'string',
                description: '用户项目的关键路径（如"项目配置在/data/myapp/config/"）'
              }
            },
            required: ['info']
          }
        }
      }
    ]
  }

  /**
   * 评估命令风险等级
   */
  assessCommandRisk(command: string): RiskLevel {
    const cmd = command.toLowerCase().trim()

    // 黑名单 - 直接拒绝
    const blocked = [
      /rm\s+(-[rf]+\s+)*\/(?:\s|$)/,    // rm -rf /
      /rm\s+(-[rf]+\s+)*\/\*/,           // rm -rf /*
      /:\(\)\{.*:\|:.*\}/,               // fork bomb
      /mkfs\./,                           // 格式化磁盘
      /dd\s+.*of=\/dev\/[sh]d[a-z]/,     // dd 写入磁盘
      />\s*\/dev\/[sh]d[a-z]/,           // 重定向到磁盘
      /chmod\s+777\s+\//,                 // chmod 777 /
      /chown\s+.*\s+\//                   // chown /
    ]
    if (blocked.some(p => p.test(cmd))) return 'blocked'

    // 高危 - 需要确认
    const dangerous = [
      /\brm\s+(-[rf]+\s+)*/,             // rm 命令
      /\bkill\s+(-9\s+)?/,               // kill 命令
      /\bkillall\b/,                      // killall
      /\bpkill\b/,                        // pkill
      /\bchmod\s+/,                       // chmod
      /\bchown\s+/,                       // chown
      /\bshutdown\b/,                     // shutdown
      /\breboot\b/,                       // reboot
      /\bhalt\b/,                         // halt
      /\bpoweroff\b/,                     // poweroff
      /\bsystemctl\s+(stop|restart|disable)/, // systemctl 危险操作
      /\bservice\s+\w+\s+(stop|restart)/,     // service 停止/重启
      /\bapt\s+remove/,                   // apt remove
      /\byum\s+remove/,                   // yum remove
      /\bdnf\s+remove/,                   // dnf remove
      />\s*\/etc\//,                      // 重定向到 /etc
      />\s*\/var\//                       // 重定向到 /var
    ]
    if (dangerous.some(p => p.test(cmd))) return 'dangerous'

    // 中危 - 显示但可自动执行
    const moderate = [
      /\bmv\s+/,                          // mv
      /\bcp\s+/,                          // cp
      /\bmkdir\s+/,                       // mkdir
      /\btouch\s+/,                       // touch
      /\bsystemctl\s+(start|enable|status)/, // systemctl 非危险操作
      /\bservice\s+\w+\s+start/,          // service start
      /\bapt\s+install/,                  // apt install
      /\byum\s+install/,                  // yum install
      /\bdnf\s+install/,                  // dnf install
      /\bnpm\s+install/,                  // npm install
      /\bpip\s+install/,                  // pip install
      /\bgit\s+(pull|push|commit)/        // git 修改操作
    ]
    if (moderate.some(p => p.test(cmd))) return 'moderate'

    // 安全 - 直接执行
    return 'safe'
  }

  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    return `agent_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
  }

  /**
   * 添加执行步骤
   */
  private addStep(agentId: string, step: Omit<AgentStep, 'id' | 'timestamp'>): AgentStep {
    const run = this.runs.get(agentId)
    if (!run) return step as AgentStep

    const fullStep: AgentStep = {
      ...step,
      id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now()
    }
    run.steps.push(fullStep)

    // 触发回调
    if (this.onStepCallback) {
      this.onStepCallback(agentId, fullStep)
    }

    return fullStep
  }

  /**
   * 更新执行步骤（用于流式输出）
   */
  private updateStep(agentId: string, stepId: string, updates: Partial<Omit<AgentStep, 'id' | 'timestamp'>>): void {
    const run = this.runs.get(agentId)
    if (!run) return

    // 查找现有步骤
    let step = run.steps.find(s => s.id === stepId)
    
    if (!step) {
      // 如果步骤不存在，创建一个新的
      step = {
        id: stepId,
        type: updates.type || 'message',
        content: updates.content || '',
        timestamp: Date.now(),
        isStreaming: updates.isStreaming
      }
      run.steps.push(step)
    } else {
      // 更新现有步骤
      Object.assign(step, updates)
    }

    // 触发回调
    if (this.onStepCallback) {
      this.onStepCallback(agentId, step)
    }
  }

  /**
   * 执行工具调用
   */
  private async executeTool(
    agentId: string,
    ptyId: string,
    toolCall: ToolCall,
    config: AgentConfig,
    terminalOutput: string[]
  ): Promise<ToolResult> {
    const run = this.runs.get(agentId)
    if (!run || run.aborted) {
      return { success: false, output: '', error: '操作已中止' }
    }

    const { name, arguments: argsStr } = toolCall.function
    let args: Record<string, unknown>
    
    try {
      args = JSON.parse(argsStr)
    } catch {
      return { success: false, output: '', error: '工具参数解析失败' }
    }

    // 根据工具类型执行
    switch (name) {
      case 'execute_command': {
        const command = args.command as string
        if (!command) {
          return { success: false, output: '', error: '命令不能为空' }
        }

        // 评估风险
        const riskLevel = this.assessCommandRisk(command)

        // 添加工具调用步骤
        this.addStep(agentId, {
          type: 'tool_call',
          content: `执行命令: ${command}`,
          toolName: name,
          toolArgs: { command },
          riskLevel
        })

        // 检查是否被阻止
        if (riskLevel === 'blocked') {
          return { 
            success: false, 
            output: '', 
            error: '该命令被安全策略阻止执行' 
          }
        }

        // 严格模式：所有命令都需要确认
        // 普通模式：根据风险级别决定
        const needConfirm = config.strictMode ||
          (riskLevel === 'dangerous') ||
          (riskLevel === 'moderate' && !config.autoExecuteModerate) ||
          (riskLevel === 'safe' && !config.autoExecuteSafe)

        if (needConfirm) {
          // 等待用户确认
          const approved = await this.waitForConfirmation(agentId, toolCall.id, name, args, riskLevel)
          if (!approved) {
            // 添加拒绝步骤
            this.addStep(agentId, {
              type: 'tool_result',
              content: '⛔ 用户拒绝执行此命令',
              toolName: name,
              toolResult: '已拒绝'
            })
            return { success: false, output: '', error: '用户拒绝执行该命令' }
          }
        }

        // 在终端执行命令（用户可以看到输入和输出）
        // 严格模式和宽松模式都在终端执行，区别只是确认机制
        try {
          const result = await this.ptyService.executeInTerminal(
            ptyId,
            command,
            config.commandTimeout
          )

          this.addStep(agentId, {
            type: 'tool_result',
            content: `命令执行完成 (耗时: ${result.duration}ms)`,
            toolName: name,
            toolResult: result.output
          })

          return {
            success: true,
            output: result.output
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : '命令执行失败'
          this.addStep(agentId, {
            type: 'tool_result',
            content: `命令执行失败: ${errorMsg}`,
            toolName: name,
            toolResult: errorMsg
          })
          return { success: false, output: '', error: errorMsg }
        }
      }

      case 'get_terminal_context': {
        const lines = parseInt(args.lines as string) || 50
        const output = terminalOutput.slice(-lines).join('\n')
        
        this.addStep(agentId, {
          type: 'tool_result',
          content: `获取终端最近 ${lines} 行输出`,
          toolName: name,
          toolResult: output.substring(0, 500) + (output.length > 500 ? '...' : '')
        })

        return { success: true, output: output || '(终端输出为空)' }
      }

      case 'read_file': {
        const filePath = args.path as string
        if (!filePath) {
          return { success: false, output: '', error: '文件路径不能为空' }
        }

        this.addStep(agentId, {
          type: 'tool_call',
          content: `读取文件: ${filePath}`,
          toolName: name,
          toolArgs: args,
          riskLevel: 'safe'
        })

        try {
          const content = fs.readFileSync(filePath, 'utf-8')
          this.addStep(agentId, {
            type: 'tool_result',
            content: `文件读取成功 (${content.length} 字符)`,
            toolName: name,
            toolResult: content.substring(0, 500) + (content.length > 500 ? '...' : '')
          })
          return { success: true, output: content }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : '读取失败'
          return { success: false, output: '', error: errorMsg }
        }
      }

      case 'write_file': {
        const filePath = args.path as string
        const content = args.content as string
        if (!filePath) {
          return { success: false, output: '', error: '文件路径不能为空' }
        }

        // 文件写入需要确认
        this.addStep(agentId, {
          type: 'tool_call',
          content: `写入文件: ${filePath}`,
          toolName: name,
          toolArgs: { path: filePath, content: content?.substring(0, 100) + '...' },
          riskLevel: 'moderate'
        })

        // 等待确认
        const approved = await this.waitForConfirmation(agentId, toolCall.id, name, args, 'moderate')
        if (!approved) {
          return { success: false, output: '', error: '用户拒绝写入文件' }
        }

        try {
          // 确保目录存在
          const dir = path.dirname(filePath)
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
          }
          fs.writeFileSync(filePath, content, 'utf-8')
          this.addStep(agentId, {
            type: 'tool_result',
            content: `文件写入成功`,
            toolName: name
          })
          return { success: true, output: `文件已写入: ${filePath}` }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : '写入失败'
          return { success: false, output: '', error: errorMsg }
        }
      }

      case 'remember_info': {
        const info = args.info as string
        if (!info) {
          return { success: false, output: '', error: '信息不能为空' }
        }

        // 过滤动态信息
        const dynamicPatterns = [
          /端口/i, /port/i, /监听/i, /listen/i,
          /进程/i, /process/i, /pid/i,
          /运行中/i, /running/i, /stopped/i, /状态/i,
          /使用率/i, /占用/i, /usage/i,
          /\d+%/, /\d+mb/i, /\d+gb/i,
          /连接/i, /connection/i
        ]
        
        const isDynamic = dynamicPatterns.some(p => p.test(info))
        const hasPath = info.includes('/') || info.includes('\\')
        
        if (isDynamic || !hasPath) {
          this.addStep(agentId, {
            type: 'tool_result',
            content: `跳过: "${info}" (动态信息或非路径)`,
            toolName: name
          })
          return { success: true, output: '此信息为动态信息，不适合长期记忆' }
        }

        this.addStep(agentId, {
          type: 'tool_call',
          content: `记住信息: ${info}`,
          toolName: name,
          toolArgs: args,
          riskLevel: 'safe'
        })

        // 保存到主机档案
        const run = this.runs.get(agentId)
        if (run?.context.hostId && this.hostProfileService) {
          this.hostProfileService.addNote(run.context.hostId, info)
        }

        this.addStep(agentId, {
          type: 'tool_result',
          content: `已记住: ${info}`,
          toolName: name
        })

        return { success: true, output: `信息已保存到主机档案` }
      }

      default:
        return { success: false, output: '', error: `未知工具: ${name}` }
    }
  }

  /**
   * 等待用户确认
   */
  private waitForConfirmation(
    agentId: string,
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    riskLevel: RiskLevel
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const run = this.runs.get(agentId)
      if (!run) {
        resolve(false)
        return
      }

      // 添加确认步骤
      this.addStep(agentId, {
        type: 'confirm',
        content: `等待用户确认: ${toolName}`,
        toolName,
        toolArgs,
        riskLevel
      })

      const confirmation: PendingConfirmation = {
        agentId,
        toolCallId,
        toolName,
        toolArgs,
        riskLevel,
        resolve: (approved, modifiedArgs) => {
          run.pendingConfirmation = undefined
          if (modifiedArgs) {
            Object.assign(toolArgs, modifiedArgs)
          }
          resolve(approved)
        }
      }

      run.pendingConfirmation = confirmation

      // 通知前端需要确认
      if (this.onNeedConfirmCallback) {
        this.onNeedConfirmCallback(confirmation)
      }
    })
  }

  /**
   * 处理用户确认
   */
  confirmToolCall(
    agentId: string,
    toolCallId: string,
    approved: boolean,
    modifiedArgs?: Record<string, unknown>
  ): boolean {
    const run = this.runs.get(agentId)
    if (!run || !run.pendingConfirmation) return false

    if (run.pendingConfirmation.toolCallId === toolCallId) {
      run.pendingConfirmation.resolve(approved, modifiedArgs)
      return true
    }
    return false
  }

  /**
   * 运行 Agent
   */
  async run(
    ptyId: string,
    userMessage: string,
    context: AgentContext,
    config?: Partial<AgentConfig>,
    profileId?: string
  ): Promise<string> {
    const agentId = this.generateId()
    const fullConfig = { ...this.defaultConfig, ...config }

    // 初始化运行状态
    const run: AgentRun = {
      id: agentId,
      ptyId,
      messages: [],
      steps: [],
      isRunning: true,
      aborted: false,
      config: fullConfig,
      context  // 保存上下文供工具使用
    }
    this.runs.set(agentId, run)

    // 构建系统提示
    const systemPrompt = this.buildSystemPrompt(context)
    run.messages.push({ role: 'system', content: systemPrompt })

    // 添加历史对话（保持 Agent 记忆）
    if (context.historyMessages && context.historyMessages.length > 0) {
      // 只保留最近的对话历史，避免超出上下文限制
      const recentHistory = context.historyMessages.slice(-10)
      for (const msg of recentHistory) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          run.messages.push({ 
            role: msg.role as 'user' | 'assistant', 
            content: msg.content 
          })
        }
      }
    }

    // 添加当前用户消息
    run.messages.push({ role: 'user', content: userMessage })

    // 添加开始步骤
    this.addStep(agentId, {
      type: 'thinking',
      content: '正在分析任务...'
    })

    let stepCount = 0
    let lastResponse: ChatWithToolsResult | null = null

    try {
      // Agent 执行循环
      while (stepCount < fullConfig.maxSteps && run.isRunning && !run.aborted) {
        stepCount++

        // 创建流式消息步骤
        const streamStepId = this.generateId()
        let streamContent = ''
        
        // 使用流式 API 调用 AI
        const response = await new Promise<ChatWithToolsResult>((resolve, reject) => {
          this.aiService.chatWithToolsStream(
            run.messages,
            this.getTools(),
            // onChunk: 流式文本更新
            (chunk) => {
              streamContent += chunk
              // 发送流式更新
              this.updateStep(agentId, streamStepId, {
                type: 'message',
                content: streamContent,
                isStreaming: true
              })
            },
            // onToolCall: 工具调用（流式结束时）
            (_toolCalls) => {
              // 工具调用会在 onDone 中处理
            },
            // onDone: 完成
            (result) => {
              // 标记流式结束
              if (streamContent) {
                this.updateStep(agentId, streamStepId, {
                  type: 'message',
                  content: streamContent,
                  isStreaming: false
                })
              }
              resolve(result)
            },
            // onError: 错误
            (error) => {
              reject(new Error(error))
            },
            profileId
          )
        })
        
        lastResponse = response

        // 如果没有流式内容但有最终内容，添加消息步骤
        if (!streamContent && response.content) {
          this.addStep(agentId, {
            type: 'message',
            content: response.content
          })
        }

        // 检查是否有工具调用
        if (response.tool_calls && response.tool_calls.length > 0) {
          // 将 assistant 消息（包含 tool_calls 和 reasoning_content）添加到历史
          // DeepSeek think 模型要求后续消息必须包含 reasoning_content
          const assistantMsg: AiMessage = {
            role: 'assistant',
            content: response.content || '',  // 不使用 streamContent，因为它包含 HTML 标签
            tool_calls: response.tool_calls
          }
          // 如果有思考内容，添加到消息中（DeepSeek think 模型要求）
          if (response.reasoning_content) {
            assistantMsg.reasoning_content = response.reasoning_content
          }
          run.messages.push(assistantMsg)

          // 执行每个工具调用
          for (const toolCall of response.tool_calls) {
            if (run.aborted) break

            const result = await this.executeTool(
              agentId,
              ptyId,
              toolCall,
              run.config,  // 使用运行时配置，支持动态更新
              context.terminalOutput
            )

            // 将工具结果添加到消息历史
            run.messages.push({
              role: 'tool',
              content: result.success 
                ? result.output 
                : `错误: ${result.error}`,
              tool_call_id: toolCall.id
            })
          }
        } else {
          // 没有工具调用，Agent 完成
          break
        }
      }

      // 完成
      run.isRunning = false
      const finalMessage = lastResponse?.content || '任务完成'

      if (this.onCompleteCallback) {
        this.onCompleteCallback(agentId, finalMessage)
      }

      return finalMessage

    } catch (error) {
      run.isRunning = false
      const errorMsg = error instanceof Error ? error.message : '未知错误'
      
      this.addStep(agentId, {
        type: 'error',
        content: `执行出错: ${errorMsg}`
      })

      if (this.onErrorCallback) {
        this.onErrorCallback(agentId, errorMsg)
      }

      throw error
    }
  }

  /**
   * 构建系统提示
   */
  private buildSystemPrompt(context: AgentContext): string {
    // 优先使用 context.systemInfo（来自当前终端 tab，是准确的）
    const osType = context.systemInfo.os || 'unknown'
    const shellType = context.systemInfo.shell || 'unknown'
    
    // 构建主机信息：始终使用当前终端的系统信息
    let hostContext = `## 主机信息
- 操作系统: ${osType}
- Shell: ${shellType}`
    
    // 如果有主机档案，补充额外信息（但不覆盖系统类型）
    if (context.hostId && this.hostProfileService) {
      const profile = this.hostProfileService.getProfile(context.hostId)
      if (profile) {
        if (profile.hostname) {
          hostContext = `## 主机信息
- 主机名: ${profile.hostname}
- 操作系统: ${osType}
- Shell: ${shellType}`
        }
        if (profile.installedTools && profile.installedTools.length > 0) {
          hostContext += `\n- 已安装工具: ${profile.installedTools.join(', ')}`
        }
        if (profile.notes && profile.notes.length > 0) {
          hostContext += '\n\n## 已知信息（来自历史交互）'
          for (const note of profile.notes.slice(-10)) {
            hostContext += `\n- ${note}`
          }
        }
      }
    }

    // 根据操作系统类型选择示例命令
    const isWindows = osType.toLowerCase().includes('windows')
    const diskSpaceExample = isWindows 
      ? `用户：查看磁盘空间

你的回复：
"我来检查磁盘空间使用情况。首先查看各分区的使用率。"
[调用 execute_command: wmic logicaldisk get size,freespace,caption]

收到结果后：
"从输出可以看到 C: 盘可用空间较少。让我看看哪些文件夹占用最多空间。"
[调用 execute_command: powershell "Get-ChildItem C:\\ -Directory | ForEach-Object { $size = (Get-ChildItem $_.FullName -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum; [PSCustomObject]@{Name=$_.Name;Size=[math]::Round($size/1GB,2)} } | Sort-Object Size -Descending | Select-Object -First 10"]`
      : `用户：查看磁盘空间

你的回复：
"我来检查磁盘空间使用情况。首先查看各分区的使用率。"
[调用 execute_command: df -h]

收到结果后：
"从输出可以看到 /dev/sda1 使用了 85%，接近满了。让我看看哪些目录占用最多空间。"
[调用 execute_command: du -sh /* 2>/dev/null | sort -rh | head -10]`

    // 文档上下文
    let documentSection = ''
    let documentRule = ''
    if (context.documentContext) {
      documentSection = `\n\n${context.documentContext}`
      documentRule = `
8. **关于用户上传的文档**：如果用户上传了文档，文档内容已经包含在本对话的上下文末尾（标记为"用户上传的参考文档"），请直接阅读和引用这些内容，**不要使用 read_file 工具去读取上传的文档**`
    }

    return `你是旗鱼终端的 AI Agent 助手。你可以帮助用户在终端中执行任务。

${hostContext}

## 可用工具
- execute_command: 在终端执行命令
- get_terminal_context: 获取终端最近的输出
- read_file: 读取服务器上的文件内容（注意：不是用于读取用户上传的文档）
- write_file: 写入文件
- remember_info: 记住重要信息供以后参考

## 工作原则（重要！）
1. **先分析，再执行**：在调用任何工具前，先用文字说明你的分析和计划
2. **解释上一步结果**：执行命令后，分析输出结果，说明发现了什么
3. **说明下一步原因**：在执行下一个命令前，解释为什么需要这个命令
4. 分步执行复杂任务，每步执行后检查结果
5. 遇到错误时分析原因并提供解决方案
6. **主动记忆**：发现静态路径信息时（如配置文件位置、日志目录），使用 remember_info 保存。注意：只记录路径，不要记录端口、进程、状态等动态信息
7. **根据操作系统使用正确的命令**：当前系统是 ${osType}，请使用该系统对应的命令${documentRule}

## 输出格式示例
${diskSpaceExample}
${documentSection}
请根据用户的需求，使用合适的工具来完成任务。记住：每次调用工具前都要先说明分析和原因！`
  }

  /**
   * 中止 Agent 执行
   */
  abort(agentId: string): boolean {
    const run = this.runs.get(agentId)
    if (!run) return false

    run.aborted = true
    run.isRunning = false

    // 如果有待确认的操作，拒绝它
    if (run.pendingConfirmation) {
      run.pendingConfirmation.resolve(false)
    }

    // 中止所有正在执行的命令
    this.commandExecutor.abortAll()

    this.addStep(agentId, {
      type: 'error',
      content: '用户中止了 Agent 执行'
    })

    return true
  }

  /**
   * 获取 Agent 运行状态
   */
  getRunStatus(agentId: string): {
    isRunning: boolean
    steps: AgentStep[]
    pendingConfirmation?: PendingConfirmation
  } | null {
    const run = this.runs.get(agentId)
    if (!run) return null

    return {
      isRunning: run.isRunning,
      steps: run.steps,
      pendingConfirmation: run.pendingConfirmation
    }
  }

  /**
   * 更新运行中的 Agent 配置（如严格模式）
   */
  updateConfig(agentId: string, config: Partial<AgentConfig>): boolean {
    const run = this.runs.get(agentId)
    if (!run) return false

    // 合并配置
    run.config = { ...run.config, ...config }
    return true
  }

  /**
   * 清理已完成的运行记录
   */
  cleanup(agentId: string): void {
    this.runs.delete(agentId)
  }
}

