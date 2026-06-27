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
import { createLogger } from '../../utils/logger'

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

  // ==================== 查询委托（单一入口，未来 list/search 之家） ====================

  /** 按 id（sessionId）精确读取一条会话。 */
  getRecord(id: string): AgentRecord | undefined {
    return this.store.load(id)
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
