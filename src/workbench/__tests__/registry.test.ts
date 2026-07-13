/**
 * workbench registry-store：动态注册（无 Vue）
 */
import { describe, it, expect } from 'vitest'
import {
  getWorkbenchDescriptor,
  listWorkbenchDescriptors,
  registerWorkbench,
} from '../registry-store'
import { resolveWorkbenchAgentPrompt } from '../resolve-workbench-agent-prompt'
import type { WorkbenchDescriptor } from '../types'

describe('registerWorkbench', () => {
  it('可注册自定义 kind 并解析 agentPrompt', () => {
    const custom: WorkbenchDescriptor = {
      kind: 'test-oem-bench',
      availableInSteam: true,
      agentPrompt: 'OEM test prompt',
      skills: ['excel'],
      mcpServers: [],
    }
    registerWorkbench(custom)
    expect(getWorkbenchDescriptor('test-oem-bench')).toEqual(custom)
    expect(listWorkbenchDescriptors().some((d) => d.kind === 'test-oem-bench')).toBe(true)
    expect(resolveWorkbenchAgentPrompt('test-oem-bench', { type: 'assistant' })).toBe(
      'OEM test prompt'
    )
  })
})
