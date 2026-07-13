/**
 * 任务侧栏短标题生成 —— 用户首条消息后异步调用 LLM，写入会话自身的 title。
 * 不阻塞 Agent run；已有 title（含用户手动重命名）不覆盖；失败静默回退到 userTask。
 */
import type { AiService } from '../ai.service'
import type { ConfigService } from '../config.service'
import type { HistoryService } from '../history.service'
import type { AgentService } from '../agent/index'
import { createLogger } from '../../utils/logger'

const log = createLogger('ConversationTitle')

/** 同时进行中的 session，避免重复请求 */
const inflight = new Set<string>()

const TITLE_MAX_LEN = 40

export interface GenerateConversationTitleDeps {
  aiService: AiService
  configService: ConfigService
  historyService: HistoryService
  agentService: AgentService
}

export interface GenerateConversationTitleInput {
  sessionId: string
  userMessage: string
  profileId?: string
}

/**
 * 清洗模型输出为侧栏可用短标题。纯函数，供单测。
 */
export function sanitizeConversationTitle(raw: string): string | null {
  let text = raw.trim()
  if (!text) return null

  text = text.split(/\r?\n/)[0]?.trim() ?? ''
  text = text.replace(/^["'「『【\[]+|["'」』】\]]+$/g, '').trim()
  text = text.replace(/\s+/g, ' ')
  if (!text) return null

  if (text.length > TITLE_MAX_LEN) {
    text = text.slice(0, TITLE_MAX_LEN).trim()
  }
  return text || null
}

function buildTitlePrompt(userMessage: string, language: string): string {
  const isEn = language.startsWith('en')
  const message = userMessage.length > 500 ? `${userMessage.slice(0, 500)}…` : userMessage

  if (isEn) {
    return [
      'Generate a short sidebar title for this chat (max 6 words).',
      'Reply with ONLY the title — no quotes, no punctuation wrapping, no explanation.',
      '',
      'User message:',
      message,
    ].join('\n')
  }

  return [
    '根据用户的第一条消息，生成侧栏会话短标题（不超过 20 个汉字或等价长度）。',
    '只输出标题本身，不要引号、不要标点包裹、不要解释。',
    '',
    '用户消息：',
    message,
  ].join('\n')
}

/**
 * 为任务会话异步生成短标题并写入会话（内存 + 落盘/pending）。
 * @returns 成功写入的标题；跳过或失败返回 null
 */
export async function generateConversationTitle(
  deps: GenerateConversationTitleDeps,
  input: GenerateConversationTitleInput
): Promise<string | null> {
  const sessionId = input.sessionId?.trim()
  const userMessage = input.userMessage?.trim()
  if (!sessionId || !userMessage) return null

  if (userMessage.startsWith('__') && userMessage.endsWith('__')) return null
  if (inflight.has(sessionId)) return null

  const existingTitle = deps.historyService.getAgentRecordById(sessionId)?.title?.trim()
  if (existingTitle) return null

  inflight.add(sessionId)
  try {
    const language = deps.configService.getLanguage() || 'zh-CN'
    const response = await deps.aiService.chat(
      [{ role: 'user', content: buildTitlePrompt(userMessage, language) }],
      input.profileId
    )
    const title = sanitizeConversationTitle(response)
    if (!title) {
      log.warn(`Empty title for ${sessionId}`)
      return null
    }

    // 生成期间用户可能已手动改名
    const afterTitle = deps.historyService.getAgentRecordById(sessionId)?.title?.trim()
    if (afterTitle) {
      log.info(`Skip auto-title for ${sessionId}: title already set`)
      return null
    }

    deps.agentService.setConversationTitleBySessionId(sessionId, title)
    log.info(`Auto-titled ${sessionId}: "${title}"`)
    return title
  } catch (err) {
    log.warn(`Auto-title failed for ${sessionId}:`, err)
    return null
  } finally {
    inflight.delete(sessionId)
  }
}

/** 测试用：清空 in-flight 集合 */
export function resetTitleGeneratorInflightForTest(): void {
  inflight.clear()
}
