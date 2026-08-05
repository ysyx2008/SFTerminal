// @vitest-environment jsdom
/**
 * 冒烟测试：Crepe 编辑器（TopBar 开启）挂载后正文存在；
 * destroy 后不再触发 onDocChanged（防止销毁清空回灌）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createMarkdownWysiwygEditor } from '../editor/markdown-wysiwyg-editor'

const DOC = ['# 标题', '', '正文第一段。', '', '| A | B |', '|---|---|', '| 1 | 2 |', ''].join('\n')

describe('markdown-wysiwyg-editor smoke', () => {
  it('挂载后 ProseMirror 正文可见且包含文档文本', async () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const handle = await createMarkdownWysiwygEditor({
      parent,
      doc: DOC,
      onDocChanged: () => {}
    })
    const pm = parent.querySelector('.ProseMirror')
    expect(pm).toBeTruthy()
    expect(pm?.textContent).toContain('正文第一段')
    expect(parent.querySelector('.milkdown-top-bar')).toBeTruthy()
    handle.destroy()
    parent.remove()
  })

  it('destroy 后不再触发 onDocChanged（防销毁清空回灌）', async () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const onDocChanged = vi.fn()
    const handle = await createMarkdownWysiwygEditor({
      parent,
      doc: DOC,
      onDocChanged
    })
    const callsBefore = onDocChanged.mock.calls.length
    handle.destroy()
    // 给 destroy 一个微任务/宏任务窗口
    await new Promise((r) => setTimeout(r, 0))
    expect(onDocChanged.mock.calls.length).toBe(callsBefore)
    parent.remove()
  })

  it('setContent 后 getContent 返回规范化内容', async () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const handle = await createMarkdownWysiwygEditor({
      parent,
      doc: '# A',
      onDocChanged: () => {}
    })
    handle.setContent('# B\n\nnew body')
    expect(handle.getContent()).toContain('new body')
    handle.destroy()
    parent.remove()
  })
})
