/**
 * 无人值守执行：环境里没有可同步应答的人时，会阻塞等人回答的工具不该出现。
 *
 * 对应 SPEC「环境感知优先于行为指导」——工具清单是环境描述的一部分。
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

import { getAgentTools, filterUnattendedTools, type ToolDefinitionWithMeta } from '../tools'
import { getSubAgentTools } from '../tools/sub-agent'

const blockingToolNames = (tools: ReturnType<typeof getAgentTools>) =>
  tools
    .filter(t => (t as ToolDefinitionWithMeta)._meta?.lifecycle?.blocksUntilUserInput)
    .map(t => t.function.name)

describe('无人值守时的工具可见性', () => {
  for (const mode of ['assistant', 'local', 'ssh'] as const) {
    it(`${mode} 模式：有人应答时保留阻塞型工具，无人时移除`, () => {
      const attended = getAgentTools(undefined, { mode })
      const unattended = getAgentTools(undefined, { mode, unattended: true })

      // 前提：该模式下确实存在阻塞型工具，否则这条用例是空转
      expect(blockingToolNames(attended).length).toBeGreaterThan(0)
      expect(blockingToolNames(unattended)).toEqual([])
    })
  }

  it('只移除阻塞型工具，其余工具原样保留且顺序不变', () => {
    const attended = getAgentTools(undefined, { mode: 'assistant' })
    const unattended = getAgentTools(undefined, { mode: 'assistant', unattended: true })

    const blocking = new Set(blockingToolNames(attended))
    const expected = attended.filter(t => !blocking.has(t.function.name)).map(t => t.function.name)
    expect(unattended.map(t => t.function.name)).toEqual(expected)
  })

  it('ask_user 是当前唯一被移除的工具', () => {
    const attended = getAgentTools(undefined, { mode: 'assistant' })
    expect(blockingToolNames(attended)).toEqual(['ask_user'])
  })

  it('移除后子 Agent 工具列表仍是父列表的连续前缀（cache 约定不被破坏）', () => {
    const parent = getAgentTools(undefined, { mode: 'assistant', unattended: true }).map(t => t.function.name)
    for (const type of ['explore', 'edit', 'research']) {
      const child = getSubAgentTools(type).map(t => t.function.name)
      expect(parent.slice(0, child.length)).toEqual(child)
    }
  })

  it('过滤函数按元数据判定，不认工具名（技能等后加入的来源共用它）', () => {
    const tools = [
      { type: 'function', function: { name: 'plain', description: '', parameters: {} } },
      {
        type: 'function',
        function: { name: 'some_future_prompt_tool', description: '', parameters: {} },
        _meta: { lifecycle: { blocksUntilUserInput: true } }
      },
      {
        type: 'function',
        function: { name: 'not_blocking', description: '', parameters: {} },
        _meta: { lifecycle: { marksOnboardingComplete: true } }
      }
    ] as ToolDefinitionWithMeta[]

    expect(filterUnattendedTools(tools).map(t => t.function.name)).toEqual(['plain', 'not_blocking'])
  })

  it('缺省（未申报）视为有人，行为与现状一致', () => {
    const base = getAgentTools(undefined, { mode: 'assistant' }).map(t => t.function.name)
    const explicitFalse = getAgentTools(undefined, { mode: 'assistant', unattended: false }).map(t => t.function.name)
    expect(explicitFalse).toEqual(base)
  })
})
