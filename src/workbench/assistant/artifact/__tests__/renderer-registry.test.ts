/**
 * renderer-registry 单元测试
 */
import { describe, it, expect } from 'vitest'
import {
  getRendererCapabilities,
  isArtifactEditable,
  isRendererEditable,
  saveExtensionForRenderer
} from '../renderers/registry'

describe('renderer-registry', () => {
  it('markdown 可编辑且 write 策略', () => {
    const caps = getRendererCapabilities('markdown')
    expect(caps.editable).toBe(true)
    expect(caps.saveStrategy).toBe('write')
    expect(caps.defaultExt).toBe('.md')
  })

  it('document 只读且 copy 策略', () => {
    const caps = getRendererCapabilities('document')
    expect(caps.editable).toBe(false)
    expect(caps.saveStrategy).toBe('copy')
    expect(saveExtensionForRenderer('document')).toBe('.docx')
  })

  it('isArtifactEditable 优先 artifact.editable', () => {
    expect(isRendererEditable('markdown')).toBe(true)
    expect(
      isArtifactEditable({ renderer: 'markdown', editable: false })
    ).toBe(false)
    expect(
      isArtifactEditable({ renderer: 'document', editable: true })
    ).toBe(true)
  })
})
