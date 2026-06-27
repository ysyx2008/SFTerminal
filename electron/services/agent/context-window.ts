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
}

/** 压缩结果(供 compress_context 工具回报给 AI)。 */
export interface CompressResult {
  beforeTokens: number
  afterTokens: number
  freedTokens: number
  archiveId: string
}

export class ContextWindowManager {
  /** 上下文管理功能激活阈值(用量百分比)。与 85% 警告消息对齐。 */
  static readonly THRESHOLD = 85

  private _enabled = false

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

  /** 估算消息列表的总 token 数量(含 tool_calls / reasoning_content + 4000 基线)。 */
  estimateTotalTokens(messages: AiMessage[]): number {
    const MESSAGE_OVERHEAD = 4

    const messageTokens = messages.reduce((sum, msg) => {
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
      return sum + tokens
    }, 0)

    return messageTokens + 4000
  }

  /**
   * 更新上下文压力状态:注入用量到 UI + 渐进式提醒。
   *
   * 设计原则:程序只提供信息,所有压缩决策由 AI 做。
   * - < 85%: 不干预(最大化前缀缓存命中)
   * - >= 85%: 激活上下文管理工具 + 注入警告消息到 messages 末尾
   * - API 自然报错: 最终兜底
   */
  updatePressure(run: AgentRun): void {
    const contextLength = this.getContextLength()
    // 优先用 API 返回的精确值,无精确值时用估算值(仅用于内部上下文管理决策)
    const hasRealData = this.deps.getLastPromptTokens() !== undefined
    const totalTokens = hasRealData ? this.deps.getLastPromptTokens()! : this.estimateTotalTokens(run.messages)
    const usagePercent = Math.round((totalTokens / contextLength) * 100)
    const remaining = Math.max(0, contextLength - totalTokens)

    // 仅当有 API 返回的精确数据时才推送到前端,避免不准确的估算值误导用户
    if (hasRealData) {
      this.deps.reportUsage(totalTokens, this.deps.getLastCacheHitRate())
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
   * 压缩当前任务的对话上下文:将早期的 assistant + tool 消息归档,替换为 AI 提供的摘要。
   * 一组 = assistant 消息 + 对应的 tool result;从后往前保留 keepRecent 组。
   */
  compress(run: AgentRun, summary: string, keepRecent: number): CompressResult | null {
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

    // 需要压缩的消息
    const toCompress = taskMessages.slice(0, keepFromIndex)
    if (toCompress.length === 0) return null

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
    const preserved = taskMessages.slice(keepFromIndex)
    run.messages = [...run.messages.slice(0, lastUserIndex + 1), summaryMessage, ...preserved]

    const afterTokens = this.estimateTotalTokens(run.messages)

    return {
      beforeTokens,
      afterTokens,
      freedTokens: beforeTokens - afterTokens,
      archiveId
    }
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
