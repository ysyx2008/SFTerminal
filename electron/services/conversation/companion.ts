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
import { generateSummary } from '../agent/task-memory'
import { Conversation } from './conversation'

/** companion 抽取新任务的选项 */
export interface CompanionExtractTaskOptions {
  /**
   * 锚点 task 索引（0-based，合并视图位置）。仅作 fallback；优先用 anchorTaskStepId。
   */
  anchorTaskIndex?: number
  /** user_task / proactive_notice step.id（与前端 AgentTaskGroup.id 一致），精确锚定用户点的那一段 */
  anchorTaskStepId?: string
  /** userTask 后缀（如「· 分支」） */
  titleSuffix?: string
  /**
   * 前端联络 tab 当前展示的 steps（与屏幕上 group 同源）。
   * 有则作为截取真相源，避免磁盘合并切段与 UI 分组不一致。
   */
  sourceSteps?: import('@shared/types').AgentStepRecord[]
}

export class Companion {
  /** 拉取最近多少条 record 做合并视图（联络 tab 展示 / fork）。10 与旧 forkAgent 实现一致。 */
  static readonly RECENT_RECORDS_LIMIT = 10
  /**
   * 心跳 / Watch prompt：最多取多少条「互动」做 L4 概要
   *（user_task↔final_result 一对，或单条 proactive_notice）。
   */
  static readonly WATCH_PROMPT_MAX_TURNS = 12
  /**
   * `# 联络摘要` 总字符预算；超出时从最旧整行丢弃（不对单条正文中段硬截断）。
   * L4 一行通常几十字符，此上限作兜底。
   */
  static readonly WATCH_PROMPT_MAX_TOTAL_CHARS = 2500
  /** 为凑够足够轮次，合并视图最多拉取多少条 companion record。 */
  static readonly WATCH_PROMPT_RECORDS_LIMIT = 50

  constructor(
    private readonly historyService: HistoryService,
    private readonly agentKey = '__companion__'
  ) {}

  /**
   * 从 companion 关系线抽取一段开新任务（companion → task 异质转化）。
   *
   * 与 task fork（`Conversation.forkFromRecord`）语义不同：时间窗口升格种子，非截止全量。
   *
   * @deprecated 生产路径请用 {@link extractTaskWithLiveOverlay}，以免漏掉内存中尚未落盘的 steps。
   */
  extractTask(newSessionId: string, opts?: CompanionExtractTaskOptions): { conversation: Conversation; record: AgentRecord } | null {
    return this.extractTaskWithLiveOverlay(newSessionId, undefined, opts)
  }

  /**
   * 用内存中的最新 companion 会话覆盖同 id 的磁盘记录（或追加），再抽取任务。
   *
   * 与 task 之间的 fork（`Conversation.forkFromRecord`）语义不同：
   * - fork：同质分叉，单条 record 截止到第 N 个 task
   * - extractTask：异质转化，N 条 record 合并后按时间窗口取最近连续段
   *
   * 避免「UI 已有、磁盘尚未含该 step」时锚点 stepId 找不到、截止点滑偏。
   * 排序由 `extractTaskFromRecords` 按 timestamp 负责。
   *
   * 返回 null：无近期 record / 锚点无法解析 / 合并后无 user_task。
   */
  extractTaskWithLiveOverlay(
    newSessionId: string,
    liveRecord: AgentRecord | null | undefined,
    opts?: CompanionExtractTaskOptions
  ): { conversation: Conversation; record: AgentRecord } | null {
    let records = this.historyService.getRecentRecordsByAgentKey(
      this.agentKey,
      Companion.RECENT_RECORDS_LIMIT
    )
    const hasSourceSteps = !!(opts?.sourceSteps && opts.sourceSteps.length > 0)
    if ((!records || records.length === 0) && !liveRecord && !hasSourceSteps) return null
    records = records ? [...records] : []
    if (liveRecord) {
      const idx = records.findIndex(r => r.id === liveRecord.id)
      if (idx >= 0) records[idx] = liveRecord
      else records.push(liveRecord)
    }
    // 允许仅有前端 sourceSteps（磁盘暂无记录）时仍能抽取
    if (records.length === 0 && !hasSourceSteps) return null
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
   * 为 Watch / 心跳 prompt 格式化最近联络（Markdown `# 联络摘要`，L4 一句话概要）。
   * - 粒度对齐 TaskMemory L4（`generateSummary`）：请求短摘 + 回复首句
   * - 不灌图片/多模态附件（只读 step/message 文本）；不灌 `message` 内心独白
   * - 总预算 {@link WATCH_PROMPT_MAX_TOTAL_CHARS}：超限丢最旧整行，不中段硬截断
   */
  formatRecentTurnsForWatchPrompt(maxTurns = Companion.WATCH_PROMPT_MAX_TURNS): string {
    const record = this.getMergedViewRecord(Companion.WATCH_PROMPT_RECORDS_LIMIT)
    if (!record) return ''

    // 优先 merged steps：含 __proactive__ 的 proactive_notice。
    // getMergedViewRecord 的 mergedMessages 刻意排除 __proactive__；
    // 无 steps 时回退 messages（仅 messages 的老记录）。
    const exchanges =
      record.steps && record.steps.length > 0
        ? Companion.exchangesFromSteps(record.steps)
        : Companion.exchangesFromMessages(record.messages ?? [])

    const recent = exchanges.slice(-maxTurns)
    if (recent.length === 0) return ''

    const lines: string[] = []
    for (const ex of recent) {
      const userReq = Companion.cleanWatchText(ex.user || '(主动消息)')
      const final = Companion.cleanWatchText(ex.assistant || '')
      if (!userReq && !final) continue
      const line = generateSummary(
        userReq || '(主动消息)',
        'success',
        final || undefined,
        undefined,
        ex.timestamp
      )
      if (line.trim()) lines.push(`- ${line}`)
    }
    if (lines.length === 0) return ''

    const kept = Companion.fitLinesToBudget(lines, Companion.WATCH_PROMPT_MAX_TOTAL_CHARS)
    return [
      '# 联络摘要',
      '',
      '（L4 一句话概要，避免重复通知、保持连贯；不含附件/图片）',
      '',
      ...kept,
    ].join('\n')
  }

  /** 超预算时从最旧整行丢弃，保留最近若干行。 */
  private static fitLinesToBudget(lines: string[], maxChars: number): string[] {
    if (maxChars <= 0 || lines.length === 0) return lines
    let total = lines.reduce((n, l) => n + l.length + 1, 0)
    let start = 0
    while (total > maxChars && start < lines.length - 1) {
      total -= lines[start].length + 1
      start++
    }
    return lines.slice(start)
  }

  /** 去掉思考 HTML、系统附图表述、包装标签；不做中段硬截断。 */
  private static cleanWatchText(content: string): string {
    return content
      .replace(/<details[\s\S]*?<\/details>/gi, '')
      .replace(/<details[^>]*>[\s\S]*/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\[系统：用户在本消息中附带了[^\]]*\]/g, '')
      .replace(/\[系统：用户附带了[^\]]*\]/g, '')
      .replace(/<\/?sf_[^>]+>/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  private static exchangesFromSteps(
    steps: NonNullable<AgentRecord['steps']>
  ): Array<{ user?: string; assistant?: string; timestamp?: number }> {
    const out: Array<{ user?: string; assistant?: string; timestamp?: number }> = []
    let pending: { user?: string; assistant?: string; timestamp?: number } | null = null

    const flushPending = () => {
      if (pending) {
        out.push(pending)
        pending = null
      }
    }

    for (const s of steps) {
      if (s.type === 'user_task' && s.content && s.content !== '__proactive__') {
        flushPending()
        pending = { user: s.content, timestamp: s.timestamp }
      } else if (s.type === 'proactive_notice' && s.content) {
        flushPending()
        out.push({ assistant: s.content, timestamp: s.timestamp })
      } else if (s.type === 'final_result' && s.content) {
        // 不灌 message（内心独白）；只配对 final_result
        if (pending) {
          pending.assistant = s.content
          flushPending()
        } else {
          out.push({ assistant: s.content, timestamp: s.timestamp })
        }
      }
    }
    flushPending()
    return out
  }

  private static exchangesFromMessages(
    messages: NonNullable<AgentRecord['messages']>
  ): Array<{ user?: string; assistant?: string; timestamp?: number }> {
    const out: Array<{ user?: string; assistant?: string; timestamp?: number }> = []
    let pending: { user?: string; assistant?: string; timestamp?: number } | null = null

    for (const m of messages) {
      const isPlainUser = m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 0
      const isPlainAssistant = m.role === 'assistant'
        && typeof m.content === 'string' && m.content.trim().length > 0
        && !(Array.isArray(m.tool_calls) && m.tool_calls.length > 0)

      if (isPlainUser) {
        if (pending) out.push(pending)
        // 不读 m.images —— 多模态附件不进心跳文本
        pending = { user: m.content as string }
      } else if (isPlainAssistant) {
        if (pending) {
          pending.assistant = m.content as string
          out.push(pending)
          pending = null
        } else {
          out.push({ assistant: m.content as string })
        }
      }
    }
    if (pending) out.push(pending)
    return out
  }
}
