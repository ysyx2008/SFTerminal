/**
 * 工具说明要与模型当下的处境一致。
 *
 * 对应 SPEC「给模型看的说明必须与它当下的处境一致」：
 * - 当前形态下用不上的规矩不出现在说明里（manage_pane 的「最后一扇窗」两边规矩相反）
 * - 余量自查常驻，不跟着压缩工具在高水位才出现
 * - 裁剪只依据一次会话内不变的条件，同样入参必须给出 byte-exact 相同的说明（前缀缓存的前提）
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([])
  }
})

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

import { getAgentTools, type AgentMode } from '../tools'

const describeOf = (mode: AgentMode | undefined, name: string): string => {
  const tools = getAgentTools(undefined, mode ? { mode } : undefined)
  const tool = tools.find(t => t.function.name === name)
  if (!tool) throw new Error(`${name} not found for mode=${mode ?? 'unspecified'}`)
  return tool.function.description ?? ''
}

describe('manage_pane 说明按形态裁剪', () => {
  it('助手页：只讲助手那套，不出现终端页的禁令', () => {
    const desc = describeOf('assistant', 'manage_pane')
    expect(desc).toContain('可以关掉最后一扇')
    expect(desc).not.toContain('终端页不能关最后一扇')
    // 助手没有终端时需要请终端入座，这句只对助手成立
    expect(desc).toContain('请终端入座')
  })

  it.each<AgentMode>(['local', 'ssh'])('终端页（%s）：只讲终端那套，不出现助手的例外', (mode) => {
    const desc = describeOf(mode, 'manage_pane')
    expect(desc).toContain('不能关掉最后一扇')
    expect(desc).not.toContain('可以关掉最后一扇')
    expect(desc).not.toContain('请终端入座')
  })

  it('形态未指定：说不准是哪一种，两边规矩都留着', () => {
    const desc = describeOf(undefined, 'manage_pane')
    expect(desc).toContain('终端页不能关最后一扇')
    expect(desc).toContain('助手可以关最后一扇')
  })

  it('同样的形态给出完全一样的说明——描述不能成为变量，否则前缀缓存每轮作废', () => {
    expect(describeOf('assistant', 'manage_pane')).toBe(describeOf('assistant', 'manage_pane'))
    expect(describeOf('local', 'manage_pane')).toBe(describeOf('local', 'manage_pane'))
  })
})

describe('list_ssh_sessions 说明同样按形态裁剪', () => {
  it('助手页：保留「请终端入座」', () => {
    expect(describeOf('assistant', 'list_ssh_sessions')).toContain('请真终端入座')
  })

  it.each<AgentMode>(['local', 'ssh'])('终端页（%s）：眼前已有终端，不提入座', (mode) => {
    const desc = describeOf(mode, 'list_ssh_sessions')
    expect(desc).not.toContain('请真终端入座')
    expect(desc).toContain('开一扇连过去')
    // 拿 sessionId 再开窗这条主路径在哪种形态下都得说清
    expect(desc).toContain('先调本工具拿 sessionId')
  })
})

describe('上下文余量自查常驻', () => {
  it.each<AgentMode>(['local', 'ssh', 'assistant'])('%s 模式下不用等到高水位就有', (mode) => {
    const names = getAgentTools(undefined, { mode }).map(t => t.function.name)
    expect(names).toContain('check_context')
  })

  it('无人值守时照样在——它只是报数，不等人回答', () => {
    const names = getAgentTools(undefined, { mode: 'assistant', unattended: true }).map(t => t.function.name)
    expect(names).toContain('check_context')
  })

  it('压缩类工具仍按水位启用，不受影响', () => {
    const idle = getAgentTools(undefined, { mode: 'assistant' }).map(t => t.function.name)
    const pressed = getAgentTools(undefined, { mode: 'assistant', includeContextTools: true })
      .map(t => t.function.name)
    expect(idle).not.toContain('compress_context')
    expect(pressed).toContain('compress_context')
    expect(pressed).toContain('check_context')
  })
})

describe('技能装上卸掉只走一扇门', () => {
  it('秘书眼前只有 skill，没有单独的用户技能指令', () => {
    const tools = getAgentTools(undefined, { mode: 'assistant' })
    const names = tools.map(t => t.function.name)
    expect(names).toContain('skill')
    expect(names).not.toContain('load_user_skill')
    const skill = tools.find(t => t.function.name === 'skill')
    expect(skill?.function.description).toContain('卸掉只影响这场对话')
    expect(skill?.function.description).not.toContain('load_user_skill')
  })
})
