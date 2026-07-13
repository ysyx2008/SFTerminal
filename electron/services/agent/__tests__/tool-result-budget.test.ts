/**
 * tool-result-budget.ts 单元测试
 *
 * 测试约定：本测试构造一个最小 ToolMeta 注册表（CLEARABLE_TOOLS / PROTECTED_TOOLS
 * 两套显式列表 + 默认可清理），通过 lookupMeta 注入给 applyToolResultBudget。
 * 实际运行时 agent.ts 通过 getMetaByName(this.getAvailableTools(), name) 注入，
 * 测试这里用静态 map 实现等价行为，专注于预算清理逻辑本身。
 */
import { describe, it, expect } from 'vitest'
import { applyToolResultBudget } from '../tool-result-budget'
import type { AiMessage } from '../../ai.service'
import type { ToolMeta } from '../tools'

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

// 测试用 ToolMeta 注册表：还原原始 CLEARABLE / PROTECTED 两套白名单的语义
const CLEARABLE_NAMES = new Set([
  'read_file', 'file_search', 'execute_command', 'get_terminal_context',
  'check_terminal_status', 'search_knowledge', 'get_knowledge_doc', 'recall',
  'recall_task', 'deep_recall'
])
const PROTECTED_NAMES = new Set([
  'edit_file', 'write_text_file', 'write_remote_text_file', 'ask_user', 'plan',
  'create_plan', 'update_plan', 'compress_context',
  'recall_compressed', 'manage_memory', 'dispatch_agents',
  // 技能正文是后续执行规范，清掉会导致「规范丢失」
  'skill', 'load_user_skill',
])

function lookupMeta(toolName: string): ToolMeta | undefined {
  if (CLEARABLE_NAMES.has(toolName)) return { contextBudget: { toolResult: 'clearable' } }
  if (PROTECTED_NAMES.has(toolName)) return { contextBudget: { toolResult: 'protected' } }
  // MCP / plugin / 未知工具沿用模块默认（unspecified → clearable）
  return undefined
}

describe('applyToolResultBudget', () => {
  it('should not modify empty messages', () => {
    const result = applyToolResultBudget([], lookupMeta)
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
    const result = applyToolResultBudget(messages, lookupMeta, { protectRecentRounds: 4 })
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
    const result = applyToolResultBudget(messages, lookupMeta, { protectRecentRounds: 2 })
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
    const result = applyToolResultBudget(messages, lookupMeta, { protectRecentRounds: 2 })
    expect(result.clearedCount).toBe(0)
    expect(messages[2].content).toBe(LONG_OUTPUT)
    expect(messages[4].content).toBe(LONG_OUTPUT)
    expect(messages[6].content).toBe(LONG_OUTPUT)
  })

  it('should not clear skill / load_user_skill results (skill docs)', () => {
    const messages: AiMessage[] = [
      makeUserMsg('task'),
      makeToolCall('tc1', 'skill'),
      makeToolResult('tc1', LONG_OUTPUT),
      makeToolCall('tc2', 'load_user_skill'),
      makeToolResult('tc2', LONG_OUTPUT),
      // recent (protection boundary)
      makeToolCall('tc3', 'read_file'),
      makeToolResult('tc3', LONG_OUTPUT),
      makeToolCall('tc4', 'read_file'),
      makeToolResult('tc4', LONG_OUTPUT),
    ]
    const result = applyToolResultBudget(messages, lookupMeta, { protectRecentRounds: 2 })
    expect(result.clearedCount).toBe(0)
    expect(messages[2].content).toBe(LONG_OUTPUT)
    expect(messages[4].content).toBe(LONG_OUTPUT)
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
    const result = applyToolResultBudget(messages, lookupMeta, { protectRecentRounds: 4 })
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
    const result = applyToolResultBudget(messages, lookupMeta, { protectRecentRounds: 2 })
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
    const result = applyToolResultBudget(messages, lookupMeta, { protectRecentRounds: 4 })
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
    const first = applyToolResultBudget(messages, lookupMeta, { protectRecentRounds: 2 })
    expect(first.clearedCount).toBe(2)

    const second = applyToolResultBudget(messages, lookupMeta, { protectRecentRounds: 2 })
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
    const result = applyToolResultBudget(messages, lookupMeta, { protectRecentRounds: 2 })
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
    const result = applyToolResultBudget(messages, lookupMeta, { protectRecentRounds: 4 })
    expect(result.clearedCount).toBe(1)
    expect(result.freedChars).toBe(content300.length - CLEARED.length)
  })

  it('should handle messages without any assistant role', () => {
    const messages: AiMessage[] = [
      { role: 'system', content: 'system prompt' },
      makeUserMsg('user message'),
    ]
    const result = applyToolResultBudget(messages, lookupMeta)
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
    const result = applyToolResultBudget(messages, lookupMeta, { protectRecentRounds: 4 })
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
    const result = applyToolResultBudget(messages, lookupMeta, { protectRecentRounds: 2 })
    expect(result.clearedCount).toBe(2)
    expect(messages[2].content).toBe(CLEARED)
    expect(messages[3].content).toBe(CLEARED)
  })
})
