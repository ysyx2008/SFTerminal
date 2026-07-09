/**
 * 思考块解析工具
 *
 * 后端 ai.service.ts 把推理模型的 reasoning_content 包装成固定模板的 HTML 块：
 *   - 流式中：<details open>\n<summary>🤔 ...</summary>\n\n<blockquote>\n\n[reasoning so far]
 *   - 完成后：<details>\n<summary>🤔 ...</summary>\n\n<blockquote>\n\n[reasoning]\n\n</blockquote>\n</details>
 *
 * 前端把思考块从 message.content 里抽离出来交给 <ThinkingBlock> 单行呈现，
 * 列表 size 不再因 reasoning 文本变化抖动。
 */

const THINKING_CLOSED_RE = /<details(?:\s+[^>]*)?>\s*<summary>[\s\S]*?🤔[\s\S]*?<\/summary>\s*<blockquote>\s*([\s\S]*?)\s*<\/blockquote>\s*<\/details>/
const THINKING_OPEN_RE = /<details\s+open\b[^>]*>\s*<summary>[\s\S]*?🤔[\s\S]*?<\/summary>\s*<blockquote>\s*([\s\S]*)$/

export interface ParsedMessage {
  thinking: { reasoning: string; isDone: boolean } | null
  body: string
}

export function parseThinking(content: string): ParsedMessage {
  if (!content || !content.includes('🤔')) {
    return { thinking: null, body: content || '' }
  }
  const closedMatch = content.match(THINKING_CLOSED_RE)
  if (closedMatch && closedMatch.index !== undefined) {
    const before = content.slice(0, closedMatch.index)
    const after = content.slice(closedMatch.index + closedMatch[0].length)
    return {
      thinking: { reasoning: closedMatch[1], isDone: true },
      body: (before + after).trim()
    }
  }
  const openMatch = content.match(THINKING_OPEN_RE)
  if (openMatch && openMatch.index !== undefined) {
    const before = content.slice(0, openMatch.index)
    return {
      thinking: { reasoning: openMatch[1], isDone: false },
      body: before.trim()
    }
  }
  return { thinking: null, body: content }
}

/** DynamicScroller 预估 item 高度（px）。折叠态 thinking 不计 reasoning 长度，避免流式思考时估算↔实测震荡导致列表持续跳动。 */
export function estimateMessageStepVirtualSize(
  step: { type: string; content: string; isStreaming?: boolean },
  opts?: { thinkingExpanded?: boolean }
): number {
  if (step.type !== 'message') return 80
  const content = step.content || ''
  if (!content) return step.isStreaming ? 46 : 80

  const parsed = parseThinking(content)
  if (parsed.thinking) {
    const collapsedLine = 46
    const expandedExtra = opts?.thinkingExpanded
      ? Math.min(200, Math.max(60, Math.ceil(parsed.thinking.reasoning.length / 8)))
      : 0
    const bodySize = parsed.body ? Math.max(40, Math.ceil(parsed.body.length / 4)) : 0
    return Math.max(80, collapsedLine + expandedExtra + bodySize)
  }

  if (step.isStreaming) return 46

  return Math.max(80, Math.ceil(content.length / 4))
}
