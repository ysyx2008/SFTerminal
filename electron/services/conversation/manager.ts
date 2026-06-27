/**
 * ConversationManager —— 会话生命周期 / 策略接缝
 *
 * 设计依据：docs/conversation-refactor-design.md §3.1 / §3.4 / §4.2。
 *
 * 职责（本阶段 = 策略 + 查询接缝）：
 * - 持有 `ConversationStore` + `CONVERSATION_POLICY`，作为「按 kind 决策 + 会话查询」的唯一入口。
 * - 把今天散在 `Agent` 上的回种分支（旧 `_persistentNamedAgent`）收敛成读策略表：
 *   `seedsFromHistory()` / `resolveSeedSessionId()`。
 * - 给 `AgentService` / `Agent` 一个名字达意的接缝，不再各处直接伸手进 `HistoryService`。
 *
 * 边界（本阶段刻意不做，留待 Phase 4 与「Agent 去状态化」一并做）：
 * - **不**拥有 `Map<id, Conversation>`、**不**做 `resolveForRun` 的所有权反转——那会大面积
 *   改动 Agent 的 run 流程与 historyService 直调，与 taskMemory 所有权转移强耦合。
 *   现阶段 Conversation 仍由 Agent 持有，Manager 只承接「按 kind 的决策」与「会话查询委托」。
 */
import type { AgentRecord, AgentHistorySummary, ConversationKind } from '@shared/types'
import { inferConversationKind } from '@shared/types'
import { ConversationStore } from './storage'
import { conversationPolicy, type ConversationPolicy } from './policy'
import type { SearchAgentRecordsResult } from '../history.service'
import { createLogger } from '../../utils/logger'

/** 会话搜索入参（IPC 口径：excludeWakeup 表示「任务侧栏」过滤，由 Manager 翻译成 policy filter）。 */
export interface ConversationSearchOptions {
  keyword?: string
  startDate?: string
  endDate?: string
  limit?: number
  excludeWakeup?: boolean
  titleOnly?: boolean
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
      filter: options.excludeWakeup ? this.taskScoped : undefined
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
}

export type { ConversationKind }
