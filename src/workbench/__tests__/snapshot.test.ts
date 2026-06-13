import { describe, it, expect } from 'vitest'
import { buildAssistantArtifactSnapshot } from '../assistant/snapshot'
import { applyCanvasData, createTabArtifactState } from '../../canvas/artifact-registry'

describe('buildAssistantArtifactSnapshot', () => {
  it('无 artifact 时 panelVisible 为 false', () => {
    const snap = buildAssistantArtifactSnapshot('tab-1', createTabArtifactState())
    expect(snap.panelVisible).toBe(false)
    expect(snap.artifacts).toEqual([])
  })

  it('有 markdown artifact 时反映 panel 与 tab 列表', () => {
    let state = createTabArtifactState()
    state = applyCanvasData(state, {
      action: 'open',
      renderer: 'markdown',
      title: '测试.md',
      content: '# hi',
      filePath: '/tmp/测试.md'
    })
    const snap = buildAssistantArtifactSnapshot('tab-1', state)
    expect(snap.panelVisible).toBe(true)
    expect(snap.artifacts).toHaveLength(1)
    expect(snap.artifacts[0].renderer).toBe('markdown')
    expect(snap.artifacts[0].filePath).toBe('/tmp/测试.md')
    expect(snap.activeArtifactId).toBe(snap.artifacts[0].id)
  })
})
