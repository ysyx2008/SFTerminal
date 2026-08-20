import { describe, expect, it } from 'vitest'
import { clampContextMenuPosition } from '../domain/context-menu-position'

const viewport = { left: 0, top: 0, right: 1000, bottom: 600 }

describe('clampContextMenuPosition', () => {
  it('下方够用时贴在指针处', () => {
    expect(clampContextMenuPosition({
      x: 100,
      y: 80,
      menuWidth: 180,
      menuHeight: 200,
      viewport
    })).toEqual({ left: 100, top: 80 })
  })

  it('贴底时翻到指针上方', () => {
    expect(clampContextMenuPosition({
      x: 100,
      y: 520,
      menuWidth: 180,
      menuHeight: 200,
      viewport
    })).toEqual({ left: 100, top: 320 })
  })

  it('贴右时往左收', () => {
    expect(clampContextMenuPosition({
      x: 900,
      y: 80,
      menuWidth: 180,
      menuHeight: 200,
      viewport
    })).toEqual({ left: 812, top: 80 })
  })
})
