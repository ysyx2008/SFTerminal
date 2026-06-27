/**
 * ConversationStore —— 会话存储接缝（薄封装命名类）
 *
 * 职责：给 ConversationManager 一个**名字达意、面向会话**的存储边界，把「会话怎么落盘/读盘/
 * 维护索引/区分 main/watch 树」这件事收口到一处。
 *
 * 设计要点（见 docs/conversation-refactor-design.md §4.3）：
 * - **不重新实现 IO**：底层真相源仍是 `HistoryService`（它组合 `agent-storage.ts` 纯函数 +
 *   索引缓存 + `storeForRecord` 的 main/watch 路由）。本类只是把它的会话相关方法包成干净接缝。
 * - **复用 `@shared/types` 的 `AgentRecord`**：不造平行的 `ConversationRecord`/扁平 messages 模型
 *   （红线③：禁止平行类型）。
 * - **main/watch 路由自动完成**：`HistoryService.storeForRecord` 按 `agentKey === '__watch__'`
 *   把 watch 内心独白隔离到独立历史树，调用方无需关心。
 *
 * 这就是「将来要换索引实现 / 换盘格式只动这一处」的接缝。Manager 只跟它打交道，不直接伸手进
 * HistoryService 这个「什么都管」的大类。
 */
import type { AgentRecord, AgentHistorySummary } from '@shared/types'
import type { HistoryService } from '../history.service'

export class ConversationStore {
  constructor(private readonly history: HistoryService) {}

  /**
   * 落盘一条会话记录（写正文 + 更新索引；按 agentKey 自动路由 main/watch 树）。
   * 会话粒度：同一 `record.id`（sessionId）重复 save 即覆盖更新同一条，不新增。
   */
  save(record: AgentRecord): void {
    this.history.saveAgentRecord(record)
  }

  /** 按 id（sessionId）精确读取一条会话；不存在返回 undefined。 */
  load(id: string): AgentRecord | undefined {
    return this.history.getAgentRecordById(id)
  }

  /** 删除一条会话（正文 + 索引条目）。返回是否实际删除。 */
  delete(id: string): boolean {
    return this.history.deleteAgentRecord(id)
  }

  /**
   * 取某个 agentKey 最近的一条会话（按最后活跃时间）。
   * 用于联络/关切等常驻命名 Agent 重启后回种 sessionId。
   */
  latestByAgentKey(agentKey: string): AgentRecord | undefined {
    return this.history.getLatestRecordByAgentKey(agentKey)
  }

  /**
   * 取某个 agentKey 最近 N 条会话（倒序）。
   * 用于联络常驻 tab 重启后合并展示 / 跨会话回种工作记忆。
   */
  recentByAgentKey(agentKey: string, limit = 10): AgentRecord[] {
    return this.history.getRecentRecordsByAgentKey(agentKey, limit)
  }

  /**
   * 取主历史树最近 N 条会话（任务/联络，不含 watch 内心独白）。
   * filter 在索引层先过滤，避免无谓读盘。
   */
  recent(limit = 5, filter?: (r: AgentRecord) => boolean): AgentRecord[] {
    return this.history.getRecentAgentRecords(limit, filter)
  }

  /**
   * 取 watch（关切）独立历史树最近 N 条执行记录。
   * 与主历史物理隔离，仅供关切执行审计，不进任务/联络列表。
   */
  recentWatch(limit = 20, filter?: (r: AgentRecord) => boolean): AgentRecord[] {
    return this.history.getRecentWatchRecords(limit, filter)
  }

  /**
   * 列出全部会话的轻量摘要（来自索引，不读各日 JSON）。
   * `excludeWakeup=true` 时剔除 watch 内心独白与联络会话——即「任务」侧栏口径。
   */
  listSummaries(excludeWakeup?: boolean): AgentHistorySummary[] {
    return this.history.listAgentHistorySummaries(excludeWakeup)
  }
}
