/**
 * 并行子 Agent 执行器
 *
 * 主 Agent 通过 dispatch_agents 工具发起多个轻量子任务并行执行。
 * 每个子任务拥有独立的 AI 对话上下文和受限工具集，完成后将结果汇总返回。
 *
 * 设计要点：
 * - 子任务是轻量 ReAct 循环，非完整 Agent 实例（无会话/持久化/记忆）
 * - 受限工具集：文件读写、搜索、exec 等，不含终端操作和 dispatch_agents（防递归）
 * - 并发控制：Promise.allSettled + 可配置并发上限
 * - 进度推送：通过父 executor 的 addStep/updateStep 实时更新 subAgents 字段
 */
import type { AiService, AiMessage, ToolDefinition, ChatWithToolsResult } from '../../ai.service'
import type { SubAgentTask, SubAgentResult, SubAgentToolStep, TokenUsage } from '@shared/types'
import type { ToolExecutorConfig, ToolResult, AgentConfig } from './types'
import { executeTool } from './index'
import { getAgentTools } from '../tools'
import { truncateFromEnd } from './utils'
import { createLogger } from '../../../utils/logger'

const log = createLogger('SubAgent')

const MAX_SUB_AGENT_STEPS = 30
const DEFAULT_MAX_CONCURRENT = 5
const MAX_RESULT_LENGTH = 8000

// ==================== 子 Agent 可用的工具定义 ====================

/** 子 Agent 只读模式工具白名单 */
const SUB_AGENT_READONLY_TOOLS = new Set([
  'read_file', 'file_search', 'exec',
  'search_knowledge', 'get_knowledge_doc'
])

/** 子 Agent 读写模式额外工具 */
const SUB_AGENT_WRITE_TOOLS = new Set([
  'edit_file', 'write_text_file'
])

/** 子 Agent 工具描述覆盖（精简版，节省 token、避免无关上下文干扰） */
const SUB_AGENT_DESCRIPTION_OVERRIDES: Record<string, string> = {
  read_file: '读取本地文件内容。支持文本、PDF、Word、图片。大文件先用 info_only 查信息，再按行范围读取。',
  file_search: '快速搜索本地文件名（基于系统索引，毫秒级）。支持通配符 * 和 ?。仅搜文件名不搜内容，搜内容请用 exec + grep。',
}

/**
 * 构建子 Agent 可用的工具子集
 *
 * 参数 schema 从 getAgentTools(assistant) 复用，保证与执行层一致；
 * 描述按需精简（移除终端/SSH/IM 等无关上下文）。
 * 排除：终端操作、dispatch_agents（防递归）、交互式工具（ask_user）、记忆/计划等会话级工具。
 *
 * @param readonly 只读模式（默认 true）：排除 edit_file/write_text_file，仅保留读取和分析能力
 */
export function getSubAgentTools(readonly = true): ToolDefinition[] {
  const mainTools = getAgentTools(undefined, { mode: 'assistant' })
  const allowed = readonly
    ? SUB_AGENT_READONLY_TOOLS
    : new Set([...SUB_AGENT_READONLY_TOOLS, ...SUB_AGENT_WRITE_TOOLS])

  return mainTools
    .filter(tool => allowed.has(tool.function.name))
    .map(tool => {
      const override = SUB_AGENT_DESCRIPTION_OVERRIDES[tool.function.name]
      if (!override) return tool
      return {
        ...tool,
        function: { ...tool.function, description: override }
      }
    })
}

// ==================== 子 Agent 执行器配置构建 ====================

/**
 * 从父 executor 派生子 Agent 专用的 ToolExecutorConfig
 * 共享文件操作能力和 AI 服务，但禁用终端、计划、记忆等功能
 */
function buildSubAgentExecutorConfig(
  parentExecutor: ToolExecutorConfig,
  parentConfig: AgentConfig,
  abortSignal: { aborted: boolean }
): ToolExecutorConfig {
  const noopStep = () => ({ id: '', type: 'tool_call' as const, content: '', timestamp: Date.now() })

  return {
    agentId: parentExecutor.agentId ? `${parentExecutor.agentId}:sub` : 'sub-agent',
    terminalService: parentExecutor.terminalService,
    hostProfileService: parentExecutor.hostProfileService,
    // 子 Agent 的 step 不推送到前端（由父 Agent 汇总推送）
    addStep: () => noopStep(),
    updateStep: () => {},
    // 子 Agent 内部的写操作继承父 Agent 的确认策略
    waitForConfirmation: parentExecutor.waitForConfirmation,
    isAborted: () => abortSignal.aborted || parentExecutor.isAborted(),
    getHostId: parentExecutor.getHostId,
    hasPendingUserMessage: () => false,
    peekPendingUserMessage: () => undefined,
    consumePendingUserMessage: () => undefined,
    getRealtimeTerminalOutput: () => [],
    getCurrentPlan: () => undefined,
    setCurrentPlan: () => {},
    getTaskMemory: parentExecutor.getTaskMemory,
    getAiService: parentExecutor.getAiService,
    getActiveProfileId: parentExecutor.getActiveProfileId,
    historyService: parentExecutor.historyService,
  }
}

// ==================== 单个子 Agent ReAct 循环 ====================

interface SubAgentRunOptions {
  task: SubAgentTask
  aiService: AiService
  tools: ToolDefinition[]
  executorConfig: ToolExecutorConfig
  agentConfig: AgentConfig
  profileId?: string
  abortSignal: { aborted: boolean }
  readonly: boolean
  onProgress: (update: Partial<SubAgentResult>) => void
}

/**
 * 运行单个子 Agent 的 ReAct 循环
 *
 * 执行流程：构建系统提示 → AI 调用 → 工具执行 → 循环至无工具调用或达到步数上限
 * 返回最终的文本结果或错误信息
 */
async function runSubAgent(options: SubAgentRunOptions): Promise<SubAgentResult> {
  const { task, aiService, tools, executorConfig, agentConfig, profileId, abortSignal, readonly, onProgress } = options
  const startTime = Date.now()
  let totalTokens: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  const toolSteps: SubAgentToolStep[] = []

  const systemPrompt = buildSubAgentSystemPrompt(task, readonly, tools)
  const messages: AiMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task.prompt }
  ]

  log.info(`Sub-agent [${task.id}] started: ${task.description}`)

  try {
    let stepCount = 0
    let hasExecutedTools = false

    while (stepCount < MAX_SUB_AGENT_STEPS) {
      if (abortSignal.aborted) {
        return { id: task.id, description: task.description, status: 'failed', error: 'Aborted by parent agent', steps: toolSteps }
      }

      stepCount++
      const result: ChatWithToolsResult = await aiService.chatWithTools(messages, tools, profileId)
      accumulateTokens(totalTokens, result.usage)

      if (!result.tool_calls || result.tool_calls.length === 0) {
        const finalText = result.content || ''
        log.info(`Sub-agent [${task.id}] completed in ${stepCount} steps, ${Date.now() - startTime}ms`)
        return {
          id: task.id,
          description: task.description,
          status: 'completed',
          result: truncateFromEnd(finalText, MAX_RESULT_LENGTH),
          tokensUsed: totalTokens,
          steps: toolSteps
        }
      }

      hasExecutedTools = true

      messages.push({
        role: 'assistant',
        content: result.content || '',
        tool_calls: result.tool_calls
      })

      for (const toolCall of result.tool_calls) {
        if (abortSignal.aborted) break

        const toolName = toolCall.function?.name || 'unknown'
        const toolArgs = summarizeToolArgs(toolName, toolCall.function?.arguments)
        const step: SubAgentToolStep = { tool: toolName, args: toolArgs, status: 'running' }
        toolSteps.push(step)
        onProgress({ steps: [...toolSteps] })

        const toolResult = await executeTool(
          undefined,
          toolCall,
          agentConfig,
          [],
          executorConfig
        )

        step.status = toolResult.success ? 'completed' : 'failed'
        step.result = truncateFromEnd(
          toolResult.success ? toolResult.output : (toolResult.error || toolResult.output),
          500
        )
        onProgress({ steps: [...toolSteps] })

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult.success
            ? toolResult.output
            : `Error: ${toolResult.error || toolResult.output}`
        })
      }
    }

    const lastContent = messages[messages.length - 1]?.content || ''
    log.warn(`Sub-agent [${task.id}] hit step limit (${MAX_SUB_AGENT_STEPS})`)
    return {
      id: task.id,
      description: task.description,
      status: hasExecutedTools ? 'completed' : 'failed',
      result: truncateFromEnd(lastContent, MAX_RESULT_LENGTH),
      error: hasExecutedTools ? undefined : 'Reached step limit without producing results',
      tokensUsed: totalTokens,
      steps: toolSteps
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log.error(`Sub-agent [${task.id}] error: ${errorMsg}`)
    return {
      id: task.id,
      description: task.description,
      status: 'failed',
      error: errorMsg,
      tokensUsed: totalTokens,
      steps: toolSteps
    }
  }
}

// ==================== dispatch_agents 工具入口 ====================

/**
 * dispatch_agents 工具的执行入口
 *
 * 解析任务列表 → 创建进度步骤 → 按并发上限分批执行 → 汇总结果返回
 */
export async function dispatchSubAgents(
  args: Record<string, unknown>,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const aiService = executor.getAiService?.()
  if (!aiService) {
    return { success: false, output: '', error: 'AI service not available for sub-agents' }
  }

  // 解析参数
  const rawTasks = args.tasks as Array<{ description: string; prompt: string }> | undefined
  if (!rawTasks || !Array.isArray(rawTasks) || rawTasks.length === 0) {
    return { success: false, output: '', error: 'tasks 参数必须是非空数组，每项包含 description 和 prompt' }
  }

  if (rawTasks.length > 10) {
    return { success: false, output: '', error: '一次最多 dispatch 10 个子任务' }
  }

  for (let i = 0; i < rawTasks.length; i++) {
    const t = rawTasks[i]
    if (!t?.prompt || typeof t.prompt !== 'string' || t.prompt.trim() === '') {
      return { success: false, output: '', error: `子任务 ${i + 1} 缺少 prompt（任务指令）` }
    }
  }

  const maxConcurrent = Math.min(
    Math.max(1, Number(args.max_concurrent) || DEFAULT_MAX_CONCURRENT),
    10
  )

  const readonly = args.readonly !== false // 默认 true

  const tasks: SubAgentTask[] = rawTasks.map((t, i) => ({
    id: `sub-${i + 1}`,
    description: t.description || `Task ${i + 1}`,
    prompt: t.prompt
  }))

  // 创建进度步骤（tool_call 类型 + subAgents 字段）
  const subAgentResults: SubAgentResult[] = tasks.map(t => ({
    id: t.id,
    description: t.description,
    status: 'pending' as const
  }))

  const modeLabel = readonly ? '只读' : '读写'
  const progressStep = executor.addStep({
    type: 'tool_call',
    content: `并行执行 ${tasks.length} 个子任务（${modeLabel}）`,
    toolName: 'dispatch_agents',
    toolArgs: { tasks: tasks.map(t => ({ description: t.description })), max_concurrent: maxConcurrent, readonly },
    riskLevel: 'safe',
    subAgents: [...subAgentResults]
  })

  const tools = getSubAgentTools(readonly)
  const profileId = executor.getActiveProfileId?.()
  const abortSignal = { aborted: false }

  // 进度更新辅助函数
  const updateProgress = (taskId: string, update: Partial<SubAgentResult>) => {
    const idx = subAgentResults.findIndex(r => r.id === taskId)
    if (idx >= 0) {
      Object.assign(subAgentResults[idx], update)
      executor.updateStep(progressStep.id, { subAgents: [...subAgentResults] })
    }
  }

  // 子 Agent 无独立终端，不传 cwd（由 exec 工具的 cwd 参数或 AI 自行指定）

  log.info(`Dispatching ${tasks.length} sub-agents (max concurrent: ${maxConcurrent})`)

  // 按并发上限分批执行
  const allResults: SubAgentResult[] = []
  for (let i = 0; i < tasks.length; i += maxConcurrent) {
    if (executor.isAborted()) {
      abortSignal.aborted = true
      break
    }

    const batch = tasks.slice(i, i + maxConcurrent)
    const batchPromises = batch.map(task => {
      if (abortSignal.aborted || executor.isAborted()) {
        const abortedResult: SubAgentResult = { id: task.id, description: task.description, status: 'failed', error: 'Aborted' }
        updateProgress(task.id, abortedResult)
        return Promise.resolve(abortedResult)
      }
      updateProgress(task.id, { status: 'running' })

      const subExecutor = buildSubAgentExecutorConfig(executor, config, abortSignal)
      return runSubAgent({
        task,
        aiService,
        tools,
        executorConfig: subExecutor,
        agentConfig: { ...config, executionMode: config.executionMode === 'free' ? 'relaxed' : config.executionMode },
        profileId,
        abortSignal,
        readonly,
        onProgress: (update) => updateProgress(task.id, update)
      }).then(result => {
        updateProgress(task.id, result)
        return result
      })
    })

    const batchResults = await Promise.allSettled(batchPromises)
    for (let j = 0; j < batchResults.length; j++) {
      const settled = batchResults[j]
      if (settled.status === 'fulfilled') {
        allResults.push(settled.value)
      } else {
        const failedTask = batch[j]
        const errorMsg = settled.reason instanceof Error
          ? settled.reason.message
          : typeof settled.reason === 'string'
            ? settled.reason
            : String(settled.reason)
        const failedResult: SubAgentResult = {
          id: failedTask.id,
          description: failedTask.description,
          status: 'failed',
          error: errorMsg
        }
        updateProgress(failedTask.id, failedResult)
        allResults.push(failedResult)
      }
    }
  }

  // 汇总结果
  const successCount = allResults.filter(r => r.status === 'completed').length
  const failCount = allResults.filter(r => r.status === 'failed').length
  const summary = formatResultsSummary(allResults)

  // 更新进度步骤的最终状态
  executor.updateStep(progressStep.id, {
    content: `并行执行完成：${successCount} 成功${failCount > 0 ? `，${failCount} 失败` : ''}`,
    subAgents: [...subAgentResults]
  })

  log.info(`All sub-agents completed: ${successCount} success, ${failCount} failed`)

  return {
    success: failCount === 0,
    output: summary,
    error: failCount > 0 ? `${failCount}/${allResults.length} 个子任务失败` : undefined
  }
}

// ==================== 辅助函数 ====================

function buildSubAgentSystemPrompt(task: SubAgentTask, readonly: boolean, tools: ToolDefinition[]): string {
  const toolNames = tools.map(t => t.function.name).join('、')
  const writeConstraint = readonly ? '- **只读模式**：不可修改任何文件或系统状态，exec 仅用于读取类命令（grep/find/cat/ls/git log 等）\n' : ''

  return [
    '你是一个专注执行子任务的 AI 助手。',
    '',
    '## 约束',
    '- 你是父 Agent 并行分派的子任务执行器，专注完成指定任务',
    `- 可用工具：${toolNames}`,
    writeConstraint + '- 不可使用终端交互、不可创建子任务、不可向用户提问',
    '- 完成任务后直接输出结果文本，不要多余寒暄',
    '',
    '## 任务',
    task.description,
  ].join('\n')
}

function summarizeToolArgs(toolName: string, argsStr?: string): string | undefined {
  if (!argsStr) return undefined
  try {
    const args = JSON.parse(argsStr)
    switch (toolName) {
      case 'read_file': return args.path || args.file_path
      case 'edit_file': return args.file_path || args.path
      case 'write_text_file': return args.file_path || args.path
      case 'file_search': return args.query || args.pattern
      case 'exec': return args.command ? (args.command.length > 80 ? args.command.slice(0, 77) + '...' : args.command) : undefined
      case 'search_knowledge': return args.query
      case 'get_knowledge_doc': return args.title || args.id
      default: return undefined
    }
  } catch {
    return undefined
  }
}

function accumulateTokens(total: TokenUsage, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens?: number }) {
  if (!usage) return
  total.prompt_tokens += usage.prompt_tokens || 0
  total.completion_tokens += usage.completion_tokens || 0
  total.total_tokens += usage.total_tokens || (usage.prompt_tokens + usage.completion_tokens) || 0
}

function formatResultsSummary(results: SubAgentResult[]): string {
  const sections = results.map(r => {
    const statusIcon = r.status === 'completed' ? '✅' : '❌'
    const header = `${statusIcon} [${r.id}] ${r.description}`
    if (r.status === 'completed') {
      return `${header}\n${r.result || '(no output)'}`
    } else {
      return `${header}\nError: ${r.error || 'Unknown error'}`
    }
  })
  return sections.join('\n\n---\n\n')
}
