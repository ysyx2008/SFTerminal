/**
 * 并行子 Agent 执行器
 *
 * 主 Agent 通过 dispatch_agents 工具发起多个轻量子任务并行执行。
 * 每个子任务拥有独立的 AI 对话上下文和受限工具集，完成后将结果汇总返回。
 *
 * 设计要点：
 * - 子任务是轻量 ReAct 循环，非完整 Agent 实例（无会话/持久化/记忆）
 * - Agent 类型系统：explore/edit/research 各有独立工具集和系统提示
 * - 并发控制：Promise.allSettled + 可配置并发上限
 * - 同步/异步双模式：background=true 时立即返回，后台执行后注入结果
 * - 进度推送：通过父 executor 的 addStep/updateStep 实时更新 subAgents 字段
 */
import type { AiService, AiMessage, ToolDefinition, ChatWithToolsResult } from '../../ai.service'
import type { SubAgentTask, SubAgentResult, SubAgentToolStep, SubAgentTypeName, TokenUsage } from '@shared/types'
import type { ToolExecutorConfig, ToolResult, AgentConfig } from './types'
import { executeTool } from './index'
import { getAgentTools } from '../tools'
import { truncateFromEnd } from './utils'
import { createLogger } from '../../../utils/logger'

const log = createLogger('SubAgent')

/** 子 Agent 步数上限（0 = 无限制，与主 Agent 一致） */
const MAX_SUB_AGENT_STEPS = 0
const DEFAULT_MAX_CONCURRENT = 5
const MAX_RESULT_LENGTH = 8000

// ==================== Agent 类型系统 ====================

/** 子 Agent 类型定义 */
export interface SubAgentType {
  name: string
  description: string
  tools: Set<string>
  systemPromptPrefix: string
}

/** 内置 Agent 类型注册表 */
const SUB_AGENT_TYPES: Record<SubAgentTypeName, SubAgentType> = {
  explore: {
    name: 'explore',
    description: '只读分析（默认）：读取文件、搜索、执行命令，不修改任何内容',
    tools: new Set(['read_file', 'file_search', 'exec', 'search_knowledge', 'get_knowledge_doc']),
    systemPromptPrefix: '你是一个专注**分析与调研**的子任务执行器。\n- **只读模式**：不可修改任何文件或系统状态，exec 仅用于读取类命令（grep/find/cat/ls/git log 等）',
  },
  edit: {
    name: 'edit',
    description: '文件修改：在 explore 基础上可编辑和创建文件',
    tools: new Set(['read_file', 'file_search', 'exec', 'search_knowledge', 'get_knowledge_doc', 'edit_file', 'write_text_file']),
    systemPromptPrefix: '你是一个专注**代码修改与文件编辑**的子任务执行器。\n- 修改文件前必须先用 read_file 查看目标内容',
  },
  research: {
    name: 'research',
    description: '知识检索：侧重知识库搜索和命令分析，输出结构化归纳',
    tools: new Set(['read_file', 'file_search', 'exec', 'search_knowledge', 'get_knowledge_doc']),
    systemPromptPrefix: '你是一个专注**知识检索与归纳分析**的子任务执行器。\n- 优先使用知识库搜索获取已有信息\n- 输出要求结构化、条理清晰，便于父 Agent 整合',
  },
}

const DEFAULT_AGENT_TYPE: SubAgentTypeName = 'explore'

/** 获取所有可用的 Agent 类型名称（供工具定义和提示构建使用） */
export function getSubAgentTypeNames(): SubAgentTypeName[] {
  return Object.keys(SUB_AGENT_TYPES) as SubAgentTypeName[]
}

/** 获取所有 Agent 类型的描述（供系统提示使用） */
export function getSubAgentTypeDescriptions(): string {
  return Object.values(SUB_AGENT_TYPES)
    .map(t => `- \`${t.name}\`: ${t.description}`)
    .join('\n')
}

/** 解析并校验 agent_type，返回对应的类型定义 */
function resolveAgentType(agentType?: string): SubAgentType {
  if (!agentType) return SUB_AGENT_TYPES[DEFAULT_AGENT_TYPE]
  if (agentType in SUB_AGENT_TYPES) {
    return SUB_AGENT_TYPES[agentType as SubAgentTypeName]
  }
  log.warn(`Unknown agent_type "${agentType}", falling back to "${DEFAULT_AGENT_TYPE}"`)
  return SUB_AGENT_TYPES[DEFAULT_AGENT_TYPE]
}

/** 子 Agent 工具描述覆盖（精简版，节省 token、避免无关上下文干扰） */
const SUB_AGENT_DESCRIPTION_OVERRIDES: Record<string, string> = {
  read_file: '读取本地文件内容。支持文本、PDF、Word、图片。大文件先用 info_only 查信息，再按行范围读取。',
  file_search: '快速搜索本地文件名（基于系统索引，毫秒级）。支持通配符 * 和 ?。仅搜文件名不搜内容，搜内容请用 exec + grep。',
}

/**
 * 根据 Agent 类型构建可用工具子集
 *
 * 参数 schema 从 getAgentTools(assistant) 复用，保证与执行层一致；
 * 描述按需精简（移除终端/SSH/IM 等无关上下文）。
 */
export function getSubAgentTools(agentType: string = DEFAULT_AGENT_TYPE): ToolDefinition[] {
  const typeDefinition = resolveAgentType(agentType)
  const mainTools = getAgentTools(undefined, { mode: 'assistant' })

  return mainTools
    .filter(tool => typeDefinition.tools.has(tool.function.name))
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
  systemPrompt: string
  executorConfig: ToolExecutorConfig
  agentConfig: AgentConfig
  profileId?: string
  abortSignal: { aborted: boolean }
  onProgress: (update: Partial<SubAgentResult>) => void
}

/**
 * 运行单个子 Agent 的 ReAct 循环
 *
 * 执行流程：构建系统提示 → AI 调用 → 工具执行 → 循环至无工具调用或达到步数上限
 * 返回最终的文本结果或错误信息
 */
async function runSubAgent(options: SubAgentRunOptions): Promise<SubAgentResult> {
  const { task, aiService, tools, systemPrompt, executorConfig, agentConfig, profileId, abortSignal, onProgress } = options
  const startTime = Date.now()
  let totalTokens: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  const toolSteps: SubAgentToolStep[] = []
  const messages: AiMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task.prompt }
  ]

  log.info(`Sub-agent [${task.id}] started: ${task.description}`)

  try {
    let stepCount = 0
    let hasExecutedTools = false

    while (MAX_SUB_AGENT_STEPS === 0 || stepCount < MAX_SUB_AGENT_STEPS) {
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
 * 支持同步（默认）和异步（background: true）两种模式
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
  const rawTasks = args.tasks as Array<{ description: string; prompt: string; agent_type?: string }> | undefined
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

  const validTypes = getSubAgentTypeNames()
  const globalAgentType = validateAgentType(args.agent_type as string | undefined, validTypes) ?? DEFAULT_AGENT_TYPE
  const background = args.background === true

  const tasks: SubAgentTask[] = rawTasks.map((t, i) => ({
    id: `sub-${i + 1}`,
    description: t.description || `Task ${i + 1}`,
    prompt: t.prompt,
    agentType: validateAgentType(t.agent_type, validTypes) ?? globalAgentType,
  }))

  // 创建进度步骤（tool_call 类型 + subAgents 字段）
  const subAgentResults: SubAgentResult[] = tasks.map(t => ({
    id: t.id,
    description: t.description,
    status: 'pending' as const
  }))

  const typeLabel = tasks.every(t => t.agentType === globalAgentType)
    ? globalAgentType
    : 'mixed'
  const modeLabel = background ? '异步' : '同步'
  const progressStep = executor.addStep({
    type: 'tool_call',
    content: `并行执行 ${tasks.length} 个子任务（${typeLabel}, ${modeLabel}）`,
    toolName: 'dispatch_agents',
    toolArgs: { tasks: tasks.map(t => ({ description: t.description, agent_type: t.agentType })), max_concurrent: maxConcurrent, agent_type: globalAgentType, background },
    riskLevel: 'safe',
    subAgents: [...subAgentResults]
  })

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

  log.info(`Dispatching ${tasks.length} sub-agents (type: ${typeLabel}, concurrent: ${maxConcurrent}, background: ${background})`)

  // 按 agent_type 分组预构建 tools 和 systemPrompt（prompt cache 优化：同类型共享）
  const toolsCache = new Map<string, ToolDefinition[]>()
  const promptCache = new Map<string, string>()

  const getToolsForType = (agentType: string): ToolDefinition[] => {
    if (!toolsCache.has(agentType)) {
      toolsCache.set(agentType, getSubAgentTools(agentType))
    }
    return toolsCache.get(agentType)!
  }

  const getSystemPromptForType = (agentType: string, task: SubAgentTask): string => {
    const cacheKey = agentType
    if (!promptCache.has(cacheKey)) {
      promptCache.set(cacheKey, buildSubAgentSystemPrompt(agentType, getToolsForType(agentType)))
    }
    return promptCache.get(cacheKey)! + `\n\n## 任务\n${task.description}`
  }

  // 核心执行函数（同步/异步共用）
  const executeAll = async (): Promise<SubAgentResult[]> => {
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

        const taskAgentType = task.agentType || globalAgentType
        const tools = getToolsForType(taskAgentType)
        const systemPrompt = getSystemPromptForType(taskAgentType, task)
        const subExecutor = buildSubAgentExecutorConfig(executor, config, abortSignal)

        return runSubAgent({
          task,
          aiService,
          tools,
          systemPrompt,
          executorConfig: subExecutor,
          agentConfig: config,
          profileId,
          abortSignal,
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
    return allResults
  }

  // 异步模式：立即返回，后台执行
  if (background) {
    executeAll().then(allResults => {
      const successCount = allResults.filter(r => r.status === 'completed').length
      const failCount = allResults.filter(r => r.status === 'failed').length
      const summary = formatResultsSummary(allResults)

      executor.updateStep(progressStep.id, {
        content: `后台任务完成：${successCount} 成功${failCount > 0 ? `，${failCount} 失败` : ''}`,
        subAgents: [...subAgentResults]
      })

      // 通过 pendingUserMessage 注入结果，让主 Agent 在下一轮 ReAct 循环中消费
      const notification = [
        `[后台任务通知] dispatch_agents 的 ${allResults.length} 个子任务已完成（${successCount} 成功${failCount > 0 ? `，${failCount} 失败` : ''}）：`,
        '',
        summary
      ].join('\n')

      executor.injectPendingMessage?.(notification)
      log.info(`Background sub-agents completed: ${successCount} success, ${failCount} failed`)
    }).catch(err => {
      log.error('Background sub-agents unexpected error:', err)
      executor.injectPendingMessage?.(`[后台任务通知] dispatch_agents 执行出错: ${err instanceof Error ? err.message : String(err)}`)
    })

    return {
      success: true,
      output: `已启动 ${tasks.length} 个后台子任务（${typeLabel}），完成后会自动通知你结果。在等待期间你可以继续处理其他事情。`
    }
  }

  // 同步模式：阻塞等待
  const allResults = await executeAll()

  const successCount = allResults.filter(r => r.status === 'completed').length
  const failCount = allResults.filter(r => r.status === 'failed').length
  const summary = formatResultsSummary(allResults)

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

/** 校验 agent_type 有效性，无效时返回 undefined（由调用方决定 fallback） */
function validateAgentType(value: string | undefined, validTypes: SubAgentTypeName[]): SubAgentTypeName | undefined {
  if (!value) return undefined
  if (validTypes.includes(value as SubAgentTypeName)) return value as SubAgentTypeName
  log.warn(`Invalid agent_type "${value}", valid values: ${validTypes.join(', ')}`)
  return undefined
}

/** 根据 Agent 类型构建系统提示（不含任务描述，便于缓存共享） */
function buildSubAgentSystemPrompt(agentType: string, tools: ToolDefinition[]): string {
  const typeDefinition = resolveAgentType(agentType)
  const toolNames = tools.map(t => t.function.name).join('、')

  return [
    typeDefinition.systemPromptPrefix,
    '',
    '## 约束',
    '- 你是父 Agent 并行分派的子任务执行器，专注完成指定任务',
    `- 可用工具：${toolNames}`,
    '- 不可使用终端交互、不可创建子任务、不可向用户提问',
    '- 完成任务后直接输出结果文本，不要多余寒暄',
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
