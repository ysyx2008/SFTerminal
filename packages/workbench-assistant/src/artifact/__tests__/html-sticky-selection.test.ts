// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  applyStickyMarks,
  clearStickyMarks,
  overlayRectsForRange,
  rangeFromExcerpt,
  excerptFromRange,
  rangeInsideRoot,
  STICKY_MARK_CLASS,
  textSlicesInRange
} from '../domain/html-sticky-selection'

function selectIn(root: HTMLElement, text: string): Selection {
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
  if (!sel) throw new Error('no selection')
  sel.removeAllRanges()
  sel.addRange(range)
  return sel
}

describe('html-sticky-selection', () => {
  it('rangeInsideRoot 取出根内选区', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>Hello world paragraph</p>'
    document.body.appendChild(root)
    const sel = selectIn(root, 'Hello')
    const range = rangeInsideRoot(root, sel)
    expect(range).toBeTruthy()
    expect(excerptFromRange(range!)).toBe('Hello')
    root.remove()
  })

  it('选区在根外时返回 null', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>inside</p>'
    const outside = document.createElement('div')
    outside.textContent = 'outside'
    document.body.appendChild(root)
    document.body.appendChild(outside)
    const sel = selectIn(outside, 'outside')
    expect(rangeInsideRoot(root, sel)).toBeNull()
    root.remove()
    outside.remove()
  })

  it('折叠选区或空白选区返回 null', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>   </p>'
    document.body.appendChild(root)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    expect(rangeInsideRoot(root, sel ?? null)).toBeNull()
    root.remove()
  })

  it('excerptFromRange 把不间断空格收成普通空格', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>foo\u00a0bar</p>'
    document.body.appendChild(root)
    const sel = selectIn(root, 'foo\u00a0bar')
    const range = rangeInsideRoot(root, sel)
    expect(excerptFromRange(range!)).toBe('foo bar')
    root.remove()
  })

  it('applyStickyMarks 在字上钉高亮，clear 后还原', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>Hello world</p>'
    document.body.appendChild(root)
    const sel = selectIn(root, 'Hello')
    const range = rangeInsideRoot(root, sel)!
    applyStickyMarks(root, range)
    const marks = root.querySelectorAll(`.${STICKY_MARK_CLASS}`)
    expect(marks.length).toBe(1)
    expect(marks[0].textContent).toBe('Hello')
    expect(root.textContent).toBe('Hello world')
    clearStickyMarks(root)
    expect(root.querySelectorAll(`.${STICKY_MARK_CLASS}`).length).toBe(0)
    expect(root.textContent).toBe('Hello world')
    root.remove()
  })

  it('跨段落选区会钉多段 mark', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>AAA</p><p>BBB</p>'
    document.body.appendChild(root)
    const first = root.querySelector('p')!.firstChild as Text
    const second = root.querySelectorAll('p')[1].firstChild as Text
    const range = document.createRange()
    range.setStart(first, 1)
    range.setEnd(second, 2)
    expect(textSlicesInRange(range).length).toBe(2)
    applyStickyMarks(root, range)
    const marks = [...root.querySelectorAll(`.${STICKY_MARK_CLASS}`)]
    expect(marks.map(m => m.textContent).join('')).toBe('AABB')
    clearStickyMarks(root)
    expect(root.textContent).toBe('AAABBB')
    root.remove()
  })

  it('rangeFromExcerpt 按原文找回选区', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>Hello world paragraph</p>'
    document.body.appendChild(root)
    const range = rangeFromExcerpt(root, 'world')
    expect(range).toBeTruthy()
    expect(excerptFromRange(range!)).toBe('world')
    applyStickyMarks(root, range)
    expect(root.querySelector(`.${STICKY_MARK_CLASS}`)?.textContent).toBe('world')
    root.remove()
  })

  it('overlayRectsForRange 相对 host 换算', () => {
    const host = document.createElement('div')
    const range = document.createRange()
    host.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 100, height: 80, right: 110, bottom: 100, x: 10, y: 20, toJSON() {} }) as DOMRect
    range.getClientRects = () =>
      ([{ left: 15, top: 30, width: 40, height: 16, right: 55, bottom: 46, x: 15, y: 30, toJSON() {} }] as unknown as DOMRectList)
    expect(overlayRectsForRange(range, host)).toEqual([
      { left: 5, top: 10, width: 40, height: 16 }
    ])
  })
})
