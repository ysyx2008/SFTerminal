import { describe, it, expect } from 'vitest'
import { ASSISTANT_WORKBENCH_AGENT_TOOLS, LIST_WORKBENCH_ARTIFACTS } from '../assistant/agent-tools'

describe('ASSISTANT_WORKBENCH_AGENT_TOOLS', () => {
  it('定义 list_workbench_artifacts 且仅 assistant 模式', () => {
    expect(ASSISTANT_WORKBENCH_AGENT_TOOLS).toHaveLength(1)
    const tool = ASSISTANT_WORKBENCH_AGENT_TOOLS[0]
    expect(tool.function.name).toBe(LIST_WORKBENCH_ARTIFACTS)
    expect(tool._meta?.supportedModes).toEqual(['assistant'])
    expect(tool._meta?.parallelizable).toBe(true)
  })
})
