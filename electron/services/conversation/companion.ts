/**
 * Companion —— 「联络」关系线领域对象（agentKey = `__companion__`）
 *
 * 收口 companion 关系线的「数据组织」语义：多 record 合并视图、抽取开新任务。
 * 主动消息暂存（`proactive-store`）/ 冷启动工作记忆重建（`Agent.restoreRecentTaskMemory`）
 * 仍散在原处，留待后续独立工程搬迁——本类已为它们预留接缝。
 *
 * 为什么是独立领域对象、不是 `SailFishAgent` 的子类：
 * - companion 的能力（多 record 视图、主动消息）大多**独有**而非**多态**——task 根本没有
 *   这些行为，不存在「task 这么做、companion 那么做」的分叉，子类化会踩 policy 表的回头路
 * - 「关系线」和「ReAct 执行」是正交能力：Companion 封装关系线语义，SailFish 负责实际对话
 *   执行（AgentService 持有 companion runner = 一个 agentKey='__companion__' 的 SailFish）
 * - 组合优于继承，符合 OOP 边界
 *
 * 边界（与 Conversation/Agent 的职责切分）：
 * - **不碰** transcript / taskMemory / cachePrefix——这些归 Conversation（会话聚合根）
 * - **不碰** ReAct 循环 / 工具执行——这些归 Agent
 * - 只做「关系线数据组织」：拉 N 条 record、合并视图、产出新 Conversation 供 AgentService 编排
 */
import type { AgentRecord } from '@shared/types'
import type { HistoryService } from '../history.service'
import { Conversation } from './conversation'

/** companion 抽取新任务的选项 */
export interface CompanionExtractTaskOptions {
  /**
   * 锚点 task 索引（0-based，合并视图位置）。仅作 fallback；优先用 anchorTaskStepId。
   */
  anchorTaskIndex?: number
  /** user_task step.id（与前端 AgentTaskGroup.id 一致），精确锚定用户点的那一段 */
  anchorTaskStepId?: string
  /** userTask 后缀（如「· 分支」） */
  titleSuffix?: string
}

export class Companion {
  /** 拉取最近多少条 record 做合并视图（联络 tab 展示 / fork）。10 与旧 forkAgent 实现一致。 */
  static readonly RECENT_RECORDS_LIMIT = 10
  /** 心跳 / Watch prompt 注入：最近多少条 user↔assistant 轮次。 */
  static readonly WATCH_PROMPT_MAX_TURNS = 50
  /** 为凑够足够轮次，合并视图最多拉取多少条 companion record（上限与 WATCH_PROMPT_MAX_TURNS 同量级）。 */
  static readonly WATCH_PROMPT_RECORDS_LIMIT = 50

  constructor(
    private readonly historyService: HistoryService,
    private readonly agentKey = '__companion__'
  ) {}

  /**
   * 从 companion 关系线抽取一段开新任务（companion → task 异质转化）。
   *
   * 与 task 之间的 fork（`Conversation.forkFromRecord`）语义不同：
   * - fork：同质分叉，单条 record 截止到第 N 个 task（连续工作流，带全量合理）
   * - extractTask：异质转化，N 条 record 合并后按时间窗口取最近连续段（升格种子，带最近这段即可）
   *
   * 返回的二元组（与 `Conversation.forkFromRecord` 一致）：
   * - `conversation`：新会话实例，transcript 已装载；kind = `'task'`（脱离关系线）
   * - `record`：截断后的 `AgentRecord`（含带后缀的 `userTask`），调用方用它落盘 + 恢复 UI
   *
   * 落盘 + 建 Agent 由 AgentService 编排（本方法只产数据，不副作用）。
   * 返回 null：historyService 不可用 / 无近期 record / 合并后无 user_task。
   */
  extractTask(newSessionId: string, opts?: CompanionExtractTaskOptions): { conversation: Conversation; record: AgentRecord } | null {
    const records = this.historyService.getRecentRecordsByAgentKey(
      this.agentKey,
      Companion.RECENT_RECORDS_LIMIT
    )
    if (!records || records.length === 0) return null
    return Conversation.extractTaskFromRecords(records, newSessionId, opts)
  }

  /**
   * 取 companion 关系线的合并视图 record。
   *
   * companion 是「N 条物理 record 拼成的逻辑关系线」——重启后前端 tab 只看到一个空壳，
   * 需把最近 N 条 record 的 steps 按时间升序合并展示。本方法是这份合并视图的**唯一真相源**：
   * 前端 `restoreCompanionHistoryIfNeeded` 经 IPC 走到这里，不再在前端复制一份等价合并逻辑。
   *
   * 合并规则（行为已由 `companion-restore.integration.test.ts` 锁定，原前端 `mergeCompanionRecords` 已搬迁至此）：
   *  - steps：按 timestamp 升序拼接，`id` 重复的去重（保留首次出现）
   *  - messages：仅取非 `__proactive__` 记录的 messages 拼接（前端展示层不读 messages，
   *    但保留字段以兼容 `AgentRecord` 形状，供其它潜在消费方）
   *  - id / timestamp：**成对取最新一条**。续聊时 `restoreAgentHistory` 把它们写成
   *    `agentState.sessionId` / `sessionStartTime` 传给后端，checkpoint 据此存盘——
   *    若 id 取最新、timestamp 取最早（旧 bug），后端会存成错配记录，引发「裂成两条 session」。
   *  - userTask（标题）：取最早一条非 `__proactive__` 记录；全 proactive 时回退到最早一条
   *
   * 返回 null：historyService 不可用 / 无近期 record。
   * @param recordsLimit 拉取最近多少条物理 record 参与合并；默认 `RECENT_RECORDS_LIMIT`（联络 tab 展示）。
   */
  getMergedViewRecord(recordsLimit = Companion.RECENT_RECORDS_LIMIT): AgentRecord | null {
    const records = this.historyService.getRecentRecordsByAgentKey(
      this.agentKey,
      recordsLimit
    )
    if (!records || records.length === 0) return null

    const ordered = [...records].sort((a, b) => a.timestamp - b.timestamp)
    const seen = new Set<string>()
    const mergedSteps = ordered
      .flatMap(r => (r.steps ?? []))
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
      .filter(s => (s.id && !seen.has(s.id) ? (seen.add(s.id), true) : !s.id))
    const realRecords = ordered.filter(r => r.userTask !== '__proactive__')
    const mergedMessages = realRecords.flatMap(r => r.messages ?? [])

    const earliest = ordered[0]
    const latest = ordered[ordered.length - 1]
    const firstRealRecord = ordered.find(r => r.userTask !== '__proactive__')
    const displayUserTask = firstRealRecord?.userTask ?? earliest.userTask

    // id/timestamp 成对取「最新一条」——续聊时 checkpoint 据此存盘，避免「裂成两条 session」
    return {
      ...latest,
      id: latest.id,
      timestamp: latest.timestamp,
      userTask: displayUserTask,
      steps: mergedSteps,
      messages: mergedMessages
    }
  }

  /**
   * 为 Watch / 心跳 prompt 格式化最近联络轮次。
   * 合并最近最多 {@link WATCH_PROMPT_RECORDS_LIMIT} 条 companion record，取最近
   * {@link WATCH_PROMPT_MAX_TURNS} 轮 user↔assistant 纯文本，让唤醒决策感知联络线全貌。
   */
  formatRecentTurnsForWatchPrompt(maxTurns = Companion.WATCH_PROMPT_MAX_TURNS): string {
    const record = this.getMergedViewRecord(Companion.WATCH_PROMPT_RECORDS_LIMIT)
    if (!record) return ''

    // 优先 merged steps：含 __proactive__ record 的 proactive_notice。
    // getMergedViewRecord 的 mergedMessages 刻意排除 __proactive__（L104-105）；
    // 若存在 messages 就走 messages 分支，会丢掉近期 talk_to_user——唤醒重复通知的根因。
    // 无 steps 时回退 messages（仅 messages 的老记录）。
    const turns: Array<{ role: 'user' | 'assistant'; content: string }> =
      record.steps && record.steps.length > 0
        ? Companion.turnsFromSteps(record.steps)
        : Companion.turnsFromMessages(record.messages ?? [])

    const recent = turns.slice(-maxTurns)
    if (recent.length === 0) return ''
    const lines = recent.map(m => {
      const who = m.role === 'user' ? '用户' : '你'
      return `${who}：${m.content}`
    })
    return `[最近与用户的联络记录（避免重复通知、保持连贯）：\n${lines.join('\n')}]`
  }

  private static turnsFromSteps(
    steps: NonNullable<AgentRecord['steps']>
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const turns: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (const s of steps) {
      if (s.type === 'user_task' && s.content && s.content !== '__proactive__') {
        turns.push({ role: 'user', content: s.content })
      } else if (
        (s.type === 'final_result' || s.type === 'message' || s.type === 'proactive_notice')
        && s.content
      ) {
        turns.push({ role: 'assistant', content: s.content })
      }
    }
    return turns
  }

  private static turnsFromMessages(
    messages: NonNullable<AgentRecord['messages']>
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const turns: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (const m of messages) {
      const isPlainUser = m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 0
      const isPlainAssistant = m.role === 'assistant'
        && typeof m.content === 'string' && m.content.trim().length > 0
        && !(Array.isArray(m.tool_calls) && m.tool_calls.length > 0)
      if (isPlainUser) {
        turns.push({ role: 'user', content: m.content as string })
      } else if (isPlainAssistant) {
        turns.push({ role: 'assistant', content: m.content as string })
      }
    }
    return turns
  }
}
