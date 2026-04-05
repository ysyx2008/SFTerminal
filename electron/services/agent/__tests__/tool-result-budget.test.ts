/**
 * tool-result-budget.ts 单元测试
 */
import { describe, it, expect } from 'vitest'
import { applyToolResultBudget } from '../tool-result-budget'
import type { AiMessage } from '../../ai.service'

function makeToolCall(id: string, name: string, args = '{}'): AiMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function' as const, function: { name, arguments: args } }]
  }
}

function makeToolResult(toolCallId: string, content: string): AiMessage {
  return { role: 'tool', content, tool_call_id: toolCallId }
}

function makeUserMsg(content: string): AiMessage {
  return { role: 'user', content }
}

const LONG_OUTPUT = 'x'.repeat(500)
const SHORT_OUTPUT = 'short'
const CLEARED = '[旧工具输出已清理]'

describe('applyToolResultBudget', () => {
  it('should not modify empty messages', () => {
    const result = applyToolResultBudget([])
    expect(result.clearedCount).toBe(0)
    expect(result.freedChars).toBe(0)
  })

  it('should not clear recent tool results within protection boundary', () => {
    const messages: AiMessage[] = [
      makeUserMsg('do something'),
      makeToolCall('tc1', 'read_file'),
      makeToolResult('tc1', LONG_OUTPUT),
      makeToolCall('tc2', 'read_file'),
      makeToolResult('tc2', LONG_OUTPUT),
    ]
    const result = applyToolResultBudget(messages, { protectRecentRounds: 4 })
    expect(result.clearedCount).toBe(0)
    expect(messages[2].content).toBe(LONG_OUTPUT)
    expect(messages[4].content).toBe(LONG_OUTPUT)
  })

  it('should clear old read_file results beyond protection boundary', () => {
    const messages: AiMessage[] = [
      makeUserMsg('task'),
      // old rounds (will be cleared)
      makeToolCall('tc1', 'read_file'),
      makeToolResult('tc1', LONG_OUTPUT),
      makeToolCall('tc2', 'execute_command'),
      makeToolResult('tc2', LONG_OUTPUT),
      // recent rounds (protected, protectRecentRounds=2)
      makeToolCall('tc3', 'read_file'),
      makeToolResult('tc3', LONG_OUTPUT),
      makeToolCall('tc4', 'read_file'),
      makeToolResult('tc4', LONG_OUTPUT),
    ]
    const result = applyToolResultBudget(messages, { protectRecentRounds: 2 })
    expect(result.clearedCount).toBe(2)
    expect(messages[2].content).toBe(CLEARED)
    expect(messages[4].content).toBe(CLEARED)
    // Recent ones untouched
    expect(messages[6].content).toBe(LONG_OUTPUT)
    expect(messages[8].content).toBe(LONG_OUTPUT)
  })

  it('should not clear protected tools (edit_file, ask_user, etc.)', () => {
    const messages: AiMessage[] = [
      makeUserMsg('task'),
      makeToolCall('tc1', 'edit_file'),
      makeToolResult('tc1', LONG_OUTPUT),
      makeToolCall('tc2', 'ask_user'),
      makeToolResult('tc2', LONG_OUTPUT),
      makeToolCall('tc3', 'write_text_file'),
      makeToolResult('tc3', LONG_OUTPUT),
      // recent (protection boundary)
      makeToolCall('tc4', 'read_file'),
      makeToolResult('tc4', LONG_OUTPUT),
      makeToolCall('tc5', 'read_file'),
      makeToolResult('tc5', LONG_OUTPUT),
    ]
    const result = applyToolResultBudget(messages, { protectRecentRounds: 2 })
    expect(result.clearedCount).toBe(0)
    expect(messages[2].content).toBe(LONG_OUTPUT)
    expect(messages[4].content).toBe(LONG_OUTPUT)
    expect(messages[6].content).toBe(LONG_OUTPUT)
  })

  it('should not clear short tool outputs', () => {
    const messages: AiMessage[] = [
      makeUserMsg('task'),
      makeToolCall('tc1', 'read_file'),
      makeToolResult('tc1', SHORT_OUTPUT),
      // recent
      makeToolCall('tc2', 'read_file'),
      makeToolResult('tc2', LONG_OUTPUT),
      makeToolCall('tc3', 'read_file'),
      makeToolResult('tc3', LONG_OUTPUT),
      makeToolCall('tc4', 'read_file'),
      makeToolResult('tc4', LONG_OUTPUT),
      makeToolCall('tc5', 'read_file'),
      makeToolResult('tc5', LONG_OUTPUT),
    ]
    const result = applyToolResultBudget(messages, { protectRecentRounds: 4 })
    expect(result.clearedCount).toBe(0)
    expect(messages[2].content).toBe(SHORT_OUTPUT)
  })

  it('should skip system messages', () => {
    const messages: AiMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      makeUserMsg('task'),
      makeToolCall('tc1', 'read_file'),
      makeToolResult('tc1', LONG_OUTPUT),
      // recent
      makeToolCall('tc2', 'read_file'),
      makeToolResult('tc2', LONG_OUTPUT),
      makeToolCall('tc3', 'read_file'),
      makeToolResult('tc3', LONG_OUTPUT),
    ]
    const result = applyToolResultBudget(messages, { protectRecentRounds: 2 })
    expect(result.clearedCount).toBe(1)
    expect(messages[0].content).toBe('You are a helpful assistant.')
    expect(messages[3].content).toBe(CLEARED)
  })

  it('should not clear already-cleared messages', () => {
    const messages: AiMessage[] = [
      makeUserMsg('task'),
      makeToolCall('tc1', 'read_file'),
      makeToolResult('tc1', CLEARED),
      // recent
      makeToolCall('tc2', 'read_file'),
      makeToolResult('tc2', LONG_OUTPUT),
      makeToolCall('tc3', 'read_file'),
      makeToolResult('tc3', LONG_OUTPUT),
      makeToolCall('tc4', 'read_file'),
      makeToolResult('tc4', LONG_OUTPUT),
      makeToolCall('tc5', 'read_file'),
      makeToolResult('tc5', LONG_OUTPUT),
    ]
    const result = applyToolResultBudget(messages, { protectRecentRounds: 4 })
    expect(result.clearedCount).toBe(0)
  })

  it('should be idempotent (second call changes nothing)', () => {
    const messages: AiMessage[] = [
      makeUserMsg('task'),
      makeToolCall('tc1', 'read_file'),
      makeToolResult('tc1', LONG_OUTPUT),
      makeToolCall('tc2', 'file_search'),
      makeToolResult('tc2', LONG_OUTPUT),
      // recent
      makeToolCall('tc3', 'read_file'),
      makeToolResult('tc3', LONG_OUTPUT),
      makeToolCall('tc4', 'read_file'),
      makeToolResult('tc4', LONG_OUTPUT),
    ]
    const first = applyToolResultBudget(messages, { protectRecentRounds: 2 })
    expect(first.clearedCount).toBe(2)

    const second = applyToolResultBudget(messages, { protectRecentRounds: 2 })
    expect(second.clearedCount).toBe(0)
  })

  it('should handle MCP and plugin tools as clearable', () => {
    const messages: AiMessage[] = [
      makeUserMsg('task'),
      makeToolCall('tc1', 'mcp_some_server_tool'),
      makeToolResult('tc1', LONG_OUTPUT),
      makeToolCall('tc2', 'plugin_my_tool'),
      makeToolResult('tc2', LONG_OUTPUT),
      // recent
      makeToolCall('tc3', 'read_file'),
      makeToolResult('tc3', LONG_OUTPUT),
      makeToolCall('tc4', 'read_file'),
      makeToolResult('tc4', LONG_OUTPUT),
    ]
    const result = applyToolResultBudget(messages, { protectRecentRounds: 2 })
    expect(result.clearedCount).toBe(2)
    expect(messages[2].content).toBe(CLEARED)
    expect(messages[4].content).toBe(CLEARED)
  })

  it('should correctly calculate freedChars', () => {
    const content300 = 'a'.repeat(300)
    const messages: AiMessage[] = [
      makeUserMsg('task'),
      makeToolCall('tc1', 'read_file'),
      makeToolResult('tc1', content300),
      // recent
      makeToolCall('tc2', 'read_file'),
      makeToolResult('tc2', LONG_OUTPUT),
      makeToolCall('tc3', 'read_file'),
      makeToolResult('tc3', LONG_OUTPUT),
      makeToolCall('tc4', 'read_file'),
      makeToolResult('tc4', LONG_OUTPUT),
      makeToolCall('tc5', 'read_file'),
      makeToolResult('tc5', LONG_OUTPUT),
    ]
    const result = applyToolResultBudget(messages, { protectRecentRounds: 4 })
    expect(result.clearedCount).toBe(1)
    expect(result.freedChars).toBe(content300.length - CLEARED.length)
  })

  it('should handle messages without any assistant role', () => {
    const messages: AiMessage[] = [
      { role: 'system', content: 'system prompt' },
      makeUserMsg('user message'),
    ]
    const result = applyToolResultBudget(messages)
    expect(result.clearedCount).toBe(0)
  })

  it('should not clear tool result when tool_call_id not found in map', () => {
    const messages: AiMessage[] = [
      makeUserMsg('task'),
      { role: 'tool', content: LONG_OUTPUT, tool_call_id: 'nonexistent_id' },
      // recent
      makeToolCall('tc2', 'read_file'),
      makeToolResult('tc2', LONG_OUTPUT),
      makeToolCall('tc3', 'read_file'),
      makeToolResult('tc3', LONG_OUTPUT),
      makeToolCall('tc4', 'read_file'),
      makeToolResult('tc4', LONG_OUTPUT),
      makeToolCall('tc5', 'read_file'),
      makeToolResult('tc5', LONG_OUTPUT),
    ]
    const result = applyToolResultBudget(messages, { protectRecentRounds: 4 })
    expect(result.clearedCount).toBe(0)
    expect(messages[1].content).toBe(LONG_OUTPUT)
  })

  it('should handle multiple tool_calls in a single assistant message', () => {
    const multiToolAssistant: AiMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        { id: 'tc2', type: 'function', function: { name: 'file_search', arguments: '{}' } },
      ]
    }
    const messages: AiMessage[] = [
      makeUserMsg('task'),
      multiToolAssistant,
      makeToolResult('tc1', LONG_OUTPUT),
      makeToolResult('tc2', LONG_OUTPUT),
      // recent
      makeToolCall('tc3', 'read_file'),
      makeToolResult('tc3', LONG_OUTPUT),
      makeToolCall('tc4', 'read_file'),
      makeToolResult('tc4', LONG_OUTPUT),
    ]
    const result = applyToolResultBudget(messages, { protectRecentRounds: 2 })
    expect(result.clearedCount).toBe(2)
    expect(messages[2].content).toBe(CLEARED)
    expect(messages[3].content).toBe(CLEARED)
  })
})
