import { describe, it, expect } from 'vitest'
import { ASSISTANT_WORKBENCH_AGENT_TOOLS, LIST_WORKBENCH_ARTIFACTS, MANAGE_WORKBENCH_ARTIFACTS } from '../assistant/agent-tools'

describe('ASSISTANT_WORKBENCH_AGENT_TOOLS', () => {
  it('全部工具仅 assistant 模式', () => {
    expect(ASSISTANT_WORKBENCH_AGENT_TOOLS).toHaveLength(2)
    for (const tool of ASSISTANT_WORKBENCH_AGENT_TOOLS) {
      expect(tool._meta?.supportedModes).toEqual(['assistant'])
    }
  })

  it('定义 list_workbench_artifacts（只读、可并行）', () => {
    const tool = ASSISTANT_WORKBENCH_AGENT_TOOLS.find(t => t.function.name === LIST_WORKBENCH_ARTIFACTS)!
    expect(tool).toBeDefined()
    expect(tool._meta?.parallelizable).toBe(true)
  })

  it('定义 manage_workbench_artifacts（open/close，必填 action+path）', () => {
    const tool = ASSISTANT_WORKBENCH_AGENT_TOOLS.find(t => t.function.name === MANAGE_WORKBENCH_ARTIFACTS)!
    expect(tool).toBeDefined()
    const params = tool.function.parameters as { properties: Record<string, unknown>; required: string[] }
    expect(params.properties.action).toBeDefined()
    expect(params.properties.path).toBeDefined()
    expect(params.required).toEqual(['action', 'path'])
  })
})
