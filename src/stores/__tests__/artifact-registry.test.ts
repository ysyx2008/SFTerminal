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
  hydrateArtifactsFromSteps,
  isArtifactEmptyState,
  isPanelVisible,
  removeArtifact,
  setActiveArtifact,
} from '@sailfish/workbench-assistant/artifact'

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
    expect(state.artifacts).toHaveLength(0)
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

  it('hydrateArtifactsFromSteps 按顺序重放 canvasData', () => {
    const state = hydrateArtifactsFromSteps([
      {
        canvasData: {
          action: 'open',
          renderer: 'document',
          title: 'doc.docx',
          filePath: '/tmp/doc.docx',
          content: '<p>v1</p>'
        }
      },
      {
        canvasData: {
          action: 'update',
          renderer: 'document',
          filePath: '/tmp/doc.docx',
          content: '<p>v2</p>'
        }
      },
      {
        canvasData: {
          action: 'open',
          renderer: 'markdown',
          title: 'note.md',
          filePath: '/tmp/note.md',
          content: '# hi',
          activate: false
        }
      }
    ])
    expect(getArtifacts(state)).toHaveLength(2)
    expect(getArtifactById(state, 'file:/tmp/doc.docx')?.content).toBe('<p>v2</p>')
    expect(getActiveArtifact(state)?.id).toBe('file:/tmp/doc.docx')
    expect(isPanelVisible(state)).toBe(true)
  })

  it('hydrateArtifactsFromSteps 处理 close action', () => {
    const state = hydrateArtifactsFromSteps([
      {
        canvasData: {
          action: 'open',
          renderer: 'document',
          title: 'a.docx',
          filePath: '/tmp/a.docx',
          content: '<p>a</p>'
        }
      },
      {
        canvasData: {
          action: 'close',
          renderer: 'document',
          filePath: '/tmp/a.docx'
        }
      }
    ])
    expect(getArtifacts(state)).toHaveLength(0)
    expect(isPanelVisible(state)).toBe(false)
    expect(isArtifactEmptyState(state)).toBe(false)
  })

  it('renderer 变更时不继承 contentFromFile', () => {
    let state = applyCanvasData(createTabArtifactState(), {
      action: 'open',
      renderer: 'markdown',
      title: 'a.md',
      filePath: '/tmp/shared',
      content: '# md',
      contentFromFile: true
    })
    state = applyCanvasData(state, {
      action: 'open',
      renderer: 'document',
      title: 'a.docx',
      filePath: '/tmp/shared',
      content: '<p>doc</p>'
    })
    const art = getArtifactById(state, 'file:/tmp/shared')
    expect(art?.renderer).toBe('document')
    expect(art?.contentFromFile).toBeUndefined()
  })

  it('url 型产出物：open 生成 url: 前缀 id，同 url upsert', () => {
    let state = applyCanvasData(createTabArtifactState(), {
      action: 'open',
      renderer: 'browser',
      title: 'dev server',
      url: 'http://localhost:3000'
    })
    state = applyCanvasData(state, {
      action: 'open',
      renderer: 'browser',
      title: ' renamed ',
      url: 'http://localhost:3000'
    })
    expect(getArtifacts(state)).toHaveLength(1)
    const art = getArtifactById(state, 'url:http://localhost:3000')
    expect(art?.title).toBe(' renamed ')
    expect(art?.url).toBe('http://localhost:3000')
    expect(art?.filePath).toBeNull()
  })

  it('url 型产出物：update 可替换 url，close 按 url 匹配移除', () => {
    let state = applyCanvasData(createTabArtifactState(), {
      action: 'open',
      renderer: 'browser',
      title: 'dev server',
      url: 'http://localhost:3000'
    })
    state = applyCanvasData(state, {
      action: 'update',
      renderer: 'browser',
      url: 'http://localhost:3000'
    })
    // update 仅替换字段，url 不变时 id 不变
    expect(getArtifactById(state, 'url:http://localhost:3000')).not.toBeNull()

    state = applyCanvasData(state, {
      action: 'close',
      renderer: 'browser',
      url: 'http://localhost:3000'
    })
    expect(getArtifacts(state)).toHaveLength(0)
    expect(isPanelVisible(state)).toBe(false)
  })
})
