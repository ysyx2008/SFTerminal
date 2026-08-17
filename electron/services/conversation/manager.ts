/**
 * ConversationManager —— 策略决策 + 会话工厂 + 查询委托
 *
 * 设计依据：docs/conversation-refactor-design.md §3.1 / §3.4 / §4.2 + 「4B 精简版：馆长发证」。
 *
 * 职责：
 * - 持有 `ConversationStore` + `CONVERSATION_POLICY`，作为「按 kind 决策 + 会话查询」的唯一入口。
 * - **策略决策**：把旧散在 `Agent` 上的回种分支（旧 `_persistentNamedAgent`）收敛成读策略表：
 *   `seedsFromHistory()` / `resolveSeedSessionId()`。
 * - **会话工厂（馆长发证）**：`openConversationForRun()`（回种决策 + 建会话一次完成）/
 *   `openConversation()`（显式 id 建会话，供 fork）。Agent 不再自己 `Conversation.create` + 内联回种。
 * - **查询委托**：给 `AgentService` / `Agent` / IPC 一个名字达意的会话读侧权威，不再各处直伸手进 `HistoryService`。
 *
 * 边界（完整 4B 已决定不做，当前即终态）：
 * - **不**拥有 `Map<id, Conversation>`、**不**做 `taskMemory` 所有权反转——会话仍由 Agent 持有、
 *   taskMemory 仍是 Agent 级跨会话记忆（一个会话只由单个 Agent 独占记录，且 Agent 需跨多条会话
 *   读历史以维持记忆持续性，故 taskMemory 留在 Agent 才正确）。Manager 只「发证」不「总账」。
 */
import type { AgentRecord, AgentHistorySummary, ConversationKind, TerminalType } from '@shared/types'
import { inferConversationKind } from '@shared/types'
import { ConversationStore } from './storage'
import { Conversation } from './conversation'
import { conversationPolicy, type ConversationPolicy } from './policy'
import type { SearchAgentRecordsResult } from '../history/agent-record-store'
import type { TaskMemoryStore } from '../agent/task-memory'
import { createLogger } from '../../utils/logger'

/** 会话搜索入参（IPC 口径：excludeWakeup 表示「任务侧栏」过滤，由 Manager 翻译成 policy filter）。 */
export interface ConversationSearchOptions {
  keyword?: string
  startDate?: string
  endDate?: string
  limit?: number
  excludeWakeup?: boolean
  titleOnly?: boolean
  onMatch?: (record: AgentRecord) => void
  signal?: AbortSignal
}

const log = createLogger('ConversationManager')

export class ConversationManager {
  constructor(private readonly store: ConversationStore) {}

  /** 暴露存储接缝（过渡期个别调用方需要直接用 Store 时）。 */
  get conversationStore(): ConversationStore {
    return this.store
  }

  // ==================== 策略 ====================

  /** 取某个 agentKey 对应 kind 的行为策略。 */
  policyOf(agentKey: string | undefined): ConversationPolicy {
    return conversationPolicy(inferConversationKind(agentKey))
  }

  /**
   * 该 agentKey 冷启动时是否从全局最近历史回种（替代旧 `_persistentNamedAgent` 布尔）。
   * 仅 companion=true（联络是同一条长期关系线，跨重启续上）。
   */
  seedsFromHistory(agentKey: string | undefined): boolean {
    return this.policyOf(agentKey).seedFromHistoryOnColdStart
  }

  /**
   * 解析一次冷启动（首个 run、无既有会话）应使用的 sessionId / startTime。
   * 忠实收敛 Agent.run 初始化里的回种分支（design §3.4）：
   *   1. 入口显式带 sessionId（如用户从「最近对话」恢复、漫游续聊）→ 直接用。
   *   2. 否则若 policy 要回种（companion）且未被 suppress → 从最近一条同 agentKey 历史回种，
   *      避免无 sessionId 入口（IM/网关/主动消息）新起 session_${Date.now()} 而与历史断链
   *      （「联络裂成两条 session」根因）。
   *   3. 其余（task / watch / 无历史 / suppressSeed）→ 新起 session_${Date.now()}。
   */
  resolveSeedSessionId(opts: {
    agentKey: string | undefined
    contextSessionId?: string
    contextStartTime?: number
    suppressSeed?: boolean
  }): { sessionId: string; startTime: number } {
    if (opts.contextSessionId) {
      return {
        sessionId: opts.contextSessionId,
        startTime: opts.contextStartTime || Date.now()
      }
    }

    if (this.seedsFromHistory(opts.agentKey) && !opts.suppressSeed) {
      const latest = opts.agentKey ? this.store.latestByAgentKey(opts.agentKey) : undefined
      if (latest) {
        log.info(
          `Seeded sessionId from history for ${opts.agentKey}: ${latest.id} ` +
            `(no context.sessionId, avoid forking a disconnected session)`
        )
        return { sessionId: latest.id, startTime: latest.timestamp }
      }
    }

    return { sessionId: `session_${Date.now()}`, startTime: Date.now() }
  }

  // ==================== 会话工厂（Manager 发证：Agent 不再自己 new Conversation） ====================

  /**
   * 为一次 run「开一本会话」：把"决定用哪个 sessionId（回种 / 新建）"与"建 Conversation"
   * 合成一次调用，交还一个现成的聚合根。这样 Agent 只管用，不再自己做回种决策 + `Conversation.create`
   *（旧 run 初始化里那段 `_persistentNamedAgent` 内联分支由此收口）。
   *
   * 形态（terminalType/sshHost）创建时定、不可变；工作记忆按需注入（Agent 传它持有的实例，
   * 维持「换 session 保留记忆」语义——taskMemory 仍是 Agent 级跨会话记忆，所有权不在本步转移）。
   */
  openConversationForRun(params: {
    agentKey: string | undefined
    terminalType: TerminalType
    sshHost?: string
    contextSessionId?: string
    contextStartTime?: number
    suppressSeed?: boolean
    taskMemory?: TaskMemoryStore
  }): Conversation {
    const seed = this.resolveSeedSessionId({
      agentKey: params.agentKey,
      contextSessionId: params.contextSessionId,
      contextStartTime: params.contextStartTime,
      suppressSeed: params.suppressSeed
    })
    return Conversation.create(
      { agentKey: params.agentKey ?? '', terminalType: params.terminalType },
      { id: seed.sessionId, createdAt: seed.startTime, sshHost: params.sshHost },
      { taskMemory: params.taskMemory }
    )
  }

  /**
   * 用**显式** sessionId 开一本会话（不做回种决策）。供 fork 等"会话 id 已定"的场景，
   * 让 Agent 同样不必直接 `Conversation.create`。
   * @param params.startTime 会话开始时间戳；省略则 `Date.now()`（fork 取当前时刻即可）。
   */
  openConversation(params: {
    agentKey: string | undefined
    terminalType: TerminalType
    sshHost?: string
    sessionId: string
    startTime?: number
    taskMemory?: TaskMemoryStore
  }): Conversation {
    return Conversation.create(
      { agentKey: params.agentKey ?? '', terminalType: params.terminalType },
      { id: params.sessionId, createdAt: params.startTime ?? Date.now(), sshHost: params.sshHost },
      { taskMemory: params.taskMemory }
    )
  }

  // ==================== 查询委托（会话读侧权威：list / search / get / delete） ====================

  /**
   * 「任务侧栏」可见性谓词：只有 `kind=task` 进任务侧栏。
   * 封装原本散落在 main.ts IPC handler 里的 `agentKey !== '__watch__' && agentKey !== '__companion__'
   * && !id.startsWith('watch_')` 字面量过滤——companion 有独立常驻 tab、watch 是内心独白，都排除。
   * `!id.startsWith('watch_')` 是对缺 agentKey 的旧 watch 记录的防御兜底。
   */
  private readonly taskScoped = (r: AgentRecord): boolean =>
    inferConversationKind(r.agentKey) === 'task' && !r.id.startsWith('watch_')

  /** 按 id（sessionId）精确读取一条会话。 */
  getRecord(id: string): AgentRecord | undefined {
    return this.store.load(id)
  }

  /** 按日期范围取完整会话记录。 */
  byDateRange(startDate?: string, endDate?: string): AgentRecord[] {
    return this.store.byDateRange(startDate, endDate)
  }

  /**
   * 最近 N 条会话记录。`excludeWakeup=true` 为任务侧栏口径（仅 task，剔除 companion/watch）。
   */
  recentRecords(limit = 5, excludeWakeup = false): AgentRecord[] {
    return this.store.recent(limit, excludeWakeup ? this.taskScoped : undefined)
  }

  /**
   * 高级搜索。`excludeWakeup=true` 时按任务侧栏口径过滤（仅 task）。
   */
  search(options: ConversationSearchOptions): Promise<SearchAgentRecordsResult> {
    return this.store.search({
      keyword: options.keyword,
      startDate: options.startDate,
      endDate: options.endDate,
      limit: options.limit ?? 50,
      titleOnly: options.titleOnly,
      filter: options.excludeWakeup ? this.taskScoped : undefined,
      onMatch: options.onMatch,
      signal: options.signal
    })
  }

  /** 取某 agentKey 最近一条会话（联络/关切重启回种用）。 */
  latestByAgentKey(agentKey: string): AgentRecord | undefined {
    return this.store.latestByAgentKey(agentKey)
  }

  /** 取某 agentKey 最近 N 条会话（倒序）。 */
  recentByAgentKey(agentKey: string, limit = 10): AgentRecord[] {
    return this.store.recentByAgentKey(agentKey, limit)
  }

  /** 主历史树最近 N 条（任务/联络，不含 watch 内心独白）。 */
  recent(limit = 5, filter?: (r: AgentRecord) => boolean): AgentRecord[] {
    return this.store.recent(limit, filter)
  }

  /** watch 独立历史树最近 N 条执行记录。 */
  recentWatch(limit = 20, filter?: (r: AgentRecord) => boolean): AgentRecord[] {
    return this.store.recentWatch(limit, filter)
  }

  /**
   * 列出会话轻量摘要。`excludeWakeup=true` 为「任务侧栏」口径
   * （剔除 watch 内心独白与联络，对齐 policy.visibleInList / 前端 agentKey 过滤）。
   */
  listSummaries(excludeWakeup?: boolean): AgentHistorySummary[] {
    return this.store.listSummaries(excludeWakeup)
  }

  /** 删除一条会话（正文 + 索引）。 */
  delete(id: string): boolean {
    return this.store.delete(id)
  }

  /**
   * 更新会话展示标题（领域入口）。未变化不写盘。
   */
  updateTitle(id: string, title: string, opts?: { locked?: boolean }): boolean {
    return this.store.updateTitle(id, title, opts)
  }
}

export type { ConversationKind }
