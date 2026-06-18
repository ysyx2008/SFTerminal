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
    expect(prompt).toContain('一次只预览')
    expect(prompt).toContain('list_workbench_artifacts')
    expect(prompt).toContain('mv')
  })

  it('远程 assistant tab 不注入', () => {
    expect(resolveWorkbenchAgentPrompt('assistant', { type: 'assistant', isRemote: true }))
      .toBeUndefined()
  })

  it('带 remoteChannel 的 assistant tab 不注入', () => {
    expect(resolveWorkbenchAgentPrompt('assistant', { type: 'assistant', remoteChannel: 'web' }))
      .toBeUndefined()
  })

  it('local 终端工作台注入本地终端操作规范', () => {
    const prompt = resolveWorkbenchAgentPrompt('local', { type: 'local' })
    expect(prompt).toBeDefined()
    expect(prompt).toContain('本地终端工作台')
    expect(prompt).toContain('write_text_file')
    expect(prompt).toContain('check_terminal_status')
    expect(prompt).toContain('没有')
    expect(prompt).toContain('Artifact Panel')
  })

  it('ssh 终端工作台注入 SSH 远程操作规范', () => {
    const prompt = resolveWorkbenchAgentPrompt('ssh', { type: 'ssh' })
    expect(prompt).toBeDefined()
    expect(prompt).toContain('SSH 远程终端工作台')
    expect(prompt).toContain('write_remote_text_file')
    expect(prompt).toContain('Password:')
    expect(prompt).toContain('没有')
    expect(prompt).toContain('Artifact Panel')
  })
})
