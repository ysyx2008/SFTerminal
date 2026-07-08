/**
 * ConversationStore —— 会话存储接缝
 *
 * 职责：给 ConversationManager 一个**名字达意、面向会话**的存储边界，把「会话怎么落盘/读盘/
 * 维护索引/区分 main/watch 树」这件事收口到一处。
 *
 * 设计要点（见 docs/conversation-refactor-design.md §4.3）：
 * - **真实接缝**：底层真相源是 `AgentRecordStore`（从 HistoryService 抽出的会话存储聚合，
 *   拥有两棵历史树 + 索引机器 + 图片外化）。本类把它包成面向会话的干净边界——Manager 只跟
 *   它打交道，不直接伸手进 HistoryService 这个仍管着聊天记录/统计/备份的「大类」。
 * - **复用 `@shared/types` 的 `AgentRecord`**：不造平行的 `ConversationRecord`/扁平 messages 模型
 *   （红线③：禁止平行类型）。
 * - **main/watch 路由自动完成**：`AgentRecordStore` 按 `agentKey === '__watch__' || agentKey === '__wakeup__'`
 *   把 watch/wakeup 隔离到独立历史树，调用方无需关心。
 *
 * 这就是「将来要换索引实现 / 换盘格式只动这一处」的接缝——现在它是真的：换 store 实现只影响
 * 本类，不波及 Manager 或 HistoryService。
 */
import type { AgentRecord, AgentHistorySummary } from '@shared/types'
import { AgentRecordStore, type SearchAgentRecordsOptions, type SearchAgentRecordsResult } from '../history/agent-record-store'

export class ConversationStore {
  constructor(private readonly store: AgentRecordStore) {}

  /**
   * 落盘一条会话记录（写正文 + 更新索引；按 agentKey 自动路由 main/watch 树）。
   * 会话粒度：同一 `record.id`（sessionId）重复 save 即覆盖更新同一条，不新增。
   */
  save(record: AgentRecord): void {
    this.store.saveAgentRecord(record)
  }

  /** 按 id（sessionId）精确读取一条会话；不存在返回 undefined。 */
  load(id: string): AgentRecord | undefined {
    return this.store.getAgentRecordById(id)
  }

  /** 删除一条会话（正文 + 索引条目）。返回是否实际删除。 */
  delete(id: string): boolean {
    return this.store.deleteAgentRecord(id)
  }

  /**
   * 取某个 agentKey 最近的一条会话（按最后活跃时间）。
   * 用于联络/关切等常驻命名 Agent 重启后回种 sessionId。
   */
  latestByAgentKey(agentKey: string): AgentRecord | undefined {
    return this.store.getLatestRecordByAgentKey(agentKey)
  }

  /**
   * 取某个 agentKey 最近 N 条会话（倒序）。
   * 用于联络常驻 tab 重启后合并展示 / 跨会话回种工作记忆。
   */
  recentByAgentKey(agentKey: string, limit = 10): AgentRecord[] {
    return this.store.getRecentRecordsByAgentKey(agentKey, limit)
  }

  /**
   * 取主历史树最近 N 条会话（任务/联络，不含 watch 内心独白）。
   * filter 在索引层先过滤，避免无谓读盘。
   */
  recent(limit = 5, filter?: (r: AgentRecord) => boolean): AgentRecord[] {
    return this.store.getRecentAgentRecords(limit, filter)
  }

  /**
   * 取 watch（关切）独立历史树最近 N 条执行记录。
   * 与主历史物理隔离，仅供关切执行审计，不进任务/联络列表。
   */
  recentWatch(limit = 20, filter?: (r: AgentRecord) => boolean): AgentRecord[] {
    return this.store.getRecentWatchRecords(limit, filter)
  }

  /**
   * 列出全部会话的轻量摘要（来自索引，不读各日 JSON）。
   * `excludeWakeup=true` 时剔除 watch 内心独白与联络会话——即「任务」侧栏口径。
   */
  listSummaries(excludeWakeup?: boolean): AgentHistorySummary[] {
    return this.store.listAgentHistorySummaries(excludeWakeup)
  }

  /** 按日期范围取完整会话记录（读各日 JSON）。 */
  byDateRange(startDate?: string, endDate?: string): AgentRecord[] {
    return this.store.getAgentRecords(startDate, endDate)
  }

  /** 高级搜索（关键字 / 日期 / 可选 filter / titleOnly）。 */
  search(options: SearchAgentRecordsOptions): Promise<SearchAgentRecordsResult> {
    return this.store.searchAgentRecordsAdvanced(options)
  }
}
