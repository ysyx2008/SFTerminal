/**
 * 为 MCP 服务器生成 whenToUse 短草稿（非 Agent 循环）
 * @see electron/services/MCP_SPEC.md
 */
import type { AiMessage } from './ai.service'
import { createLogger } from '../utils/logger'

const log = createLogger('McpWhenToUse')

export const MCP_WHEN_TO_USE_MAX_CHARS = 200

export interface McpToolHint {
  name: string
  title?: string
  description?: string
}

export interface SuggestWhenToUseInput {
  name: string
  tools: McpToolHint[]
}

export interface SuggestWhenToUseResult {
  success: boolean
  whenToUse?: string
  error?: string
}

type ChatFn = (messages: AiMessage[]) => Promise<string>

function buildPrompt(input: SuggestWhenToUseInput): string {
  const toolLines = input.tools.slice(0, 40).map(t => {
    const label = (t.title || t.name).trim()
    const desc = (t.description || '').trim().replace(/\s+/g, ' ').slice(0, 80)
    return desc ? `- ${label}: ${desc}` : `- ${label}`
  })
  return `你是产品文案助手。根据 MCP 连接器名称与工具列表，写一句「何时该用」说明，供 AI Agent 发现能力。

要求：
- 只输出这一句话本身，不要引号、标题或解释
- 中文，不超过 ${MCP_WHEN_TO_USE_MAX_CHARS} 字
- 写清适用场景；若明显可替代网页搜索，可点明勿用网页搜索代替
- 不要写逐步操作教程，不要罗列全部工具名

连接器名称：${input.name}
工具：
${toolLines.length > 0 ? toolLines.join('\n') : '（无工具元数据）'}`
}

export function normalizeWhenToUse(raw: string): string {
  return raw
    .trim()
    .replace(/^["「『]|["」』]$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, MCP_WHEN_TO_USE_MAX_CHARS)
}

/**
 * 用短 chat 生成 whenToUse；失败返回 error，不抛到调用方业务层以外。
 */
export async function suggestMcpWhenToUse(
  chat: ChatFn,
  input: SuggestWhenToUseInput
): Promise<SuggestWhenToUseResult> {
  const name = input.name?.trim()
  if (!name) {
    return { success: false, error: 'name is required' }
  }
  try {
    const text = await chat([
      { role: 'user', content: buildPrompt({ name, tools: input.tools || [] }) }
    ])
    const whenToUse = normalizeWhenToUse(text || '')
    if (!whenToUse) {
      return { success: false, error: 'empty suggestion' }
    }
    return { success: true, whenToUse }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.warn('suggestWhenToUse failed:', error)
    return { success: false, error }
  }
}
