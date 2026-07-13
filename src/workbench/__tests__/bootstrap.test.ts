/**
 * bootstrapWorkbenchCapabilities：遍历 descriptor 装配 skills / MCP
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  clearWorkbenchRegistryForTests,
  registerWorkbench,
} from '../registry-store'
import { bootstrapWorkbenchCapabilities } from '../bootstrap'
import type { WorkbenchDescriptor } from '../types'
import type { McpServerConfig } from '@sailfish/shared-types'
import {
  SAMPLE_FAKE_MCP,
  SAMPLE_WORKBENCH_SKILLS,
} from '@sailfish/workbench-sample/capabilities'

describe('bootstrapWorkbenchCapabilities', () => {
  const connect = vi.fn(async (_cfg: McpServerConfig) => undefined)

  beforeEach(() => {
    clearWorkbenchRegistryForTests()
    connect.mockClear()
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: { mcp: { connect } },
    }
  })

  afterEach(() => {
    clearWorkbenchRegistryForTests()
    delete (globalThis as { window?: unknown }).window
  })

  it('收集 skillsDeclared，跳过 enabled=false 的 MCP', async () => {
    const d: WorkbenchDescriptor = {
      kind: 'sample',
      skills: [...SAMPLE_WORKBENCH_SKILLS],
      mcpServers: [SAMPLE_FAKE_MCP],
      agentPrompt: 'x',
    }
    registerWorkbench(d)

    const result = await bootstrapWorkbenchCapabilities()
    expect(result.skillsDeclared).toEqual([...SAMPLE_WORKBENCH_SKILLS])
    expect(result.mcpConnected).toEqual([])
    expect(result.mcpFailed).toEqual([])
    expect(connect).not.toHaveBeenCalled()
  })

  it('对 enabled MCP 调用 electronAPI.mcp.connect', async () => {
    const enabledMcp: McpServerConfig = { ...SAMPLE_FAKE_MCP, enabled: true }
    registerWorkbench({
      kind: 'sample-enabled-mcp',
      skills: ['excel'],
      mcpServers: [enabledMcp],
    })

    const result = await bootstrapWorkbenchCapabilities()
    expect(result.mcpConnected).toEqual([enabledMcp.id])
    expect(result.mcpFailed).toEqual([])
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith(enabledMcp)
  })

  it('connect 失败记入 mcpFailed', async () => {
    connect.mockRejectedValueOnce(new Error('boom'))
    registerWorkbench({
      kind: 'sample-fail-mcp',
      mcpServers: [{ ...SAMPLE_FAKE_MCP, enabled: true }],
    })

    const result = await bootstrapWorkbenchCapabilities()
    expect(result.mcpConnected).toEqual([])
    expect(result.mcpFailed).toEqual([{ id: SAMPLE_FAKE_MCP.id, error: 'boom' }])
  })
})
