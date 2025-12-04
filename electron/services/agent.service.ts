import { AiService, AiMessage, ToolDefinition, ToolCall, ChatWithToolsResult } from './ai.service'
import { CommandExecutorService, CommandResult } from './command-executor.service'
import * as fs from 'fs'
import * as path from 'path'

// Agent 配置
export interface AgentConfig {
  enabled: boolean
  maxSteps: number              // 最大执行步数，默认 20
  commandTimeout: number        // 命令超时时间（毫秒），默认 30000
  autoExecuteSafe: boolean      // safe 命令自动执行
  autoExecuteModerate: boolean  // moderate 命令是否自动执行
}

// 命令风险等级
export type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked'

// Agent 执行步骤
export interface AgentStep {
  id: string
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'confirm'
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: RiskLevel
  timestamp: number
}

// Agent 上下文
export interface AgentContext {
  ptyId: string
  terminalOutput: string[]  // 最近的终端输出
  systemInfo: {
    os: string
    shell: string
  }
  historyMessages?: { role: string; content: string }[]  // 历史对话记录
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
}

export class AgentService {
  private aiService: AiService
  private commandExecutor: CommandExecutorService
  private runs: Map<string, AgentRun> = new Map()

  // 事件回调
  private onStepCallback?: (agentId: string, step: AgentStep) => void
  private onNeedConfirmCallback?: (confirmation: PendingConfirmation) => void
  private onCompleteCallback?: (agentId: string, result: string) => void
  private onErrorCallback?: (agentId: string, error: string) => void

  // 默认配置
  private readonly defaultConfig: AgentConfig = {
    enabled: true,
    maxSteps: 20,
    commandTimeout: 30000,
    autoExecuteSafe: true,
    autoExecuteModerate: true
  }

  constructor(aiService: AiService) {
    this.aiService = aiService
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
  }): void {
    this.onStepCallback = callbacks.onStep
    this.onNeedConfirmCallback = callbacks.onNeedConfirm
    this.onCompleteCallback = callbacks.onComplete
    this.onErrorCallback = callbacks.onError
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
          toolArgs: args,
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

        // 检查是否需要确认
        const needConfirm = 
          (riskLevel === 'dangerous') ||
          (riskLevel === 'moderate' && !config.autoExecuteModerate) ||
          (riskLevel === 'safe' && !config.autoExecuteSafe)

        if (needConfirm) {
          // 等待用户确认
          const approved = await this.waitForConfirmation(agentId, toolCall.id, name, args, riskLevel)
          if (!approved) {
            return { success: false, output: '', error: '用户拒绝执行该命令' }
          }
        }

        // 执行命令（在后台静默执行，不干扰用户终端）
        try {
          const result: CommandResult = await this.commandExecutor.execute(
            command,
            undefined,  // 使用默认工作目录
            config.commandTimeout
          )

          const stepContent = result.aborted 
            ? `命令执行超时或被中止` 
            : `命令执行完成 (退出码: ${result.exitCode}, 耗时: ${result.duration}ms)`

          this.addStep(agentId, {
            type: 'tool_result',
            content: stepContent,
            toolName: name,
            toolResult: result.output
          })

          return {
            success: result.exitCode === 0 && !result.aborted,
            output: result.output || '(无输出)',
            error: result.aborted ? '命令执行超时' : undefined
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : '执行失败'
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
      config: fullConfig
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

        // 调用 AI
        const response = await this.aiService.chatWithTools(
          run.messages,
          this.getTools(),
          profileId
        )
        lastResponse = response

        // 处理 AI 响应
        if (response.content) {
          this.addStep(agentId, {
            type: 'message',
            content: response.content
          })
        }

        // 检查是否有工具调用
        if (response.tool_calls && response.tool_calls.length > 0) {
          // 将 assistant 消息（包含 tool_calls）添加到历史
          run.messages.push({
            role: 'assistant',
            content: response.content || '',
            tool_calls: response.tool_calls
          })

          // 执行每个工具调用
          for (const toolCall of response.tool_calls) {
            if (run.aborted) break

            const result = await this.executeTool(
              agentId,
              ptyId,
              toolCall,
              fullConfig,
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
    const osInfo = context.systemInfo.os || 'unknown'
    const shellInfo = context.systemInfo.shell || 'unknown'

    return `你是旗鱼终端的 AI Agent 助手。你可以帮助用户在终端中执行任务。

## 环境信息
- 操作系统: ${osInfo}
- Shell: ${shellInfo}

## 可用工具
- execute_command: 在终端执行命令，用户可以看到执行过程
- get_terminal_context: 获取终端最近的输出
- read_file: 读取文件内容
- write_file: 写入文件

## 工作原则
1. 在执行命令前，先理解用户的意图
2. 分步执行复杂任务，每步执行后检查结果
3. 遇到错误时尝试诊断原因并提供解决方案
4. 危险操作会请求用户确认，你应该解释为什么需要执行该操作
5. 保持回复简洁，重点是完成任务

请根据用户的需求，使用合适的工具来完成任务。`
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
   * 清理已完成的运行记录
   */
  cleanup(agentId: string): void {
    this.runs.delete(agentId)
  }
}

