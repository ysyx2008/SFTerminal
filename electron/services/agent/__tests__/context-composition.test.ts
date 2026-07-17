/**
 * context-composition 字数组成树测量单测
 */
import { describe, it, expect } from 'vitest'
import {
  wrapCompositionSection,
  stripCompositionMarkers,
  parseSystemSectionChars,
  measureContextComposition,
} from '../context-composition'
import type { AiMessage, ToolDefinition } from '../../ai.service'

function tool(name: string, desc = 'd'): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: desc,
      parameters: { type: 'object', properties: {} },
    },
  }
}

describe('context-composition markers', () => {
  it('wrap + strip round-trip', () => {
    const wrapped = wrapCompositionSection('identity', 'Hello')
    expect(wrapped).toContain('<!--sf-ctx:identity-->')
    expect(stripCompositionMarkers(wrapped)).toBe('Hello')
  })

  it('parseSystemSectionChars accumulates same id', () => {
    const text = [
      wrapCompositionSection('identity', 'AAA'),
      wrapCompositionSection('rules', 'BB'),
      wrapCompositionSection('identity', 'CC'),
    ].join('\n\n')
    const chars = parseSystemSectionChars(text)
    expect(chars).not.toBeNull()
    expect(chars!.identity).toBeGreaterThanOrEqual('AAA'.length + 'CC'.length)
    expect(chars!.rules).toBeGreaterThanOrEqual('BB'.length)
    expect(chars!.identity).toBeGreaterThan(chars!.rules)
  })

  it('parseSystemSectionChars returns null without markers', () => {
    expect(parseSystemSectionChars('plain system')).toBeNull()
  })
})

describe('measureContextComposition', () => {
  it('builds tree with system children when marked', () => {
    const system = [
      wrapCompositionSection('identity', 'ID'),
      wrapCompositionSection('skills', 'SKILL'),
    ].join('\n\n')
    const messages: AiMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: 'hi there' },
    ]
    const tools = [tool('read_file'), tool('mcp_foo_bar')]
    const tree = measureContextComposition(messages, tools)

    expect(tree.id).toBe('root')
    expect(tree.chars).toBeGreaterThan(0)

    const systemNode = tree.children!.find(c => c.id === 'system')!
    expect(systemNode.children?.some(c => c.id === 'identity')).toBe(true)
    expect(systemNode.children?.some(c => c.id === 'skills')).toBe(true)

    const toolsNode = tree.children!.find(c => c.id === 'tools')!
    expect(toolsNode.children?.find(c => c.id === 'builtin')?.chars).toBeGreaterThan(0)
    expect(toolsNode.children?.find(c => c.id === 'mcp')?.chars).toBeGreaterThan(0)

    const messagesNode = tree.children!.find(c => c.id === 'messages')!
    expect(messagesNode.children?.find(c => c.id === 'currentUser')?.chars).toBe('hi there'.length)
  })

  it('system without markers has no children', () => {
    const tree = measureContextComposition(
      [
        { role: 'system', content: 'plain' },
        { role: 'user', content: 'u' },
      ],
      []
    )
    const systemNode = tree.children!.find(c => c.id === 'system')!
    expect(systemNode.chars).toBe(5)
    expect(systemNode.children).toBeUndefined()
  })

  it('separates images from text', () => {
    const img = 'data:image/png;base64,AAAA'
    const tree = measureContextComposition(
      [
        { role: 'system', content: 's' },
        { role: 'user', content: 'look', images: [img] },
      ],
      []
    )
    const messagesNode = tree.children!.find(c => c.id === 'messages')!
    expect(messagesNode.children?.find(c => c.id === 'images')?.chars).toBe(img.length)
    expect(messagesNode.children?.find(c => c.id === 'currentUser')?.chars).toBe(4)
  })

  it('history vs currentUser', () => {
    const tree = measureContextComposition(
      [
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'new' },
      ],
      []
    )
    const messagesNode = tree.children!.find(c => c.id === 'messages')!
    expect(messagesNode.children?.find(c => c.id === 'history')?.chars).toBe(
      'old'.length + 'reply'.length
    )
    expect(messagesNode.children?.find(c => c.id === 'currentUser')?.chars).toBe(3)
  })
})
