/**
 * Conversation —— 会话聚合根（领域模型核心）
 *
 * 一条会话「是什么」由它唯一确定，并独占其**唯一真相源**（对话全过程 transcript）与一切派生投影。
 * 这是「记忆必须归 Conversation、不归 Agent」硬约束的落地（见 docs/conversation-refactor-design.md）。
 *
 * 持有：
 * - **身份**（不可变）：`id`(sessionId) / `kind` / `createdAt`
 * - **形态**（创建时定、不可变）：`terminalType` / `sshHost`——跨形态续聊不漫游（避免历史工具名幻觉）
 * - **运行时绑定**（可变）：`agentKey`——当前哪个 tab/实例在跑（会话漫游时 rebind）
 * - **真相源 transcript**：`_messages`（给模型）/ `_steps`（给 UI）
 * - **派生投影**：`_taskMemory`（L1 工作记忆）、`_cachePrefix`（prompt cache 前缀快照）、token 账
 *
 * 绝不碰：IPC、文件 IO、LLM 调用、KnowledgeService、工具执行——保持纯净以换取可测性。
 * （context 的「富化部分」——注入 L2 知识 / L3 检索 / system prompt——留在 Agent。）
 *
 * 重构现状：本类的状态字段与序列化/切分/commit/cache 决策从 `agent.ts` 的 `_session*` +
 * finalizeRun/saveSessionToHistory/restoreFromSessionRecord/buildContext 忠实移植而来。
 * Agent 已持有一个 Conversation 实例并把 `_session*` 退化为只读委托视图（阶段 2b）；
 * taskMemory 仍由 Agent 注入（共享实例），其完整所有权转移留待阶段 3 的 Manager 策略层。
 */
import type {
  AgentRecord,
  AgentStepRecord,
  AgentStep,
  TokenUsage,
  TerminalType,
  ConversationKind
} from '@shared/types'
import { inferConversationKind } from '@shared/types'
import type { AiMessage } from '../ai.service'
import { TaskMemoryStore, type LookupToolMeta } from '../agent/task-memory'
import { splitMessagesIntoTasks, splitStepsIntoTasks, stepRecordToStep } from './messages'

export interface ConversationCreateOptions {
  /** 显式指定会话 id（恢复/漫游续写既有会话）；省略则生成 `session_<ts>` */
  id?: string
  /** 会话开始时间（恢复时取历史记录的 timestamp）；省略则 Date.now() */
  createdAt?: number
  sshHost?: string
}

/**
 * 工作记忆（taskMemory）的来源。
 * - `taskMemory`：注入一个**现成实例**。Agent 用此在 startNewSession（换 session 但保留工作记忆，
 *   如 Watch）时把同一个 store 传给新 Conversation，保持现状的「跨 session 记忆」语义。
 * - `lookupMeta`：未注入实例时，新建一个 TaskMemoryStore 并用此回调查工具元数据（纯函数，保持纯净）。
 *
 * taskMemory 完全归 Conversation 所有权的转移，留待阶段 3（Manager 策略层）。
 */
export interface ConversationDeps {
  taskMemory?: TaskMemoryStore
  lookupMeta?: LookupToolMeta
}

/** finalizeRun 的状态部分入参（与 Agent 的 AgentRun 解耦：只传纯数据） */
export interface CommitRunInput {
  /** run.id（作为 taskMemory 的 taskId） */
  runId: string
  /** run.originalUserRequest（任务标题） */
  userRequest: string
  /** run.steps：已含 user_task + final_result（给 taskMemory 和 _steps 累积） */
  steps: AgentStep[]
  /** run.taskMessageLog：本次 run 的完整 API 消息（**不含**最终纯文本 assistant 回复，由本方法补） */
  taskMessageLog: AiMessage[]
  /** run.messages：发给模型的消息（**不含**最终纯文本回复，cache 快照基于它） */
  runMessages: AiMessage[]
  /** 任务成败（run.aborted ? 'aborted' : 'success'） */
  taskStatus: 'success' | 'aborted'
  /** 最终纯文本回复（可能为空） */
  result: string | null
  /** 最近一次响应的 reasoning_content（思考模式下必须随 finalMsg 回传，含空串保留） */
  reasoningContent?: string
  /** 本次 run 的 token 用量 */
  tokenUsage?: TokenUsage
}

export class Conversation {
  // ===== 身份（不可变） =====
  readonly id: string
  readonly kind: ConversationKind
  readonly createdAt: number

  // ===== 形态（会话创建时确定、不可变） =====
  readonly terminalType: TerminalType
  readonly sshHost?: string

  // ===== 运行时绑定（可变：会话漫游时换接管 tab/实例，形态不变） =====
  private _agentKey: string

  // ===== 唯一真相源：对话全过程 =====
  private _messages: AiMessage[] = []
  private _steps: AgentStep[] = []

  // ===== 派生投影 =====
  private readonly _taskMemory: TaskMemoryStore
  /** 上一次 run 结束时的完整 messages 快照，用于跨任务 prompt cache 前缀复用（原 _previousRunMessages） */
  private _cachePrefix?: AiMessage[]

  // ===== token 账 =====
  private _tokenUsage?: TokenUsage
  private _lastPromptTokens?: number
  private _lastCacheHitRate?: number

  /** 恢复任务 id 的实例级单调序号，避免同毫秒多次 split 生成的 task id 碰撞（原 _restoreTaskSeq） */
  private _restoreTaskSeq = 0
  private _dirty = false

  private constructor(
    id: string,
    kind: ConversationKind,
    createdAt: number,
    terminalType: TerminalType,
    sshHost: string | undefined,
    agentKey: string,
    taskMemory: TaskMemoryStore
  ) {
    this.id = id
    this.kind = kind
    this.createdAt = createdAt
    this.terminalType = terminalType
    this.sshHost = sshHost
    this._agentKey = agentKey
    this._taskMemory = taskMemory
  }

  // ==================== 工厂 / 序列化 ====================

  /**
   * 新建会话。kind 默认由 agentKey 推断（companion/watch/task），与历史记录的补默认口径一致。
   */
  static create(
    params: {
      agentKey: string
      terminalType: TerminalType
      kind?: ConversationKind
    },
    opts?: ConversationCreateOptions,
    deps?: ConversationDeps
  ): Conversation {
    const kind = params.kind ?? inferConversationKind(params.agentKey)
    return new Conversation(
      opts?.id ?? `session_${Date.now()}`,
      kind,
      opts?.createdAt ?? Date.now(),
      params.terminalType,
      opts?.sshHost,
      params.agentKey,
      deps?.taskMemory ?? new TaskMemoryStore(deps?.lookupMeta)
    )
  }

  /**
   * 从持久化记录反序列化，并重建工作记忆（taskMemory）。
   * 忠实移植 Agent.restoreFromSessionRecord：优先用 messages 切分，缺 messages 的老记录降级用 steps。
   * 注意：**不**恢复 `_cachePrefix`——cache 前缀仅由 commitRun 设置，恢复后的首个 run 走冷启动（与现状一致）。
   */
  static fromRecord(record: AgentRecord, deps?: ConversationDeps): Conversation {
    const conv = new Conversation(
      record.id,
      record.kind ?? inferConversationKind(record.agentKey),
      record.timestamp,
      record.terminalType,
      record.sshHost,
      record.agentKey ?? '',
      deps?.taskMemory ?? new TaskMemoryStore(deps?.lookupMeta)
    )
    conv.loadFromRecord(record)
    return conv
  }

  /**
   * 把一条记录的 transcript 装载进**本实例**并重建工作记忆。
   * 移植自 Agent.restoreFromSessionRecord，供 Agent 在已建会话后从 latest 记录恢复续写状态
   *（持久命名 Agent 的 restoreRecentTaskMemory 另写同一注入 taskMemory，两者叠加）。
   *
   * **刻意不恢复 token 账**：与现状 restoreFromSessionRecord 对齐——重开会话后 _sessionTokenUsage
   * 保持空白、从零累积（保留当前行为；是否改为持久化累积是另一项独立决策，不在本次重构内）。
   */
  loadFromRecord(record: AgentRecord): void {
    if (record.messages && record.messages.length > 0) {
      const tasks = splitMessagesIntoTasks(
        record.messages as AiMessage[],
        () => `restored_${Date.now()}_${this._restoreTaskSeq++}`
      )
      for (const task of tasks) {
        this._taskMemory.saveTask(task.id, task.userTask, [], 'success', task.finalResult, task.messages)
      }
    } else if (record.steps && record.steps.length > 0) {
      const baseTs = record.steps[0]?.timestamp || Date.now()
      const tasks = splitStepsIntoTasks(record.steps, i => `restored_${baseTs}_${i}`)
      for (const task of tasks) {
        this._taskMemory.saveTask(task.id, task.userTask, task.steps, 'success', task.finalResult)
      }
    }

    this.setRestoredTranscript(record.messages as AiMessage[] | undefined, record.steps)
  }

  /**
   * 仅装载 transcript（_messages / _steps），不碰 taskMemory。
   * 供 Agent 的 restoreFromSessionRecord 复用——那里 taskMemory 由 Agent 用**自己的** split/seq
   * 写入（与 restoreRecentTaskMemory 共享单调序号，防同毫秒 task id 碰撞），transcript 则交本方法。
   * 守卫 `length === 0`：与现状一致，已有 transcript 时不覆盖（续写续聊保留旧产出物字段）。
   */
  setRestoredTranscript(messages?: AiMessage[], stepRecords?: AgentStepRecord[]): void {
    if (stepRecords && stepRecords.length > 0 && this._steps.length === 0) {
      this._steps = stepRecords.map(s => stepRecordToStep(s))
    }
    if (messages && messages.length > 0 && this._messages.length === 0) {
      this._messages = messages.map(m => ({ ...m }))
    }
  }

  /**
   * 序列化为持久化记录。忠实移植 Agent.saveSessionToHistory 的 record 构建。
   * 无 user_task（空会话）返回 null——与现状「找不到 firstUserTask 直接 return」对齐。
   */
  toRecord(opts?: { terminalId?: string }): AgentRecord | null {
    const firstUserTask = this._steps.find(s => s.type === 'user_task')
    if (!firstUserTask) return null

    const lastFinalResult = [...this._steps].reverse().find(s => s.type === 'final_result')

    // 会话整体状态由 taskMemory 最后一个任务的状态决定（比关键词匹配准确）
    let status: 'completed' | 'failed' | 'aborted' = 'completed'
    const lastTask = this._taskMemory.getSummaries(1)[0]
    if (lastTask) {
      if (lastTask.status === 'aborted') status = 'aborted'
      else if (lastTask.status === 'failed') status = 'failed'
    }

    const serializableSteps: AgentStepRecord[] = this._steps.map(s => Conversation.stepToStepRecord(s))

    return {
      id: this.id,
      kind: this.kind,
      timestamp: this.createdAt,
      terminalId: opts?.terminalId || '',
      agentKey: this._agentKey,
      terminalType: this.terminalType,
      sshHost: this.sshHost,
      userTask: firstUserTask.content,
      steps: serializableSteps,
      messages: this._messages.map(m => JSON.parse(JSON.stringify(m))),
      finalResult: lastFinalResult?.content,
      duration: Date.now() - this.createdAt,
      status,
      tokenUsage: this._tokenUsage
    }
  }

  // ==================== run 提交（finalizeRun 的状态部分） ====================

  /**
   * 提交一次 run 的结果到会话状态。忠实移植 Agent.finalizeRun + accumulateSessionData 的状态部分：
   * 1. 补最终纯文本 assistant 回复（带 reasoning_content，思考模式必需）到 taskMessageLog
   * 2. 存入 taskMemory（L1 工作记忆）
   * 3. 刷新 cache 前缀快照（runMessages + finalMsg）
   * 4. 累积 transcript（_steps / _messages）与 token 账
   */
  commitRun(input: CommitRunInput): void {
    const finalMsg = this.buildFinalAssistantMessage(input.result, input.reasoningContent)

    // 完整对话日志（含最终回复）——saveTask 与 transcript 累积共用
    const taskLog = [...input.taskMessageLog]
    if (finalMsg) taskLog.push(finalMsg)

    this._taskMemory.saveTask(
      input.runId,
      input.userRequest,
      input.steps,
      input.taskStatus,
      input.result ?? undefined,
      taskLog
    )

    // cache 前缀：run.messages（不含最终纯文本回复）+ 补最终回复
    const snapshot = input.runMessages.map(m => ({ ...m }))
    if (finalMsg) snapshot.push(finalMsg)
    this._cachePrefix = snapshot

    this.accumulate(input.steps, taskLog, input.tokenUsage)
  }

  /**
   * 提交一次**失败** run（Agent.handleError 的状态部分）。与成功路径不对称：
   * 错误 assistant 回复已由 Agent 先 push 进 run.messages / taskMessageLog（保证悬空 tool_calls 被补全），
   * 故 taskLog 已含最终回复、不再补；cache 前缀由调用方按「run.messages 是否含 user」决定传入或 null
   *（buildContext 阶段就抛错时不更新前缀，保留上次成功快照走冷启动）。
   */
  commitFailedRun(input: {
    runId: string
    userRequest: string
    steps: AgentStep[]
    /** 完整失败现场日志（**已含**错误 assistant 回复） */
    taskLog: AiMessage[]
    /** 新 cache 前缀（已含错误回复）；null = 不更新前缀（保留上次成功快照） */
    cachePrefix: AiMessage[] | null
    errorMessage: string
    tokenUsage?: TokenUsage
  }): void {
    this._taskMemory.saveTask(
      input.runId,
      input.userRequest,
      input.steps,
      'failed',
      input.errorMessage,
      input.taskLog
    )

    if (input.cachePrefix) {
      this._cachePrefix = input.cachePrefix.map(m => ({ ...m }))
    }

    this.accumulate(input.steps, input.taskLog, input.tokenUsage)
  }

  /** 累积 transcript（_steps / _messages）与 token 账——成功/失败路径共用。 */
  private accumulate(steps: AgentStep[], taskLog: AiMessage[], tokenUsage?: TokenUsage): void {
    this._steps.push(...steps)
    this._messages.push(...taskLog)

    if (tokenUsage) {
      if (!this._tokenUsage) {
        this._tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }
      this._tokenUsage.prompt_tokens += tokenUsage.prompt_tokens
      this._tokenUsage.completion_tokens += tokenUsage.completion_tokens
      this._tokenUsage.total_tokens += tokenUsage.total_tokens
      if (tokenUsage.cache_hit_tokens !== undefined) {
        this._tokenUsage.cache_hit_tokens = (this._tokenUsage.cache_hit_tokens || 0) + tokenUsage.cache_hit_tokens
      }
      if (tokenUsage.cache_miss_tokens !== undefined) {
        this._tokenUsage.cache_miss_tokens = (this._tokenUsage.cache_miss_tokens || 0) + tokenUsage.cache_miss_tokens
      }
    }

    this._dirty = true
  }

  private buildFinalAssistantMessage(result: string | null, reasoningContent?: string): AiMessage | null {
    if (result == null) return null
    const finalMsg: AiMessage = { role: 'assistant', content: result }
    // 思考模式：!== undefined 保留空串，避免 DeepSeek V3.2+ 因字段缺失报 400
    if (reasoningContent !== undefined) {
      finalMsg.reasoning_content = reasoningContent
    }
    return finalMsg
  }

  // ==================== cache 前缀（buildContext 的纯判定部分） ====================

  /**
   * 是否应复用 cache 前缀（buildContext 的「Cache-optimized path」判定，忠实移植）。
   * 跳过条件：无前缀、唤醒 run（wakeup）、前缀 token 超上下文 70%。
   */
  shouldReuseCachePrefix(contextLength: number, opts: { wakeup?: boolean; estimateTokens: (msgs: AiMessage[]) => number }): boolean {
    if (!this._cachePrefix || this._cachePrefix.length === 0) return false
    if (opts.wakeup) return false
    const prevTokens = this._lastPromptTokens || opts.estimateTokens(this._cachePrefix)
    return prevTokens < contextLength * 0.7
  }

  /**
   * 取出 cache 前缀的拷贝并清除旧断点标记（调用方负责设置新断点 + 追加新 user 消息）。
   * 仅在 shouldReuseCachePrefix() 为真时调用。
   */
  prepareCachePrefix(): AiMessage[] {
    return (this._cachePrefix ?? []).map(m => {
      const copy = { ...m }
      delete (copy as Record<string, unknown>)._cacheBreakpoint
      return copy
    })
  }

  getCachePrefix(): AiMessage[] | undefined {
    return this._cachePrefix
  }

  /** 直接设置 cache 前缀（fork 同形态时由调用方传入 newRecord.messages，命中 LLM 前缀缓存） */
  setCachePrefix(messages: AiMessage[] | undefined): void {
    this._cachePrefix = messages ? messages.map(m => JSON.parse(JSON.stringify(m))) : undefined
  }

  // ==================== 会话操作 ====================

  /** 会话漫游：仅换接管的 tab/实例（agentKey），形态不变（限同 terminalType，由调用方保证） */
  rebind(agentKey: string): void {
    if (this._agentKey === agentKey) return
    this._agentKey = agentKey
    this._dirty = true
  }

  /**
   * 清空对话（reset）：清空 transcript / 工作记忆 / cache / token 账。
   * 对应 Agent.resetSession 的状态部分（会话身份的销毁/重建由上层 Manager 负责）。
   */
  reset(): void {
    this._messages = []
    this._steps = []
    this._cachePrefix = undefined
    this._tokenUsage = undefined
    this._lastPromptTokens = undefined
    this._lastCacheHitRate = undefined
    this._taskMemory.clear()
    this._dirty = true
  }

  // ==================== token 账 setter（API 调用后由 Agent 回填） ====================

  setLastPromptTokens(tokens: number | undefined): void {
    this._lastPromptTokens = tokens
  }
  setLastCacheHitRate(rate: number | undefined): void {
    this._lastCacheHitRate = rate
  }

  // ==================== 访问器 ====================

  get agentKey(): string { return this._agentKey }
  get messages(): readonly AiMessage[] { return this._messages }
  get steps(): readonly AgentStep[] { return this._steps }
  get taskMemory(): TaskMemoryStore { return this._taskMemory }
  get tokenUsage(): TokenUsage | undefined { return this._tokenUsage }
  get lastPromptTokens(): number | undefined { return this._lastPromptTokens }
  get lastCacheHitRate(): number | undefined { return this._lastCacheHitRate }
  get isDirty(): boolean { return this._dirty }
  markClean(): void { this._dirty = false }

  // ==================== 私有：step 运行时 → 持久化记录（序列化，toRecord 用） ====================
  // 切分逻辑（split*）与 record→step 转换已抽到 ./messages 纯函数，Agent 与本类共用。

  private static stepToStepRecord(s: AgentStep): AgentStepRecord {
    return {
      id: s.id,
      type: s.type,
      content: s.content || '',
      images: s.images,
      echartsOption: s.echartsOption,
      attachments: s.attachments,
      toolName: s.toolName,
      toolArgs: s.toolArgs ? JSON.parse(JSON.stringify(s.toolArgs)) : undefined,
      toolResult: s.toolResult,
      riskLevel: s.riskLevel,
      timestamp: s.timestamp,
      webSearchResults: s.webSearchResults,
      success: s.success,
      subAgents: s.subAgents,
      canvasData: s.canvasData
    }
  }
}
