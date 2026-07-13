/**
 * tool_call 步骤 content 的可点击片段拆分。
 *
 * content（如「阅读网页: https://…」「执行命令: ls # comment」「读取文件: ~/a.txt」）
 * 故意不走 markdown，以免 # / --- / * 被误解析。但纯文本又损失 URL / 本地路径的可点击性。
 *
 * 策略：
 * - url：按 toolArgs.url（仅 http(s)）在 content 中定位
 * - path：按 toolArgs.path（若在 content 中出现，含 `Application\ Support` 转义形式）+
 *         其余位置的裸路径扫描（matchBareFilePaths）
 * 按字段语义（url / path）而非工具名，不违反 agent-oop-boundary。
 */
import {
  createBareFilePathPattern,
  finalizeBarePathMatch,
  isLocalFilePath,
  normalizeUncForOpen,
} from './local-file-path'

export interface ToolCallLinkParts {
  /** URL 之前的文本（可能为空串） */
  before: string
  /** 完整 URL（已校验为 http(s)） */
  url: string
  /** URL 之后的文本（可能为空串） */
  after: string
}

export type ToolCallContentSegment =
  | { kind: 'text'; text: string }
  | { kind: 'url'; url: string }
  | { kind: 'path'; path: string; display: string }

interface Hit {
  start: number
  end: number
  kind: 'url' | 'path'
  /** 打开用的真实路径 / URL */
  value: string
  /** 原文展示 */
  display: string
}

/** Unix shell 路径里的 `\<char>` 转义 → 真实字符；Windows/UNC 原样保留 */
function unescapeUnixShellPath(path: string): string {
  if (
    path.startsWith('\\\\') ||
    /^\\[^\\\/]/.test(path) ||
    /^[A-Za-z]:[\\/]/.test(path)
  ) {
    return path
  }
  return path.replace(/\\([ \t!"#$&'()*,;<=>?@[\]^`{|}])/g, '$1')
}

/**
 * 将 tool_call content 拆成 text / url / path 片段，供 UI 分段渲染。
 * 无任何可点击片段时返回单段 text（调用方仍可整段插值）。
 */
export function splitToolCallContent(
  content: string,
  toolArgs?: Record<string, unknown>
): ToolCallContentSegment[] {
  if (!content) return [{ kind: 'text', text: '' }]

  const hits: Hit[] = []

  const rawUrl = toolArgs?.url
  if (typeof rawUrl === 'string' && rawUrl && /^https?:\/\//i.test(rawUrl)) {
    const idx = content.indexOf(rawUrl)
    if (idx >= 0) {
      hits.push({
        start: idx,
        end: idx + rawUrl.length,
        kind: 'url',
        value: rawUrl,
        display: rawUrl,
      })
    }
  }

  const rawPath = toolArgs?.path
  if (typeof rawPath === 'string' && rawPath && isLocalFilePath(rawPath)) {
    const candidates = [rawPath]
    if (rawPath.includes(' ')) {
      candidates.push(rawPath.replace(/ /g, '\\ '))
    }
    for (const c of candidates) {
      const idx = content.indexOf(c)
      if (idx >= 0) {
        hits.push({
          start: idx,
          end: idx + c.length,
          kind: 'path',
          value: normalizeUncForOpen(rawPath),
          display: c,
        })
        break
      }
    }
  }

  const pattern = createBareFilePathPattern()
  let m: RegExpExecArray | null
  while ((m = pattern.exec(content)) !== null) {
    const path = finalizeBarePathMatch(m[0], content, m.index)
    if (!path) continue
    const start = m.index
    const end = start + path.length
    hits.push({
      start,
      end,
      kind: 'path',
      value: normalizeUncForOpen(unescapeUnixShellPath(path)),
      display: path,
    })
    pattern.lastIndex = end
  }

  hits.sort((a, b) => a.start - b.start || b.end - a.end)

  const accepted: Hit[] = []
  let cursor = 0
  for (const h of hits) {
    if (h.start < cursor) continue
    accepted.push(h)
    cursor = h.end
  }

  if (accepted.length === 0) {
    return [{ kind: 'text', text: content }]
  }

  const segments: ToolCallContentSegment[] = []
  let pos = 0
  for (const h of accepted) {
    if (h.start > pos) {
      segments.push({ kind: 'text', text: content.slice(pos, h.start) })
    }
    if (h.kind === 'url') {
      segments.push({ kind: 'url', url: h.value })
    } else {
      segments.push({ kind: 'path', path: h.value, display: h.display })
    }
    pos = h.end
  }
  if (pos < content.length) {
    segments.push({ kind: 'text', text: content.slice(pos) })
  }
  return segments
}

/**
 * 兼容旧 API：仅在 content 含 toolArgs.url 时返回三段拆分，否则 null。
 */
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
