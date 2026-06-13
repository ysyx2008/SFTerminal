/**
 * workbench Agent prompt 解析
 */
import { describe, it, expect } from 'vitest'
import { resolveWorkbenchAgentPrompt } from '../resolve-workbench-agent-prompt'
import { AGENT_PROMPT } from '../assistant/prompt'

describe('resolveWorkbenchAgentPrompt', () => {
  it('桌面独立助手 tab 返回 assistant 文案', () => {
    const prompt = resolveWorkbenchAgentPrompt('assistant', { type: 'assistant' })
    expect(prompt).toBe(AGENT_PROMPT)
    expect(prompt).toContain('generate_chart')
    expect(prompt).toContain('不会出现')
  })

  it('远程 assistant tab 不注入', () => {
    expect(resolveWorkbenchAgentPrompt('assistant', { type: 'assistant', isRemote: true }))
      .toBeUndefined()
  })

  it('带 remoteChannel 的 assistant tab 不注入', () => {
    expect(resolveWorkbenchAgentPrompt('assistant', { type: 'assistant', remoteChannel: 'web' }))
      .toBeUndefined()
  })

  it('local / ssh 暂无工作台 Agent 描述', () => {
    expect(resolveWorkbenchAgentPrompt('local', { type: 'local' })).toBeUndefined()
    expect(resolveWorkbenchAgentPrompt('ssh', { type: 'ssh' })).toBeUndefined()
  })
})
