/**
 * 并行子 Agent 执行器
 *
 * 主 Agent 通过 dispatch_agents 工具发起多个轻量子任务并行执行。
 * 每个子任务拥有独立的 AI 对话上下文和受限工具集，完成后将结果汇总返回。
 *
 * 设计要点：
 * - **独立模式**：子 Agent 用 [system, user] 两条消息开局，不继承父 Agent 的对话历史。
 *   每次都是干净的小型 ReAct 循环，避免因继承父上下文导致身份/工具/历史认知错位的幻觉
 * - **byte-exact 一致**：同一父 Agent 内所有子 Agent 的 system prompt 与工具 schema
 *   完全一致，自动命中 Anthropic/DeepSeek/OpenAI 的前缀缓存
 * - Agent 类型系统：read / write 两类，工具白名单不同，向后兼容旧值
 *   （explore/research → read，edit → write）
 * - 并发控制：Promise.allSettled + 可配置并发上限
 * - 进度推送：通过父 executor 的 addStep/updateStep 实时更新 subAgents 字段
 *
 * 历史：曾参考 Claude Code 改成 fork 模式（继承父消息历史以最大化 prompt cache），
 * 但导致严重的工具幻觉（子 Agent 看到父的工具调用历史会去模仿调用 dispatch_agents
 * / plan / ask_user 等不在自己白名单的工具，不断被运行时拦截卡死）。已撤回到独立模式。
 */
import type { AiService, AiMessage, ToolDefinition, ChatWithToolsResult } from '../../ai.service'
import { getMetaByName } from '../tool-metadata'
import type { SubAgentTask, SubAgentResult, SubAgentToolStep, SubAgentTypeName, TokenUsage } from '@shared/types'
import type { ToolExecutorConfig, ToolResult, AgentConfig } from './types'
import { executeTool } from './index'
import { getAgentTools } from '../tools'
import { truncateFromEnd } from './utils'
import { PromptBuilder } from '../prompt-builder'
import { getAiDebugService } from '../../ai-debug.service'
import { createLogger } from '../../../utils/logger'
import { t } from '../i18n'

const log = createLogger('SubAgent')

/** 子 Agent 步数上限（0 = 无限制，与主 Agent 一致） */
const MAX_SUB_AGENT_STEPS = 0
const DEFAULT_MAX_CONCURRENT = 5
const MAX_RESULT_LENGTH = 8000

// ==================== Agent 类型系统 ====================

/** 子 Agent 类型定义 */
export interface SubAgentType {
  name: SubAgentTypeName
  description: string
  tools: Set<string>
  systemPromptPrefix: string
}

/**
 * 内置 Agent 类型注册表
 *
 * ⚠️ 工具白名单顺序约定：与 tools.ts 中 builtinTools 的前缀保持一致，
 * 让父/子 Agent 的工具列表共享 byte-exact 前缀，最大化 prompt cache 命中。
 * - read 用前 7 个：exec, read_file, file_search, search_knowledge, get_knowledge_doc, web_search, web_fetch
 * - write 用前 9 个：上述 7 个 + edit_file, write_text_file
 *
 * 注意：
 * - 即使 web_search 未配 key（父 Agent 跳过），白名单仍包含 'web_search'，filter 后子 Agent
 *   也跳过——位置一致即可保持父=子的连续前缀
 * - write 类型也保留 web_search/web_fetch（即使少用）以维持连续前缀；移除会破坏 cache
 */
const SUB_AGENT_TYPES: Record<SubAgentTypeName, SubAgentType> = {
  read: {
    name: 'read',
    description: '只读分析与调研（默认）：读文件、搜索、跑只读命令、查知识库；不修改任何内容',
    tools: new Set(['exec', 'read_file', 'file_search', 'search_knowledge', 'get_knowledge_doc', 'web_search', 'web_fetch']),
    systemPromptPrefix: '你是一个侧重**只读分析与调研**的子任务执行器。读文件、搜索、跑只读命令（grep / find / cat / ls / git log 等）收集信息后给出结论。',
  },
  write: {
    name: 'write',
    description: '文件修改：在 read 基础上可编辑和创建文件',
    tools: new Set(['exec', 'read_file', 'file_search', 'search_knowledge', 'get_knowledge_doc', 'web_search', 'web_fetch', 'edit_file', 'write_text_file']),
    systemPromptPrefix: '你是一个侧重**文件修改**的子任务执行器。修改文件前先用 read_file 看清现状，再用 edit_file 或 write_text_file 改写。',
  },
}

const DEFAULT_AGENT_TYPE: SubAgentTypeName = 'read'

/**
 * 旧类型值兼容映射。
 *
 * Fork 模式时期使用过 explore / research / edit 三种类型，砍成 read/write 后保留
 * 兼容映射，避免 LLM 凭旧训练习惯调用 explore 等被运行时拒绝。
 */
const LEGACY_TYPE_ALIASES: Record<string, SubAgentTypeName> = {
  explore: 'read',
  research: 'read',
  edit: 'write',
}

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

/**
 * 解析并校验 agent_type，返回对应的类型定义。
 *
 * 优先级：当前类型名 > 旧类型别名（向后兼容）> 默认 read
 */
function resolveAgentType(agentType?: string): SubAgentType {
  if (!agentType) return SUB_AGENT_TYPES[DEFAULT_AGENT_TYPE]
  if (agentType in SUB_AGENT_TYPES) {
    return SUB_AGENT_TYPES[agentType as SubAgentTypeName]
  }
  const aliased = LEGACY_TYPE_ALIASES[agentType]
  if (aliased) {
    log.info(`Mapping legacy agent_type "${agentType}" → "${aliased}"`)
    return SUB_AGENT_TYPES[aliased]
  }
  log.warn(`Unknown agent_type "${agentType}", falling back to "${DEFAULT_AGENT_TYPE}"`)
  return SUB_AGENT_TYPES[DEFAULT_AGENT_TYPE]
}

/**
 * 根据 Agent 类型构建可用工具子集
 *
 * 直接复用父 Agent 的工具定义（byte-exact），不做 description 修改：
 * - 子 Agent **始终**按 assistant 模式获取工具（不随父 Agent 终端类型 local/ssh 变化），
 *   保证不同父 Agent 派生的同类型子 Agent 工具列表 byte-exact 一致
 * - 不重写 description 以保持字节一致，最大化 prompt cache 命中
 *
 * 注：在 local/assistant 父 Agent 下，子 Agent 工具列表也是父工具列表的连续前缀
 * （见 tools.ts「工具列表顺序约定」）；SSH 父 Agent 不能调 dispatch_agents
 * （`supportedModes` 限制），无需考虑该模式下的前缀关系。
 */
export function getSubAgentTools(agentType: string = DEFAULT_AGENT_TYPE): ToolDefinition[] {
  const typeDefinition = resolveAgentType(agentType)
  const mainTools = getAgentTools(undefined, { mode: 'assistant' })
  return mainTools.filter(tool => typeDefinition.tools.has(tool.function.name))
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
    isSubAgent: true,
    terminalService: parentExecutor.terminalService,
    hostProfileService: parentExecutor.hostProfileService,
    // 子 Agent 的 step 不推送到前端（由父 Agent 汇总推送）
    addStep: () => noopStep(),
    updateStep: () => {},
    // 子 Agent 不弹确认框：moderate 自动放行，dangerous 自动拒绝并报错
    // displayName 在子 Agent 场景下不需要（不弹卡片），保留参数仅为兼容接口
    waitForConfirmation: async (_toolCallId, toolName, toolArgs, riskLevel, _displayName) => {
      if (riskLevel === 'dangerous') {
        const argsPreview = (() => {
          try { return JSON.stringify(toolArgs).slice(0, 300) } catch { return '<unserializable>' }
        })()
        log.warn(`Sub-agent auto-rejected dangerous operation: ${toolName} args=${argsPreview}`)
        return false
      }
      return true
    },
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
    getToolOutputBudget: parentExecutor.getToolOutputBudget,
  }
}

// ==================== 单个子 Agent ReAct 循环 ====================

interface SubAgentRunOptions {
  task: SubAgentTask
  aiService: AiService
  /** API 请求使用的工具列表（按 agent type 过滤后，是父 Agent 工具列表的连续前缀） */
  tools: ToolDefinition[]
  /** 执行时允许的工具白名单（防御层：万一 LLM 通过其它方式生成了未列入工具的调用） */
  allowedTools: Set<string>
  /** 子 Agent 自己的系统提示（不继承父 Agent 历史） */
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
 * 独立模式：[system, user] 两条消息开局；不继承父 Agent 的对话历史。
 * 父 Agent 想让子 Agent 知道的上下文必须显式写在 task.prompt 里。
 */
async function runSubAgent(options: SubAgentRunOptions): Promise<SubAgentResult> {
  const { task, aiService, tools, allowedTools, systemPrompt, executorConfig, agentConfig, profileId, abortSignal, onProgress } = options
  const startTime = Date.now()
  const totalTokens: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  const toolSteps: SubAgentToolStep[] = []
  const messages: AiMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task.prompt },
  ]
  const abortController = new AbortController()

  // 轮询父 abort 信号，触发 HTTP 请求中断
  const pollInterval = setInterval(() => {
    if ((abortSignal.aborted || executorConfig.isAborted()) && !abortController.signal.aborted) {
      abortController.abort()
    }
  }, 500)

  log.info(`Sub-agent [${task.id}] started: ${task.description}`)
  const aiDebug = getAiDebugService()

  try {
    let stepCount = 0
    let hasExecutedTools = false

    while (MAX_SUB_AGENT_STEPS === 0 || stepCount < MAX_SUB_AGENT_STEPS) {
      if (abortSignal.aborted || executorConfig.isAborted()) {
        abortController.abort()
        return { id: task.id, description: task.description, status: 'failed', error: 'Aborted by parent agent', steps: toolSteps }
      }

      stepCount++
      const iterReqId = `sub_${task.id}_step${stepCount}`
      const result: ChatWithToolsResult = await aiService.chatWithTools(messages, tools, profileId, abortController.signal)
      accumulateTokens(totalTokens, result.usage)

      if (!result.tool_calls || result.tool_calls.length === 0) {
        let finalText = result.content || ''
        if (!hasExecutedTools) {
          log.warn(`Sub-agent [${task.id}] completed without any tool calls`)
          finalText = `⚠️ 注意：子 Agent 未调用任何工具，以下结果可能不可靠。\n\n${finalText}`
        }
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

      // DeepSeek V3.2+ 思考模式：带 tool_calls 的 assistant 消息后续请求必须回传 reasoning_content
      const assistantMsg: AiMessage = {
        role: 'assistant',
        content: result.content || '',
        tool_calls: result.tool_calls
      }
      if (result.reasoning_content !== undefined) {
        assistantMsg.reasoning_content = result.reasoning_content
      }
      messages.push(assistantMsg)

      const subPromptTokens = result.usage?.prompt_tokens
      const toolExecutorForStep: ToolExecutorConfig =
        subPromptTokens !== undefined && executorConfig.getToolOutputBudget
          ? {
              ...executorConfig,
              getToolOutputBudget: () =>
                executorConfig.getToolOutputBudget!(subPromptTokens),
            }
          : executorConfig

      for (const toolCall of result.tool_calls) {
        if (abortSignal.aborted || executorConfig.isAborted()) break

        const toolName = toolCall.function?.name || 'unknown'
        const toolArgs = summarizeToolArgs(toolName, toolCall.function?.arguments, tools)
        const step: SubAgentToolStep = { tool: toolName, args: toolArgs, status: 'running' }
        toolSteps.push(step)
        onProgress({ steps: [...toolSteps] })

        aiDebug.logToolCall(iterReqId, {
          id: toolCall.id,
          name: toolName,
          arguments: toolCall.function?.arguments || ''
        })

        // 工具白名单检查：防御层。schema 已经把白名单外的工具过滤掉，
        // 这里再拦一道，避免 LLM 通过其它途径生成未列入工具的调用
        if (!allowedTools.has(toolName)) {
          const errorMsg = `工具 "${toolName}" 不在当前子 Agent 类型的可用范围内`
          step.status = 'failed'
          step.result = errorMsg
          onProgress({ steps: [...toolSteps] })
          aiDebug.logToolResult(iterReqId, { toolCallId: toolCall.id, success: false, result: errorMsg })
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: `Error: ${errorMsg}` })
          continue
        }

        const toolResult = await executeTool(
          undefined,
          toolCall,
          agentConfig,
          [],
          toolExecutorForStep
        )

        step.status = toolResult.success ? 'completed' : 'failed'
        step.result = truncateFromEnd(
          toolResult.success ? toolResult.output : (toolResult.error || toolResult.output),
          500
        )
        onProgress({ steps: [...toolSteps] })

        const resultContent = toolResult.success
          ? toolResult.output
          : `Error: ${toolResult.error || toolResult.output}`

        aiDebug.logToolResult(iterReqId, {
          toolCallId: toolCall.id,
          success: toolResult.success,
          result: resultContent
        })

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: resultContent
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
    if (abortSignal.aborted) {
      return { id: task.id, description: task.description, status: 'failed', error: 'Aborted by parent agent', steps: toolSteps }
    }
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
  } finally {
    clearInterval(pollInterval)
  }
}

// ==================== dispatch_agents 工具入口 ====================

/**
 * dispatch_agents 工具的执行入口
 *
 * 独立模式：每个子 Agent 用独立的 [system, user] 开局，不继承父 Agent 上下文。
 * system prompt 由 PromptBuilder.buildSubAgentSystemPrompt 构建，包含语言规则、
 * 运行环境、用户 AI Rules 与类型角色，跨同一父 Agent 的子任务 byte-exact 一致。
 */
export async function dispatchSubAgents(
  args: Record<string, unknown>,
  config: AgentConfig,
  executor: ToolExecutorConfig,
  _toolCallId?: string
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

  const globalAgentTypeRaw = args.agent_type as string | undefined
  const globalAgentType = resolveAgentType(globalAgentTypeRaw).name

  const tasks: SubAgentTask[] = rawTasks.map((t, i) => ({
    id: `sub-${i + 1}`,
    description: t.description || `Task ${i + 1}`,
    prompt: t.prompt,
    agentType: resolveAgentType(t.agent_type ?? globalAgentTypeRaw).name,
  }))

  // 创建进度步骤（tool_call 类型 + subAgents 字段）
  const subAgentResults: SubAgentResult[] = tasks.map(t => ({
    id: t.id,
    description: t.description,
    prompt: t.prompt,
    status: 'pending' as const
  }))

  const typeLabel = tasks.every(t => t.agentType === globalAgentType)
    ? globalAgentType
    : 'mixed'
  const progressStep = executor.addStep({
    type: 'tool_call',
    content: t('dispatch.running', { count: tasks.length, type: typeLabel }),
    toolName: 'dispatch_agents',
    toolArgs: { tasks: tasks.map(task => ({ description: task.description, agent_type: task.agentType })), max_concurrent: maxConcurrent, agent_type: globalAgentType },
    riskLevel: 'safe',
    subAgents: [...subAgentResults]
  })

  // 子 Agent system prompt 需要的项目级上下文
  const agentContext = executor.getAgentContext?.()
  if (!agentContext) {
    return { success: false, output: '', error: 'dispatch_agents 需要 Agent 运行上下文（内部错误）' }
  }
  const aiRules = executor.getAiRules?.() ?? ''

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

  log.info(`Dispatching ${tasks.length} sub-agents (type: ${typeLabel}, concurrent: ${maxConcurrent})`)

  // 按 type 缓存工具列表与 system prompt，避免对每个子任务重复跑 getAgentTools + filter
  // 与 prompt 拼接（同次 dispatch 内最多 2 个 type，共享缓存即可）
  const toolsByType = new Map<SubAgentTypeName, ToolDefinition[]>()
  const promptByType = new Map<SubAgentTypeName, string>()
  const getToolsForType = (type: SubAgentTypeName): ToolDefinition[] => {
    if (!toolsByType.has(type)) toolsByType.set(type, getSubAgentTools(type))
    return toolsByType.get(type)!
  }
  const getPromptForType = (type: SubAgentTypeName): string => {
    if (!promptByType.has(type)) {
      promptByType.set(type, PromptBuilder.buildSubAgentSystemPrompt({
        typePromptPrefix: SUB_AGENT_TYPES[type].systemPromptPrefix,
        context: agentContext,
        aiRules,
        hostProfileService: executor.hostProfileService,
      }))
    }
    return promptByType.get(type)!
  }

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
      const typeDefinition = resolveAgentType(taskAgentType)
      const subExecutor = buildSubAgentExecutorConfig(executor, config, abortSignal)
      const systemPrompt = getPromptForType(typeDefinition.name)

      // 子 Agent 工具列表按类型从缓存取（同 type 跨子任务复用，保证 byte-exact 一致）
      const subTools = getToolsForType(typeDefinition.name)

      return runSubAgent({
        task,
        aiService,
        tools: subTools,
        allowedTools: typeDefinition.tools,
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

  const successCount = allResults.filter(r => r.status === 'completed').length
  const failCount = allResults.filter(r => r.status === 'failed').length
  const summary = formatResultsSummary(allResults)

  executor.updateStep(progressStep.id, {
    content: failCount > 0
      ? t('dispatch.completed_with_fail', { success: successCount, fail: failCount })
      : t('dispatch.completed_no_fail', { success: successCount }),
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

/** 从工具参数中提取摘要，供子 Agent 步骤列表展示（完整保留，由 UI 控制换行/省略） */
function summarizeToolArgs(
  toolName: string,
  argsStr: string | undefined,
  tools: ToolDefinition[]
): string | undefined {
  if (!argsStr) return undefined
  try {
    const args = JSON.parse(argsStr) as Record<string, unknown>

    const meta = getMetaByName(tools, toolName)
    const metaField = meta?.argRole?.summaryLine ?? meta?.streamDisplay?.titleField
    if (metaField && typeof args[metaField] === 'string') {
      const val = args[metaField] as string
      if (val) return val
    }

    switch (toolName) {
      case 'read_file':
      case 'edit_file':
      case 'write_text_file':
        if (typeof args.path === 'string' && args.path) return args.path
        return typeof args.file_path === 'string' ? args.file_path : undefined
      case 'file_search':
        if (typeof args.query === 'string' && args.query) return args.query
        return typeof args.pattern === 'string' ? args.pattern : undefined
      case 'exec':
        return typeof args.command === 'string' ? args.command : undefined
      case 'web_fetch':
        return typeof args.url === 'string' ? args.url : undefined
      case 'search_knowledge':
        return typeof args.query === 'string' ? args.query : undefined
      case 'get_knowledge_doc':
        if (typeof args.doc_id === 'string' && args.doc_id) return args.doc_id
        if (typeof args.title === 'string' && args.title) return args.title
        return typeof args.id === 'string' ? args.id : undefined
      default:
        return undefined
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
