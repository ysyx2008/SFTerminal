/**
 * 并行子 Agent 执行器
 *
 * 主 Agent 通过 dispatch_agents 工具发起多个轻量子任务并行执行。
 * 每个子任务拥有独立的 AI 对话上下文和受限工具集，完成后将结果汇总返回。
 *
 * 设计要点：
 * - Fork 模式（参考 Claude Code）：子 Agent 继承父的完整上下文（system prompt +
 *   消息历史 + 工具列表），最大化 prompt cache 命中。父的 tool_result 用占位符替代，
 *   子任务指令作为追加的 user 消息
 * - Agent 类型系统：explore/edit/research 各有独立工具白名单和执行约束
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
import { getAiDebugService } from '../../ai-debug.service'
import { createLogger } from '../../../utils/logger'

const log = createLogger('SubAgent')

/** 子 Agent 步数上限（0 = 无限制，与主 Agent 一致） */
const MAX_SUB_AGENT_STEPS = 0
const DEFAULT_MAX_CONCURRENT = 5
const MAX_RESULT_LENGTH = 8000

/** Fork 占位符：所有子 Agent 使用相同文本，确保 API 前缀字节一致以命中 prompt cache */
const FORK_PLACEHOLDER = '子任务已分派，正在后台执行'

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
    tools: new Set(['read_file', 'file_search', 'exec', 'search_knowledge', 'get_knowledge_doc', 'web_search']),
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
    tools: new Set(['read_file', 'file_search', 'exec', 'search_knowledge', 'get_knowledge_doc', 'web_search']),
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
    // 子 Agent 不弹确认框：moderate 自动放行，dangerous 自动拒绝并报错
    waitForConfirmation: async (_toolCallId, toolName, _toolArgs, riskLevel) => {
      if (riskLevel === 'dangerous') {
        log.warn(`Sub-agent auto-rejected dangerous operation: ${toolName}`)
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
  }
}

// ==================== 单个子 Agent ReAct 循环 ====================

interface SubAgentRunOptions {
  task: SubAgentTask
  aiService: AiService
  /** API 请求使用的工具列表（fork 模式下为父 Agent 的完整工具列表） */
  tools: ToolDefinition[]
  /** 执行时允许的工具白名单（按 agent type 过滤） */
  allowedTools: Set<string>
  /** 初始消息（fork 模式：父上下文 + 占位 + 指令；独立模式：system + user） */
  initialMessages: AiMessage[]
  executorConfig: ToolExecutorConfig
  agentConfig: AgentConfig
  profileId?: string
  abortSignal: { aborted: boolean }
  onProgress: (update: Partial<SubAgentResult>) => void
}

/**
 * 运行单个子 Agent 的 ReAct 循环
 *
 * Fork 模式：继承父 Agent 完整消息历史 + 工具列表，最大化 prompt cache 命中
 * 独立模式：独立系统提示 + 受限工具集（fallback）
 */
async function runSubAgent(options: SubAgentRunOptions): Promise<SubAgentResult> {
  const { task, aiService, tools, allowedTools, initialMessages, executorConfig, agentConfig, profileId, abortSignal, onProgress } = options
  const startTime = Date.now()
  const totalTokens: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  const toolSteps: SubAgentToolStep[] = []
  const messages: AiMessage[] = [...initialMessages]
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

      for (const toolCall of result.tool_calls) {
        if (abortSignal.aborted || executorConfig.isAborted()) break

        const toolName = toolCall.function?.name || 'unknown'
        const toolArgs = summarizeToolArgs(toolName, toolCall.function?.arguments)
        const step: SubAgentToolStep = { tool: toolName, args: toolArgs, status: 'running' }
        toolSteps.push(step)
        onProgress({ steps: [...toolSteps] })

        aiDebug.logToolCall(iterReqId, {
          id: toolCall.id,
          name: toolName,
          arguments: toolCall.function?.arguments || ''
        })

        // 工具白名单检查：拦截不在当前 agent type 允许范围内的调用
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
          executorConfig
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
 * Fork 模式（默认）：子 Agent 继承父 Agent 完整上下文 + 工具列表，最大化 prompt cache 命中
 * 独立模式（fallback）：父上下文不可用时，子 Agent 使用独立系统提示 + 受限工具集
 */
export async function dispatchSubAgents(
  args: Record<string, unknown>,
  config: AgentConfig,
  executor: ToolExecutorConfig,
  toolCallId?: string
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
    prompt: t.prompt,
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

  // Fork 模式：从父 Agent 获取完整上下文（消息历史 + 工具列表）
  const parentContext = executor.getParentContext?.()
  if (!parentContext || !toolCallId || parentContext.messages.length === 0) {
    return { success: false, output: '', error: 'dispatch_agents 需要父 Agent 上下文（内部错误）' }
  }

  log.info(`Dispatching ${tasks.length} sub-agents (type: ${typeLabel}, concurrent: ${maxConcurrent}, background: ${background})`)

  const forkBaseMessages = buildForkBaseMessages(parentContext.messages, toolCallId)

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
        const typeDefinition = resolveAgentType(taskAgentType)
        const subExecutor = buildSubAgentExecutorConfig(executor, config, abortSignal)
        const directive = buildForkDirective(task, typeDefinition)
        const initialMessages: AiMessage[] = [...forkBaseMessages, { role: 'user' as const, content: directive }]

        return runSubAgent({
          task,
          aiService,
          tools: parentContext.tools,
          allowedTools: typeDefinition.tools,
          initialMessages,
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

      // 通过 systemMessage 注入结果：完整内容给 AI，简短通知给用户
      const fullContent = [
        `[后台任务通知] dispatch_agents 的 ${allResults.length} 个子任务已完成（${successCount} 成功${failCount > 0 ? `，${failCount} 失败` : ''}）：`,
        '',
        summary
      ].join('\n')
      const taskList = allResults.map(r => `${r.status === 'completed' ? '✓' : '✗'} ${r.description}`).join('、')
      const briefNotify = `✅ ${allResults.length} 个后台子任务已完成：${taskList}`

      if (executor.injectSystemMessage) {
        executor.injectSystemMessage(fullContent, briefNotify)
      } else {
        executor.injectPendingMessage?.(fullContent)
      }
      log.info(`Background sub-agents completed: ${successCount} success, ${failCount} failed`)
    }).catch(err => {
      log.error('Background sub-agents unexpected error:', err)
      const errorMsg = `[后台任务通知] dispatch_agents 执行出错: ${err instanceof Error ? err.message : String(err)}`
      if (executor.injectSystemMessage) {
        executor.injectSystemMessage(errorMsg, `❌ 后台子任务执行出错`)
      } else {
        executor.injectPendingMessage?.(errorMsg)
      }
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

// ==================== Fork 上下文构建 ====================

/**
 * 构建 fork 基础消息：父 Agent 的完整消息历史 + 缺失的 tool_result 占位
 *
 * 所有子 Agent 共享这个前缀（byte-exact 一致），各自追加不同的 user 指令。
 * Anthropic/DeepSeek 的前缀缓存机制会自动复用这段共享前缀，只对追加部分收费。
 */
function buildForkBaseMessages(parentMessages: AiMessage[], dispatchToolCallId: string): AiMessage[] {
  const messages = parentMessages.map(m => ({ ...m }))

  // 找到最后一条包含 tool_calls 的 assistant 消息
  let lastAssistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].tool_calls?.length) {
      lastAssistantIdx = i
      break
    }
  }

  if (lastAssistantIdx >= 0) {
    const assistantMsg = messages[lastAssistantIdx]
    const existingResultIds = new Set(
      messages.slice(lastAssistantIdx + 1)
        .filter(m => m.role === 'tool')
        .map(m => m.tool_call_id)
    )

    // 为所有尚无 tool_result 的 tool_call 添加占位（包括 dispatch_agents 自身）
    for (const tc of assistantMsg.tool_calls || []) {
      if (!existingResultIds.has(tc.id)) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: FORK_PLACEHOLDER
        })
      }
    }
  }

  return messages
}

/**
 * 构建 fork 指令消息：告知子 Agent 它的身份、类型约束和具体任务
 *
 * 这条 user 消息追加在 fork 前缀之后，是唯一因子 Agent 而异的部分
 */
function buildForkDirective(task: SubAgentTask, agentType: SubAgentType): string {
  const toolNames = [...agentType.tools].join('、')
  return [
    `你现在是一个并行子任务执行器（${agentType.name} 类型）。`,
    agentType.systemPromptPrefix,
    '',
    '## 约束',
    `- 可用工具：${toolNames}`,
    '- 不可使用其他工具（不在上述列表的工具调用会被拦截）',
    '- 不可操作终端、不可创建子任务、不可向用户提问',
    '- **禁止编造**：必须通过工具获取真实数据，严禁凭空生成、模拟或推测工具执行结果。如果无法执行，明确说明原因',
    '- 完成任务后直接输出结果文本，不要多余寒暄',
    '',
    `## 任务：${task.description}`,
    '',
    task.prompt
  ].join('\n')
}

// ==================== 辅助函数 ====================

/** 校验 agent_type 有效性，无效时返回 undefined（由调用方决定 fallback） */
function validateAgentType(value: string | undefined, validTypes: SubAgentTypeName[]): SubAgentTypeName | undefined {
  if (!value) return undefined
  if (validTypes.includes(value as SubAgentTypeName)) return value as SubAgentTypeName
  log.warn(`Invalid agent_type "${value}", valid values: ${validTypes.join(', ')}`)
  return undefined
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
