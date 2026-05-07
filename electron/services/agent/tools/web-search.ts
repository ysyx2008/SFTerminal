/**
 * web_search 工具执行逻辑
 */

import type { ToolResult, ToolExecutorConfig } from './types'
import { search } from '../../web-search/index'
import { createLogger } from '../../../utils/logger'
import { t } from '../i18n'

const log = createLogger('Tool:WebSearch')

export async function executeWebSearch(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const query = args.query as string
  if (!query?.trim()) {
    return { success: false, output: '', error: 'Missing required parameter: query' }
  }

  const maxResults = Math.min(Math.max(Number(args.max_results) || 5, 1), 10)

  executor.addStep({
    type: 'tool_call',
    content: `${t('web.search')}: ${query}`,
    toolName: 'web_search',
    toolArgs: { query, max_results: maxResults },
    riskLevel: 'safe'
  })

  try {
    const results = await search(query, { maxResults })

    if (results.length === 0) {
      const output = t('web.no_results')
      executor.addStep({ type: 'tool_result', content: output, toolName: 'web_search' })
      return { success: true, output }
    }

    const lines: string[] = []
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      lines.push(`[${i + 1}] ${r.title}`)
      lines.push(`    URL: ${r.url}`)
      if (r.snippet) lines.push(`    ${r.snippet}`)
      if (r.content) {
        const truncated = r.content.length > 500 ? r.content.slice(0, 500) + '...' : r.content
        lines.push(`    Content: ${truncated}`)
      }
      lines.push('')
    }

    const output = lines.join('\n').trim()
    executor.addStep({
      type: 'tool_result',
      content: t('web.found_results', { count: results.length }),
      toolName: 'web_search',
      webSearchResults: results.map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        content: r.content
      }))
    })
    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('Web search failed:', error)
    executor.addStep({
      type: 'tool_result',
      content: `${t('web.search_failed')}: ${errorMsg}`,
      toolName: 'web_search'
    })
    return { success: false, output: '', error: errorMsg }
  }
}
