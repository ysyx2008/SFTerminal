import { describe, it, expect } from 'vitest'
import { shouldSyncArtifactsAfterStep } from '../domain/artifact-disk-sync'

describe('shouldSyncArtifactsAfterStep', () => {
  it('exec / await_exec 的 tool_result 触发同步', () => {
    expect(shouldSyncArtifactsAfterStep({
      type: 'tool_result',
      toolName: 'exec',
      content: 'done'
    } as never)).toBe(true)
    expect(shouldSyncArtifactsAfterStep({
      type: 'tool_result',
      toolName: 'await_exec',
      content: 'done'
    } as never)).toBe(true)
  })

  it('其它步骤不触发', () => {
    expect(shouldSyncArtifactsAfterStep({
      type: 'tool_call',
      toolName: 'exec',
      content: ''
    } as never)).toBe(false)
    expect(shouldSyncArtifactsAfterStep({
      type: 'tool_result',
      toolName: 'write_file',
      content: 'ok'
    } as never)).toBe(false)
  })
})
