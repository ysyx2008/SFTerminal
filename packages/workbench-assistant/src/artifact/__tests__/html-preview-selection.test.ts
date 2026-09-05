// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  hostBoxFromGuest,
  htmlPreviewSelectionGuestScript,
  installHtmlPreviewSelectionGuest,
  isHtmlFilePreviewSelectionEnabled,
  parseHtmlPreviewSelectionReport
} from '../domain/html-preview-selection'

function selectIn(root: HTMLElement, text: string): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node: Text | null = null
  let idx = -1
  while (walker.nextNode()) {
    const current = walker.currentNode as Text
    const found = current.data.indexOf(text)
    if (found >= 0) {
      node = current
      idx = found
      break
    }
  }
  if (!node || idx < 0) throw new Error(`text not found: ${text}`)
  const range = document.createRange()
  range.setStart(node, idx)
  range.setEnd(node, idx + text.length)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

describe('html-preview-selection', () => {
  it('PPT 预览不开放划选', () => {
    expect(isHtmlFilePreviewSelectionEnabled({ isPptPreview: true })).toBe(false)
    expect(isHtmlFilePreviewSelectionEnabled({ isPptPreview: false })).toBe(true)
  })

  it('parse 只收合法报告', () => {
    expect(parseHtmlPreviewSelectionReport(null)).toBeNull()
    expect(parseHtmlPreviewSelectionReport({ kind: 'click' })).toBeNull()
    expect(parseHtmlPreviewSelectionReport({
      kind: 'mouseup',
      excerpt: '  hello\u00a0world  ',
      box: { left: 1, top: 2, right: 10, bottom: 20 }
    })).toEqual({
      kind: 'mouseup',
      excerpt: 'hello world',
      box: { left: 1, top: 2, right: 10, bottom: 20 }
    })
  })

  it('hostBoxFromGuest 按缩放换算到宿主', () => {
    expect(hostBoxFromGuest(
      { left: 10, top: 20, right: 50, bottom: 40 },
      { left: 100, top: 200 },
      2
    )).toEqual({ left: 120, top: 240, right: 200, bottom: 280 })
  })

  it('注入脚本是自包含 IIFE', () => {
    const src = htmlPreviewSelectionGuestScript()
    expect(src.startsWith('(')).toBe(true)
    expect(src).toContain('__sfArtifactGuest')
    expect(src).not.toContain('import ')
  })

  it('客页划选后报告摘录，钉住后高亮仍在', () => {
    const posts: unknown[] = []
    ;(window as Window & { __sfArtifactHost?: { post: (d: unknown) => void } }).__sfArtifactHost = {
      post: (d) => { posts.push(d) }
    }
    document.body.innerHTML = '<p>Hello preview paragraph</p>'
    installHtmlPreviewSelectionGuest()
    selectIn(document.body, 'Hello')
    document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }))
    expect(posts.at(-1)).toMatchObject({ kind: 'mouseup', excerpt: 'Hello' })

    ;(window as Window & { __sfArtifactGuest?: { handle: (cmd: unknown) => void } })
      .__sfArtifactGuest?.handle({ op: 'pin' })
    expect(document.querySelector('.sf-doc-sticky-mark')?.textContent).toBe('Hello')

    ;(window as Window & { __sfArtifactGuest?: { handle: (cmd: unknown) => void } })
      .__sfArtifactGuest?.handle({ op: 'clear' })
    expect(document.querySelector('.sf-doc-sticky-mark')).toBeNull()
    document.body.innerHTML = ''
  })
})
