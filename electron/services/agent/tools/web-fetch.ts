/**
 * Agent 的 web_fetch 工具：把一个 URL 拉成 LLM 可读的文本/markdown
 *
 * 与 web_search 区别：search 给候选列表，fetch 是"我已经知道想看哪一个"。
 * 实际使用经常组合：先 web_search 拿候选，再 web_fetch 看具体某条。
 */
import { t } from '../i18n'
import { webFetch } from '../../web-fetch.service'
import { formatFileSize } from './utils'
import type { ToolExecutorConfig, ToolResult } from './types'

export async function executeWebFetch(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const url = typeof args.url === 'string' ? args.url.trim() : ''
  if (!url) {
    return { success: false, output: '', error: t('web.fetch.url_required') }
  }

  const timeoutSec = typeof args.timeout === 'number' ? args.timeout : undefined
  const maxBytes = typeof args.max_bytes === 'number' ? args.max_bytes : undefined

  executor.addStep({
    type: 'tool_call',
    content: `${t('web.fetch.fetching')}: ${url}`,
    toolName: 'web_fetch',
    toolArgs: { url }
  })

  try {
    const result = await webFetch({ url, timeoutSec, maxBytes })

    const header = t('web.fetch.header', {
      url: result.finalUrl !== result.url ? `${result.url} → ${result.finalUrl}` : result.url,
      status: String(result.status),
      contentType: result.contentType || 'unknown',
      size: formatFileSize(result.bytes),
      backend: result.backend,
    })

    const body = result.content || `(${t('web.fetch.empty_body')})`
    const fullOutput = `${header}\n\n${body}`

    executor.addStep({
      type: 'tool_result',
      content: result.title
        ? `${t('web.fetch.done')}: ${result.title}`
        : `${t('web.fetch.done')}: ${result.finalUrl}`,
      toolName: 'web_fetch',
      toolResult: fullOutput,
    })

    return { success: true, output: fullOutput }
  } catch (e) {
    const message = (e as Error).message || String(e)
    executor.addStep({
      type: 'tool_result',
      content: `❌ ${t('web.fetch.failed')}: ${message}`,
      toolName: 'web_fetch',
      toolResult: message,
    })
    return { success: false, output: '', error: message }
  }
}
