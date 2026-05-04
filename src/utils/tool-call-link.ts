/**
 * tool_call 步骤 content 中"按 toolArgs.url 提取可点击 URL 段"的策略函数。
 *
 * 设计动机：tool_call 的 content（如「阅读网页: https://example.com/x」、
 * 「执行命令: ls # comment」）故意不走 markdown，因为命令里 # / --- / *
 * 会被误解析为标题/分隔线/列表。但纯文本又损失了 URL 的可点击性。
 *
 * 这里按"通用语义字段名 url"识别——任何工具的 args 含 http(s) url 字段都享受
 * 到自动转链接，不违反 agent-oop-boundary 规则（'url' 是字段语义而非工具名硬编码）。
 *
 * 仅放行 http(s)，挡住 javascript: / data: 等危险 scheme。返回 null 表示
 * content 不含 url、url 不是字符串/不是 http(s)，调用方走纯文本兜底即可。
 */
export interface ToolCallLinkParts {
  /** URL 之前的文本（可能为空串） */
  before: string
  /** 完整 URL（已校验为 http(s)） */
  url: string
  /** URL 之后的文本（可能为空串） */
  after: string
}

export function splitContentByUrl(
  content: string,
  toolArgs: Record<string, unknown> | undefined
): ToolCallLinkParts | null {
  const raw = toolArgs?.url
  if (typeof raw !== 'string' || !raw) return null
  if (!/^https?:\/\//i.test(raw)) return null
  const idx = content.indexOf(raw)
  if (idx < 0) return null
  return {
    before: content.slice(0, idx),
    url: raw,
    after: content.slice(idx + raw.length),
  }
}
