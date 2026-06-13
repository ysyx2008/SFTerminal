/**
 * artifact-registry 单元测试
 */
import { describe, it, expect } from 'vitest'
import {
  applyCanvasData,
  createTabArtifactState,
  getActiveArtifact,
  getArtifactById,
  getArtifacts,
  isPanelVisible,
  removeArtifact,
  setActiveArtifact
} from '../../canvas/artifact-registry'

describe('artifact-registry', () => {
  it('open 同 filePath 时 upsert 而非重复 tab', () => {
    let state = createTabArtifactState()
    state = applyCanvasData(state, {
      action: 'open',
      renderer: 'markdown',
      title: 'a.md',
      filePath: '/tmp/a.md',
      content: 'v1'
    })
    state = applyCanvasData(state, {
      action: 'open',
      renderer: 'markdown',
      title: 'a.md',
      filePath: '/tmp/a.md',
      content: 'v2',
      activate: false
    })
    expect(getArtifacts(state)).toHaveLength(1)
    expect(getArtifactById(state, 'file:/tmp/a.md')?.content).toBe('v2')
  })

  it('多 artifact 并存且 activate:false 不抢焦点', () => {
    let state = applyCanvasData(createTabArtifactState(), {
      action: 'open',
      renderer: 'document',
      title: 'doc.docx',
      filePath: '/tmp/doc.docx',
      content: '<p>doc</p>'
    })
    state = applyCanvasData(state, {
      action: 'open',
      renderer: 'spreadsheet',
      title: 'book.xlsx',
      filePath: '/tmp/book.xlsx',
      content: '<table></table>',
      activate: false
    })
    expect(getArtifacts(state)).toHaveLength(2)
    expect(getActiveArtifact(state)?.id).toBe('file:/tmp/doc.docx')
  })

  it('close 按 filePath 精确移除', () => {
    let state = applyCanvasData(createTabArtifactState(), {
      action: 'open',
      renderer: 'document',
      title: 'doc.docx',
      filePath: '/tmp/doc.docx',
      content: '<p>doc</p>'
    })
    state = applyCanvasData(state, {
      action: 'close',
      renderer: 'document',
      filePath: '/tmp/doc.docx'
    })
    expect(isPanelVisible(state)).toBe(false)
  })

  it('removeArtifact 关闭 active 后选中相邻 tab', () => {
    let state = applyCanvasData(createTabArtifactState(), {
      action: 'open',
      renderer: 'document',
      title: 'a',
      filePath: '/a',
      content: 'a'
    })
    state = applyCanvasData(state, {
      action: 'open',
      renderer: 'markdown',
      title: 'b',
      filePath: '/b',
      content: 'b'
    })
    state = removeArtifact(state, 'file:/b')
    expect(getActiveArtifact(state)?.id).toBe('file:/a')
  })

  it('setActiveArtifact 切换当前 tab', () => {
    let state = applyCanvasData(createTabArtifactState(), {
      action: 'open',
      renderer: 'document',
      title: 'a',
      filePath: '/a',
      content: 'a'
    })
    state = applyCanvasData(state, {
      action: 'open',
      renderer: 'markdown',
      title: 'b',
      filePath: '/b',
      content: 'b',
      activate: false
    })
    state = setActiveArtifact(state, 'file:/b')
    expect(getActiveArtifact(state)?.id).toBe('file:/b')
  })
})
