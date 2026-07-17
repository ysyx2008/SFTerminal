/**
 * 上下文组成字数测量（纯函数）
 *
 * 口径：发出请求时各块的字符长度，不做 token 估算。
 * System 二级依赖 PromptBuilder 写入的 `<!--sf-ctx:id-->` 标记（发 API 前 strip）。
 */
import type { ContextCompositionId, ContextCompositionNode } from '@shared/types'
import type { AiMessage, ToolDefinition } from '../ai.service'

/** System 二级叶子（与 PromptBuilder section 映射一致） */
export type SystemCompositionLeafId =
  | 'identity'
  | 'rules'
  | 'skills'
  | 'knowledge'
  | 'environment'

const MARKER_PATTERN = '<!--sf-ctx:(identity|rules|skills|knowledge|environment)-->'

/** 在 section 正文前插入归因标记（计入 messages 存储，发 API 前 strip） */
export function wrapCompositionSection(id: SystemCompositionLeafId, content: string): string {
  if (!content) return ''
  return `<!--sf-ctx:${id}-->\n${content}`
}

/** 去掉归因标记（formatMessageForApi / 测量前对齐「真正发出」的文本） */
export function stripCompositionMarkers(text: string): string {
  if (!text) return text
  return text.replace(/<!--sf-ctx:(?:identity|rules|skills|knowledge|environment)-->\n?/g, '')
}

/**
 * 从带标记的 system 文本解析二级字数。
 * 无标记时返回 null（调用方只建一级 system 节点）。
 */
export function parseSystemSectionChars(
  markedSystem: string
): Record<SystemCompositionLeafId, number> | null {
  if (!markedSystem || !markedSystem.includes('<!--sf-ctx:')) {
    return null
  }

  const chars: Record<SystemCompositionLeafId, number> = {
    identity: 0,
    rules: 0,
    skills: 0,
    knowledge: 0,
    environment: 0,
  }

  const splitRe = new RegExp(`(${MARKER_PATTERN}\\n?)`)
  const parts = markedSystem.split(splitRe)
  let current: SystemCompositionLeafId | null = null
  for (const part of parts) {
    const m = part.match(/^<!--sf-ctx:(identity|rules|skills|knowledge|environment)-->\n?$/)
    if (m) {
      current = m[1] as SystemCompositionLeafId
      continue
    }
    if (current && part) {
      chars[current] += part.length
    }
  }

  return chars
}

function messageTextChars(msg: AiMessage): number {
  let n = (msg.content || '').length
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      n += (tc.function?.name || '').length
      n += (tc.function?.arguments || '').length
    }
  }
  // reasoning_content 会随 assistant 发出
  if (msg.role === 'assistant' && msg.reasoning_content) {
    n += msg.reasoning_content.length
  }
  return n
}

function imageChars(msg: AiMessage): number {
  if (!msg.images?.length) return 0
  return msg.images.reduce((sum, img) => sum + (img?.length || 0), 0)
}

function toolDefChars(tool: ToolDefinition): number {
  return JSON.stringify(tool).length
}

function leaf(
  id: ContextCompositionId,
  chars: number
): ContextCompositionNode | null {
  if (chars <= 0) return null
  return { id, chars }
}

function branch(
  id: ContextCompositionId,
  children: Array<ContextCompositionNode | null>
): ContextCompositionNode | null {
  const present = children.filter((c): c is ContextCompositionNode => c != null && c.chars > 0)
  if (present.length === 0) return null
  const chars = present.reduce((s, c) => s + c.chars, 0)
  return { id, chars, children: present }
}

/**
 * 测量发出请求时的字数组成树。
 * messages 中的 system 若含标记则拆二级；tools 按 mcp_ 前缀二分。
 */
export function measureContextComposition(
  messages: AiMessage[],
  tools: ToolDefinition[]
): ContextCompositionNode {
  // —— system ——
  const systemMsgs = messages.filter(m => m.role === 'system')
  const markedSystem = systemMsgs.map(m => m.content || '').join('\n\n')
  const sectionChars = parseSystemSectionChars(markedSystem)

  let systemNode: ContextCompositionNode | null
  if (sectionChars) {
    systemNode = branch('system', [
      leaf('identity', sectionChars.identity),
      leaf('rules', sectionChars.rules),
      leaf('skills', sectionChars.skills),
      leaf('knowledge', sectionChars.knowledge),
      leaf('environment', sectionChars.environment),
    ])
    // 标记外残留（极少）并入 identity，保证与 strip 后总长接近
    const accounted = systemNode?.chars ?? 0
    const strippedLen = stripCompositionMarkers(markedSystem).length
    if (systemNode && strippedLen > accounted) {
      const gap = strippedLen - accounted
      const identity = systemNode.children?.find(c => c.id === 'identity')
      if (identity) {
        identity.chars += gap
        systemNode.chars += gap
      } else {
        systemNode.children = [
          ...(systemNode.children || []),
          { id: 'identity', chars: gap },
        ]
        systemNode.chars += gap
      }
    }
  } else {
    const systemChars = systemMsgs.reduce(
      (s, m) => s + stripCompositionMarkers(m.content || '').length,
      0
    )
    systemNode = leaf('system', systemChars)
  }

  // —— tools ——
  let builtinChars = 0
  let mcpChars = 0
  for (const tool of tools) {
    const n = toolDefChars(tool)
    if ((tool.function?.name || '').startsWith('mcp_')) {
      mcpChars += n
    } else {
      builtinChars += n
    }
  }
  const toolsNode = branch('tools', [
    leaf('builtin', builtinChars),
    leaf('mcp', mcpChars),
  ])

  // —— messages（非 system）——
  const nonSystem = messages.filter(m => m.role !== 'system')
  let lastUserIdx = -1
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const m = nonSystem[i]
    if (m.role === 'user' && !m._systemInjected) {
      lastUserIdx = i
      break
    }
  }

  let historyChars = 0
  let currentUserChars = 0
  let imagesChars = 0

  for (let i = 0; i < nonSystem.length; i++) {
    const m = nonSystem[i]
    imagesChars += imageChars(m)
    // 测量文本时用 strip（system 已排除；user 内容一般无标记）
    const text = messageTextChars({
      ...m,
      content: stripCompositionMarkers(m.content || ''),
    })
    if (i === lastUserIdx) {
      currentUserChars += text
    } else {
      historyChars += text
    }
  }

  const messagesNode = branch('messages', [
    leaf('history', historyChars),
    leaf('currentUser', currentUserChars),
    leaf('images', imagesChars),
  ])

  const children = [systemNode, toolsNode, messagesNode].filter(
    (c): c is ContextCompositionNode => c != null
  )
  const chars = children.reduce((s, c) => s + c.chars, 0)
  return { id: 'root', chars, children }
}
