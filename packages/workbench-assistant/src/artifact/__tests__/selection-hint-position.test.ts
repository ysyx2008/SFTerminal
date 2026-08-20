import { describe, expect, it } from 'vitest'
import { placeSelectionHint } from '../domain/context-menu-position'
import { useSelectionActionHint } from '../composables/useSelectionActionHint'

const viewport = { left: 0, top: 0, right: 1000, bottom: 600 }

describe('placeSelectionHint', () => {
  it('贴在选区上沿并水平居中', () => {
    expect(placeSelectionHint({
      anchor: { left: 400, top: 300, right: 600, bottom: 320 },
      hintWidth: 200,
      hintHeight: 24,
      viewport
    })).toEqual({ left: 400, top: 270 })
  })

  it('上方放不下就落到选区下沿', () => {
    expect(placeSelectionHint({
      anchor: { left: 400, top: 10, right: 600, bottom: 30 },
      hintWidth: 200,
      hintHeight: 24,
      viewport
    })).toEqual({ left: 400, top: 36 })
  })

  it('选区贴右边时往左收进可视范围', () => {
    expect(placeSelectionHint({
      anchor: { left: 940, top: 300, right: 1000, bottom: 320 },
      hintWidth: 200,
      hintHeight: 24,
      viewport
    })).toEqual({ left: 792, top: 270 })
  })

  it('可视范围被预览窗裁短时不画到窗外', () => {
    expect(placeSelectionHint({
      anchor: { left: 400, top: 120, right: 600, bottom: 140 },
      hintWidth: 200,
      hintHeight: 24,
      viewport: { left: 300, top: 100, right: 800, bottom: 500 }
    })).toEqual({ left: 400, top: 146 })
  })
})

function key(init: Partial<KeyboardEvent>): KeyboardEvent {
  return init as KeyboardEvent
}

describe('useSelectionActionHint 的键盘收起规则', () => {
  const shown = { left: 0, top: 0, right: 10, bottom: 10 }

  it('开始打字就收起', () => {
    const hint = useSelectionActionHint(() => null)
    hint.anchor.value = shown
    hint.hideOnTyping(key({ key: 'a' }))
    expect(hint.anchor.value).toBeNull()
  })

  it('复制等修饰键组合不收起', () => {
    const hint = useSelectionActionHint(() => null)
    hint.anchor.value = shown
    hint.hideOnTyping(key({ key: 'c', metaKey: true }))
    expect(hint.anchor.value).toEqual(shown)
  })

  it('纯光标移动与修饰键本身不收起', () => {
    const hint = useSelectionActionHint(() => null)
    hint.anchor.value = shown
    hint.hideOnTyping(key({ key: 'ArrowRight' }))
    hint.hideOnTyping(key({ key: 'Shift', shiftKey: true }))
    expect(hint.anchor.value).toEqual(shown)
  })

  it('没显示时 refresh 不会把提示凭空冒出来', () => {
    const hint = useSelectionActionHint(() => null)
    hint.refresh()
    expect(hint.anchor.value).toBeNull()
  })
})
