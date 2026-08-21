/**
 * ContextWindowManager —— 上下文窗口管理协作者
 *
 * 从 `Agent` 基类抽出的内聚簇:token 估算 / 用量压力 / 上下文压缩 / 工具调用序列修复。
 * 只操作传入的 `AgentRun`,不持有 Agent 反向引用;Agent 通过 `ContextWindowDeps`
 * 注入它需要的只读依赖(配置、profileId、conversation 的 token 读数、UI 上报回调)。
 *
 * 设计依据:docs/conversation-refactor-design.md「拆 Agent 巨类」试点。
 */
import type { AiProfile } from '@shared/types'
import type { AiMessage } from '../ai.service'
import type { AgentRun } from './types'
import { estimateTextTokens } from './token-estimate'
import { t } from './i18n'
import { createLogger } from '../../utils/logger'

const log = createLogger('ContextWindow')

/** Agent 注入的最小只读依赖面。 */
export interface ContextWindowDeps {
  /** AI 配置(取 profiles / active profile)。缺省时回退 128000。 */
  config?: {
    getAiProfiles(): AiProfile[]
    getActiveAiProfile(): string
  }
  /** 当前生效的 profileId(可为 undefined,走 active)。 */
  getProfileId: () => string | undefined
  /** 最近一次 LLM provider 返回的精确 prompt token 数(优先于估算)。 */
  getLastPromptTokens: () => number | undefined
  /** 最近一次的缓存命中率(可选,仅用于 UI 上报)。 */
  getLastCacheHitRate: () => number | undefined
  /** 把 token 用量推到当前 run 的 lastStep + onStep 回调(UI 展示)。 */
  reportUsage: (tokens: number, cacheHitRate?: number) => void
  /**
   * 作废真实用量锚点。压缩后 messages 结构已变,上一轮的 prompt_tokens 不再对应
   * 当前序列,继续拿它当锚点会把已经释放掉的部分算进来。作废后过渡一轮全量估算,
   * 下次 API 响应回来就有新锚点。
   */
  invalidateTokenAnchor?: () => void
  /**
   * 当前请求会带上的工具定义(冷启动全量估算用)。工具 schema 是每次请求都在的
   * 固定开销,实测占一两万 tokens,漏算会让估算严重偏低。
   */
  getTools?: () => Array<unknown>
  /**
   * 生成待归档消息的 AI 小结（proactive 路径专用：窗口将满、API 还可用时摘要质量最高）。
   * 返回 null 或抛错 → 回退固定模板。
   */
  summarizeMessages?: (messages: AiMessage[]) => Promise<string | null>
  /**
   * 主动压缩的最小可压缩范围（tokens），缺省用 MIN_PROACTIVE_RANGE_TOKENS。
   * 仅测试注入用——生产代码不要传。
   */
  minProactiveRangeTokens?: number
}

/** 压缩结果(供 compress_context 工具回报给 AI)。 */
export interface CompressResult {
  beforeTokens: number
  afterTokens: number
  freedTokens: number
  archiveId: string
  /** 本次压缩实际保留的最近对话轮数（紧急压缩可能从 2 降到 1） */
  keepRecent: number
}

export class ContextWindowManager {
  /** 上下文管理功能激活阈值(用量百分比)。与 85% 警告消息对齐。 */
  static readonly THRESHOLD = 85
  /** 主动压缩阈值(基于上一轮真实 prompt_tokens 的占比)。留 10% 余量：摘要调用本身要占一次请求。 */
  static readonly PROACTIVE_THRESHOLD = 0.90

  /**
   * 主动压缩的最小可压缩范围（tokens）。真实 E2E 发现：系统提示词占主导的会话里，
   * 可压缩消息可能只有几百 token，而 AI 小结 + 归档包装本身就近千 token——
   * 压缩反而净增（实测 freed=-148）。低于此下限跳过主动压缩，
   * 等对话积累更多内容后再压；紧急压缩（API 报错兜底）不受此限。
   */
  static readonly MIN_PROACTIVE_RANGE_TOKENS = 3000

  /**
   * 判断错误是否为上下文超限错误。
   *
   * 各 LLM provider 的错误码/消息不同，但 ai.service.ts 在解析到
   * context_length_exceeded（及火山豆包等稳定业务文案）时会统一翻译成
   * t('error.context_length_exceeded')，所以优先匹配翻译后的文案。
   *
   * 注意：这不是"基于关键词的模式分析"——它匹配的是固定的 API 错误码 /
   * provider 协议文案的翻译结果，是稳定的协议字段而非自然语言模式。
   */
  static isContextLimitError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error)
    if (!msg) return false
    // 翻译后的中英文案 + 原始错误码 + 未翻译时漏网的 provider 稳定文案
    return (
      msg.includes('context_length_exceeded') ||
      msg.includes('上下文超出模型限制') ||
      msg.includes('Context length exceeded') ||
      // 火山方舟豆包：code 常为空，message 为固定英文句（见 ai.service isContextLengthApiFailure）
      msg.includes('exceed max message tokens')
    )
  }

  private _enabled = false
  /** 本轮 run 是否已主动压缩过（同一 run 只主动压缩一次，避免连续压缩） */
  private _proactiveCompressedThisRun = false

  constructor(private deps: ContextWindowDeps) {}

  /** 上下文管理工具(compress_context 等)是否已激活。一旦激活不回退(压缩后用量可能降低)。 */
  get enabled(): boolean {
    return this._enabled
  }

  /**
   * 获取上下文长度(tokens)。profile 解析优先级:
   * profileId 命中 → active profile → 列表第一个 → 默认 128000。
   */
  getContextLength(): number {
    const config = this.deps.config
    if (!config) return 128000

    const profiles = config.getAiProfiles()
    if (profiles.length === 0) return 128000

    let profile: AiProfile | undefined
    const profileId = this.deps.getProfileId()
    if (profileId) {
      profile = profiles.find(p => p.id === profileId)
    }
    if (!profile) {
      const activeId = config.getActiveAiProfile()
      profile = profiles.find(p => p.id === activeId) || profiles[0]
    }

    return profile?.contextLength || 128000
  }

  /**
   * 估算文本的 token 数量(委托共享纯函数 estimateTextTokens)。
   * 保留实例方法形态,供 estimateTotalTokens 内部调用及单测直接验证。
   */
  estimateTokens(text: string | null | undefined): number {
    return estimateTextTokens(text)
  }

  /**
   * 全量估算一次请求的 prompt 规模:消息列表 + 工具 schema 固定开销。
   *
   * 仅用于够不着真实用量的场合(冷启动首轮、锚点刚被作废)。有锚点时一律走
   * estimateCurrentPromptTokens——全量估算的系统性偏差会随历史长度累积放大。
   */
  estimateTotalTokens(messages: AiMessage[]): number {
    return this.estimateMessagesTokens(messages) + this.estimateFixedOverheadTokens()
  }

  /**
   * 工具 schema 的固定开销。每次请求都随行,实测（28 个内置工具）约 9.5K tokens,
   * 装了技能/插件/MCP 后更大——按常数估会严重偏低。
   * 拿不到工具列表时退回经验值 4000（历史缺省）。
   */
  private estimateFixedOverheadTokens(): number {
    const tools = this.deps.getTools?.()
    if (!tools || tools.length === 0) return 4000
    return this.estimateTokens(JSON.stringify(tools))
  }

  /**
   * 当前请求的 prompt token 数:以上一轮 API 返回的真实 prompt_tokens 为锚点,
   * 只估算那之后新增的消息。
   *
   * 为什么不全量重估:估算公式的系统性偏差会乘以历史长度。锚点法把估算的作用
   * 范围压到「上一轮响应至今」的几条消息,同时让各家 provider 的分词差异被真实
   * 用量自动吸收,不必为每个模型分别调系数。（同 Codex Harness 的口径。）
   *
   * 锚点覆盖到上一轮请求发出去的全部内容;那之后新增的是「上一轮的 assistant
   * 回复 + 其后的 tool 结果 / 新 user 消息」,所以从最后一条 assistant 消息起算。
   */
  estimateCurrentPromptTokens(messages: AiMessage[]): number {
    const anchor = this.deps.getLastPromptTokens()
    if (anchor === undefined) return this.estimateTotalTokens(messages)

    let lastAssistantIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        lastAssistantIdx = i
        break
      }
    }
    // 没有 assistant 消息 = 还没发生过响应,锚点无从对应,退回全量估算
    if (lastAssistantIdx === -1) return this.estimateTotalTokens(messages)

    return anchor + this.estimateMessagesTokens(messages.slice(lastAssistantIdx))
  }

  /** 仅估算消息列表本身的 token（不含系统提示词等固定开销） */
  estimateMessagesTokens(messages: AiMessage[]): number {
    const MESSAGE_OVERHEAD = 4
    // 多模态图片 token 估算（保守上限）：OpenAI high detail 模式下 1024×1024=765、
    // 1920×1080=595、2048×4096=1105；Anthropic 面积公式约 1590 封顶。取 1500 作为
    // 单张图保守估值——宁可高估触发 cache path 跳过/cold start 重建，也不要低估导致
    // 真实 prompt 超过模型上下文窗口被 LLM 截断（图片发出去但 AI 收不到）。
    const IMAGE_TOKENS_PER_ITEM = 1500

    return messages.reduce((sum, msg) => {
      let tokens = this.estimateTokens(msg.content) + MESSAGE_OVERHEAD
      if (msg.tool_calls) {
        tokens += msg.tool_calls.reduce(
          (t, tc) => t + this.estimateTokens(tc.function.name) + this.estimateTokens(tc.function.arguments),
          0
        )
      }
      if (msg.reasoning_content) {
        tokens += this.estimateTokens(msg.reasoning_content)
      }
      // 多模态图片：base64 data URL 在 formatMessageForApi 中转为 image_url content part，
      // 由 LLM 按 tile/patch 算法计费。这里保守按固定值估算，避免 cache path 判断漏算图片
      // 导致 prevTokens 严重低估（companion 长会话累积历史带图消息时尤其影响）。
      if (msg.images && msg.images.length > 0) {
        tokens += msg.images.length * IMAGE_TOKENS_PER_ITEM
      }
      return sum + tokens
    }, 0)
  }

  /**
   * 更新上下文压力状态:注入用量到 UI + 渐进式提醒。
   *
   * 设计原则:程序只提供信息,所有压缩决策由 AI 做。
   * - < 85%: 不干预(最大化前缀缓存命中)
   * - >= 85%: 激活上下文管理工具 + 注入警告消息到 messages 末尾
   * - API 自然报错 context_length_exceeded: emergencyCompress 自动压缩兜底
   *   (见 executeLoop catch → ContextWindowManager.isContextLimitError → emergencyCompress)
   */
  updatePressure(run: AgentRun): void {
    const contextLength = this.getContextLength()
    const lastPromptTokens = this.deps.getLastPromptTokens()
    const hasRealData = lastPromptTokens !== undefined
    // 压力判断用「真实锚点 + 本轮新增」：ReAct 循环里 tool 结果持续累积,
    // 只看上一轮的锚点会低估,等下一次 API 响应才发现已经撑满。
    const totalTokens = this.estimateCurrentPromptTokens(run.messages)
    const usagePercent = Math.round((totalTokens / contextLength) * 100)
    const remaining = Math.max(0, contextLength - totalTokens)

    // 推给 UI 的仍是 API 确认过的原值:界面上的数字必须能对得上账单,
    // 不掺估算（SPEC: 本轮 usage 以 API 为唯一真相源）。
    if (hasRealData) {
      this.deps.reportUsage(lastPromptTokens, this.deps.getLastCacheHitRate())
    }

    // 超过阈值时激活上下文管理功能(一旦激活不会关闭,因为压缩后用量可能降低)
    if (!this._enabled && usagePercent >= ContextWindowManager.THRESHOLD) {
      this._enabled = true
    }

    // [缓存优化] 「上下文状态注入系统提示词」已禁用:每轮用量数字都变,注入系统提示
    // 会破坏 DeepSeek/OpenAI/Anthropic 前缀缓存。上下文压力由下方 85% 警告消息兜底。

    // 85%+ 额外注入警告消息(避免重复注入)
    if (usagePercent >= 85) {
      const lastMsg = run.messages[run.messages.length - 1]
      const isAlreadyWarned =
        lastMsg?.role === 'user' &&
        typeof lastMsg.content === 'string' &&
        lastMsg.content.includes('[系统] 上下文用量告警')

      if (!isAlreadyWarned) {
        run.messages.push({
          role: 'user',
          content: t('agent.context_pressure_warning', {
            percentage: usagePercent,
            remaining: remaining.toLocaleString()
          }),
          _systemInjected: true
        })
      }
    }
  }

  /**
   * 计算可压缩范围：当前任务（最后一条非告警 user 消息之后）中，除最近 keepRecent 组
   * assistant 轮次之外的早期消息。proactive 的摘要装配与 compress 共用此计算，
   * 保证「摘要覆盖的消息」与「实际归档的消息」一致。
   */
  private findCompressibleRange(run: AgentRun, keepRecent: number): { lastUserIndex: number; toCompress: AiMessage[] } | null {
    // 找到当前任务的消息范围(最后一条 user 消息之后的部分)
    let lastUserIndex = -1
    for (let i = run.messages.length - 1; i >= 0; i--) {
      if (run.messages[i].role === 'user') {
        // 跳过系统注入的警告消息
        if (
          typeof run.messages[i].content === 'string' &&
          run.messages[i].content.includes('[系统] 上下文用量告警')
        ) {
          continue
        }
        lastUserIndex = i
        break
      }
    }

    if (lastUserIndex === -1) return null

    // 当前任务的消息(user 消息之后到末尾)
    const taskMessages = run.messages.slice(lastUserIndex + 1)

    // 从后往前数 keepRecent 组(每组以 assistant 起头)
    let keepFromIndex = taskMessages.length
    let groupCount = 0
    for (let i = taskMessages.length - 1; i >= 0; i--) {
      if (taskMessages[i].role === 'assistant') {
        groupCount++
        if (groupCount >= keepRecent) {
          keepFromIndex = i
          break
        }
      }
    }

    const toCompress = taskMessages.slice(0, keepFromIndex)
    if (toCompress.length === 0) return null
    return { lastUserIndex, toCompress }
  }

  /**
   * 压缩当前任务的对话上下文:将早期的 assistant + tool 消息归档,替换为 AI 提供的摘要。
   * 一组 = assistant 消息 + 对应的 tool result;从后往前保留 keepRecent 组。
   */
  compress(run: AgentRun, summary: string, keepRecent: number): CompressResult | null {
    return this.doCompress(run, summary, keepRecent, this.findCompressibleRange(run, keepRecent))
  }

  /** 压缩实现主体：range 为 null 表示当前结构不可压缩 */
  private doCompress(
    run: AgentRun,
    summary: string,
    keepRecent: number,
    range: { lastUserIndex: number; toCompress: AiMessage[] } | null
  ): CompressResult | null {
    if (!range) return null
    const { lastUserIndex, toCompress } = range

    const beforeTokens = this.estimateTotalTokens(run.messages)

    // 生成归档 ID
    if (!run.compressedArchives) {
      run.compressedArchives = []
    }
    const archiveId = `ca-${run.compressedArchives.length + 1}`

    // 归档原始消息(深拷贝,防止后续 run.messages 修改影响归档)
    run.compressedArchives.push({
      id: archiveId,
      messages: JSON.parse(JSON.stringify(toCompress)),
      summary,
      timestamp: Date.now()
    })

    // 替换:用一条摘要消息替换被压缩的消息
    const summaryMessage: AiMessage = {
      role: 'assistant',
      content: `[早期对话已压缩，归档 ID: "${archiveId}"。如需查看原始内容，请调用 recall_compressed(archive_id: "${archiveId}")。]\n\n${summary}`
    }

    // 重建 messages: system + 历史任务消息 + user + 摘要 + 保留的最近消息
    const preserved = run.messages.slice(lastUserIndex + 1 + toCompress.length)
    run.messages = [...run.messages.slice(0, lastUserIndex + 1), summaryMessage, ...preserved]

    // 序列已变,上一轮的 prompt_tokens 不再对应当前 messages——继续拿它当锚点
    // 会把刚刚释放掉的部分又算回来,压缩看起来"没生效"。
    this.deps.invalidateTokenAnchor?.()

    const afterTokens = this.estimateTotalTokens(run.messages)

    return {
      beforeTokens,
      afterTokens,
      freedTokens: beforeTokens - afterTokens,
      archiveId,
      keepRecent
    }
  }

  /**
   * 紧急压缩：当 API 返回 context_length_exceeded 时作为最终兜底。
   *
   * 与常规 compress 的区别：
   * - 更激进：keepRecent=2（常规默认 4），尽量多释放空间
   * - 多次尝试：先 keepRecent=2，若释放不足再 keepRecent=1
   * - 不依赖 AI 调用 compress_context 工具（AI 可能忽略 85% 警告）
   *
   * @returns 压缩结果；若 messages 结构不允许压缩（如无 user 消息）返回 null
   */
  emergencyCompress(run: AgentRun): CompressResult | null {
    const result = this.compressAggressively(run, this.buildEmergencySummary())
    if (result) {
      log.info(`Emergency compress: freed ${result.freedTokens} tokens, kept recent ${result.keepRecent} rounds (archive ${result.archiveId})`)
    }
    return result
  }

  /**
   * 是否应该主动压缩（本地触发路径，不等 API 报错）。
   *
   * 触发条件：上一轮 API 返回的真实 prompt_tokens >= contextLength * PROACTIVE_THRESHOLD（0.90）。
   * 仅用真实值，无真实值（首次对话 / cold start）时不触发——让 emergencyCompress
   * 兜底，避免估算误差导致误压缩。
   *
   * 与 emergencyCompress 的分工：
   * - 本方法在 API 调用前主动压缩（基于上一轮真实值预测本轮会超限）
   * - emergencyCompress 在 API 调用失败后兜底（针对真报 context_length_exceeded 的 provider）
   * - DeepSeek 等不报错的 provider：本方法能在"超限但 API 默默截断"前主动压缩，保住上下文质量
   */
  shouldProactiveCompress(run: AgentRun): boolean {
    if (this._proactiveCompressedThisRun) return false  // 同一 run 只主动压缩一次，避免连续压缩
    const lastPromptTokens = this.deps.getLastPromptTokens()
    if (lastPromptTokens === undefined) return false  // 无真实值，不赌估算
    const contextLength = this.getContextLength()
    return lastPromptTokens >= contextLength * ContextWindowManager.PROACTIVE_THRESHOLD
  }

  /**
   * 主动压缩（本地触发）：先让 AI 为待归档消息写小结（窗口将满、API 还可用时
   * 摘要质量最高），小结直接替换被归档的早期对话；摘要调用失败/不可用才回退
   * 固定模板。压缩动作本身复用 emergencyCompress 的激进逻辑。
   *
   * 同一 run 只压一次（_proactiveCompressedThisRun 标记），防止绕过 shouldProactiveCompress
   * 直接调用导致重复压缩。
   *
   * @returns 压缩结果；若已压缩过或 messages 结构不允许压缩返回 null
   */
  async proactiveCompress(run: AgentRun): Promise<CompressResult | null> {
    if (this._proactiveCompressedThisRun) return null
    // 可压缩范围只算一次：摘要装配与实际归档必须用同一份消息切片，
    // 否则「摘要覆盖的内容」和「被归档的内容」可能不一致
    const range = this.findCompressibleRange(run, 2)
    if (!range) return null
    // 范围太小压缩是负收益（AI 小结 + 归档包装比原文还长），跳过；
    // 不标记 _proactiveCompressedThisRun，等后续轮次积累更多内容仍可触发
    const minRange = this.deps.minProactiveRangeTokens ?? ContextWindowManager.MIN_PROACTIVE_RANGE_TOKENS
    const rangeTokens = this.estimateMessagesTokens(range.toCompress)
    if (rangeTokens < minRange) {
      log.info(`Proactive compress skipped: compressible range too small (~${rangeTokens} tokens < ${minRange})`)
      return null
    }
    const summary = await this.buildProactiveSummary(range.toCompress)
    const result = this.compressAggressively(run, summary, range)
    if (result) {
      this._proactiveCompressedThisRun = true
      log.info(`Proactive compress: freed ${result.freedTokens} tokens, kept recent ${result.keepRecent} rounds (archive ${result.archiveId})`)
    }
    return result
  }

  /**
   * 主动压缩的摘要：优先让 AI 为待归档消息写小结（写给未来的自己），
   * 失败/不可用才回退固定模板。
   */
  private async buildProactiveSummary(toCompress: AiMessage[]): Promise<string> {
    const summarize = this.deps.summarizeMessages
    if (summarize) {
      try {
        const aiSummary = await summarize(toCompress)
        if (aiSummary && aiSummary.trim()) return aiSummary.trim()
      } catch (err) {
        log.warn(`AI 小结生成失败，回退固定模板: ${err}`)
      }
    }
    return this.buildProactiveTemplateSummary()
  }

  /**
   * 激进压缩的共享实现：先 keepRecent=2，若压缩后仍 >90% 再降到 keepRecent=1。
   * emergencyCompress（API 报错兜底）与 proactiveCompress（本地预测触发）共用此逻辑。
   * proactiveCompress 会传入预计算的 keepRecent=2 范围，避免与摘要装配各算一遍。
   */
  private compressAggressively(
    run: AgentRun,
    summary: string,
    precomputedRange?: { lastUserIndex: number; toCompress: AiMessage[] }
  ): CompressResult | null {
    let result = this.compressWithRange(run, summary, 2, precomputedRange)
    if (result) {
      const contextLength = this.getContextLength()
      const afterUsage = this.estimateTotalTokens(run.messages) / contextLength
      if (afterUsage > 0.9) {
        // 降级到 keepRecent=1 时归档范围比摘要装配时多一组最近轮次（该轮未进摘要但完整在归档里），补说明避免误读
        const result2 = this.compressWithRange(run, summary + '\n\n（注：归档后上下文仍紧张，归档范围扩大为仅保留最近 1 轮；多归档的那一轮未纳入本摘要，但完整内容仍在归档中，可用 recall_compressed 查看。）', 1)
        if (result2) {
          result = result2
        }
      }
      this._enabled = true
    }
    return result
  }

  /** compress 的内部实现：允许调用方传入预计算范围（仅当 keepRecent 与范围匹配时） */
  private compressWithRange(
    run: AgentRun,
    summary: string,
    keepRecent: number,
    range?: { lastUserIndex: number; toCompress: AiMessage[] }
  ): CompressResult | null {
    return this.doCompress(run, summary, keepRecent, range ?? this.findCompressibleRange(run, keepRecent))
  }

  /**
   * 构建紧急压缩的摘要文本。不依赖 AI 生成摘要（API 已不可用），
   * 用结构化占位让 AI 知道这段对话被压缩了、可以从归档找回。
   */
  private buildEmergencySummary(): string {
    return '【系统自动压缩】此前的对话因超出模型上下文限制已被紧急归档。' +
      '关键信息摘要请参考上方的 task_memory / 知识文档；如需原始对话细节，请调用 recall_compressed 工具按 archive_id 找回。'
  }

  /**
   * 构建主动压缩的固定模板摘要（AI 小结不可用时的兜底）。此时 API 尚未报错，
   * 是基于上一轮真实 token 用量预测本轮会超限而提前压缩。
   */
  private buildProactiveTemplateSummary(): string {
    return '【系统主动压缩】检测到上下文用量即将达到模型上限（基于上一轮真实 token 用量），' +
      '为避免本轮请求超限，已提前归档早期对话。关键信息摘要请参考上方的 task_memory / 知识文档；' +
      '如需原始对话细节，请调用 recall_compressed 工具按 archive_id 找回。'
  }

  /**
   * 修复不完整的工具调用序列:用户中断或运行抛错时,可能存在 assistant 消息(含 tool_calls)
   * 但缺少对应的 tool result。同时镜像写入 taskMessageLog,确保下次任务的 cache path / cold start
   * 看到的对话序列合法。
   *
   * @param placeholder 占位 tool result 的内容(默认按"用户中断"语义;错误路径应传入更具体的描述)
   */
  fixIncompleteToolCalls(run: AgentRun, placeholder: string = '[操作被用户中断]'): void {
    const { messages } = run
    if (messages.length === 0) return

    // 从后往前查找最后一个带有 tool_calls 的 assistant 消息
    let lastAssistantWithToolCallsIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        lastAssistantWithToolCallsIndex = i
        break
      }
      // 如果遇到 user 消息,说明之前的对话是完整的
      if (msg.role === 'user') break
    }

    if (lastAssistantWithToolCallsIndex === -1) return

    const assistantMsg = messages[lastAssistantWithToolCallsIndex]
    const toolCalls = assistantMsg.tool_calls!

    // 收集该 assistant 消息之后已有的 tool result
    const existingToolCallIds = new Set<string>()
    for (let i = lastAssistantWithToolCallsIndex + 1; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.role === 'tool' && msg.tool_call_id) {
        existingToolCallIds.add(msg.tool_call_id)
      }
    }

    // 为缺失的 tool_call_id 添加占位的 tool result
    const missingToolCalls = toolCalls.filter(tc => !existingToolCallIds.has(tc.id))
    if (missingToolCalls.length > 0) {
      log.info(`修复 ${missingToolCalls.length} 个缺失的 tool result 消息`)
      for (const tc of missingToolCalls) {
        const toolMsg: AiMessage = {
          role: 'tool',
          content: placeholder,
          tool_call_id: tc.id
        }
        messages.push(toolMsg)
        // 镜像写入 taskMessageLog:保持 append-only 的对话日志与 messages 同步,
        // 否则 TaskMemory 持久化的 messages 会缺失 tool result,下次任务复用时序列违法
        run.taskMessageLog.push({ ...toolMsg })
      }
    }
  }
}
