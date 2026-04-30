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
