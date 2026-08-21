import { describe, expect, it } from 'vitest'
import {
  WEBVIEW_ZOOM_DEFAULT,
  clampWebviewZoom,
  formatWebviewZoomPercent,
  stepWebviewZoom
} from '../domain/webview-zoom'

describe('webview-zoom', () => {
  it('clampWebviewZoom 限制在 50%–200%，并按 10% 取整', () => {
    expect(clampWebviewZoom(1)).toBe(1)
    expect(clampWebviewZoom(1.14)).toBe(1.1)
    expect(clampWebviewZoom(0.2)).toBe(0.5)
    expect(clampWebviewZoom(3)).toBe(2)
    expect(clampWebviewZoom(Number.NaN)).toBe(WEBVIEW_ZOOM_DEFAULT)
  })

  it('stepWebviewZoom 按步进放大缩小，到边界停住', () => {
    expect(stepWebviewZoom(1, 1)).toBe(1.1)
    expect(stepWebviewZoom(1, -1)).toBe(0.9)
    expect(stepWebviewZoom(0.5, -1)).toBe(0.5)
    expect(stepWebviewZoom(2, 1)).toBe(2)
  })

  it('formatWebviewZoomPercent 显示整数百分比', () => {
    expect(formatWebviewZoomPercent(1)).toBe('100%')
    expect(formatWebviewZoomPercent(1.5)).toBe('150%')
    expect(formatWebviewZoomPercent(0.5)).toBe('50%')
  })
})
