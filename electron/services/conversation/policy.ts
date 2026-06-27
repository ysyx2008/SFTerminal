/**
 * CONVERSATION_POLICY —— 按 kind 的数据驱动行为策略表
 *
 * 设计依据：docs/conversation-refactor-design.md §3.4。
 *
 * 为什么用一张表而不是散落的 `if (_persistentNamedAgent)` / `if (wakeup)` / `if (agentKey==='__watch__')`：
 * 三类会话（task / companion / watch）的行为差异是**数据差异**，不是**类型差异**——一个
 * `Conversation` 类即可，不需要继承树。把差异收进这张表，决策点只读表、不写分支，
 * 遵循 `agent-oop-boundary` 规矩（不在 Agent/会话逻辑里散布 kind 字面量分支）。
 *
 * 今天散在 agent.ts 的血泪 if-else（`_persistentNamedAgent` 回种 / wakeup 跳过 cache /
 * watch 独立历史树 / watch 不进列表）都应收敛成读这张表。
 */
import type { ConversationKind } from '@shared/types'

export interface ConversationPolicy {
  /**
   * 是否累积成一条长期线。
   * - task/companion=true：跨 run 累积 transcript，是一条连续的线。
   * - watch=false：逐次触发、用完即弃（内心独白不积累成长期对话）。
   */
  accumulates: boolean

  /**
   * 冷启动时是否从全局最近历史回种（== 旧的 `_persistentNamedAgent`：固定 ID、跨 App 重启复用
   * 的「持久命名 Agent」）。它驱动两处：
   *   ① run 初始化：无 sessionId 入口（IM/网关/主动消息）从最近一条同 agentKey 历史回种
   *      sessionId（再经 `!suppressSeed` 门控）；
   *   ② 恢复阶段：taskMemory 为空时 `restoreRecentTaskMemory` 从全局最近历史重建工作记忆。
   *
   * - companion=true：联络是「同一条长期关系线」，①② 都要——重启后续上同一条、记得最近聊过什么。
   * - **watch=true（保留现状！）**：桌面 watch 经 `runAssistant → createAssistantAgent('__watch__')`
   *   被标为持久命名，①被 `startNewSession` 的 suppress 门控掉（仍新起独立 session）、②会重建最近
   *   工作记忆。这是**当前真实行为**，本次重构刻意保真。是否改成「watch 完全失忆/逐次隔离」属于
   *   尚未拍板的 watch 连续性议题（见 `perWatchContinuity`），不在重构内动。
   * - task=false：新 tab 第一次对话本就是新任务，注入历史会造成工具名幻觉调用。
   */
  seedFromHistoryOnColdStart: boolean

  /**
   * 是否进会话列表 / 任务侧栏。
   * - task/companion=true（companion 另进独立常驻 tab，由前端按 agentKey 再做区分）。
   * - watch=false：内心独白不进用户会话列表（要让用户看见须经 talk_to_user 冒泡进联络）。
   */
  visibleInList: boolean

  /**
   * 历史存储树。
   * - task/companion='main'：进主历史树。
   * - watch='watch'：进独立历史树，避免高频内心独白把主索引压舱（曾达 149MB/2.6w 条）。
   */
  historyTree: 'main' | 'watch'

  /**
   * 【预留钩子，默认 false=维持现状】每个**具体 Watch**（watchId 维度，非 `__watch__` 整体）
   * 是否保留跨执行的连续时间线——即「记得自己上次这个 watch 做过什么」。
   *
   * 现状：watch 逐次失忆（`accumulates=false`）。这个 hook 用于将来按真机表现，
   * 给**部分**有状态巡检类 watch 单独开启连续性，而不影响整体。
   *
   * ⚠️ 心跳（高频、重复、无状态）应**始终保持 false**，否则会把无意义的重复独白
   * 累积成噪声，污染上下文与成本。开启前须先想清楚「哪些 watch 值得记」。
   *
   * 当前所有 kind 一律 false；真正按 watchId 细分的开关晚于本阶段再落，且应落在
   * Watch 配置层（watchId 维度），不在这张 kind 级表上扩展。
   */
  perWatchContinuity: boolean
}

/**
 * 三类会话的行为策略。
 *
 * | kind      | accumulates | seedFromHistoryOnColdStart | visibleInList | historyTree | perWatchContinuity |
 * |-----------|-------------|----------------------------|---------------|-------------|--------------------|
 * | task      | true        | false                      | true          | main        | false              |
 * | companion | true        | true                       | true          | main        | false              |
 * | watch     | false       | true（保真，见字段注释）    | false         | watch       | false（预留）       |
 *
 * 注：`seedFromHistoryOnColdStart` 对 watch=true，是因为它 1:1 对应旧 `_persistentNamedAgent`
 * （companion + watch 都是持久命名 Agent）。watch 的「逐次隔离」体现在 accumulates/visibleInList/
 * historyTree 三轴，而非冷启动回种这一轴——是否让 watch 也不回种属于待拍板的连续性议题。
 */
export const CONVERSATION_POLICY: Record<ConversationKind, ConversationPolicy> = {
  task: {
    accumulates: true,
    seedFromHistoryOnColdStart: false,
    visibleInList: true,
    historyTree: 'main',
    perWatchContinuity: false
  },
  companion: {
    accumulates: true,
    seedFromHistoryOnColdStart: true,
    visibleInList: true,
    historyTree: 'main',
    perWatchContinuity: false
  },
  watch: {
    accumulates: false,
    seedFromHistoryOnColdStart: true,
    visibleInList: false,
    historyTree: 'watch',
    perWatchContinuity: false
  }
}

/** 取某个 kind 的策略（封装 record 访问，便于将来加运行期覆盖/校验）。 */
export function conversationPolicy(kind: ConversationKind): ConversationPolicy {
  return CONVERSATION_POLICY[kind]
}
