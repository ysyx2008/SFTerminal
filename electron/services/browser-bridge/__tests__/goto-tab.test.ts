import { describe, expect, it } from 'vitest'
import { detectGotoTabOverwrite } from '../goto-tab'
import type { BrowserBridgeTabInfo } from '@shared/types/browser-bridge'

function tab(partial: Partial<BrowserBridgeTabInfo> & Pick<BrowserBridgeTabInfo, 'index' | 'url' | 'active'>): BrowserBridgeTabInfo {
  return {
    title: '',
    ...partial,
  }
}

describe('detectGotoTabOverwrite', () => {
  it('returns null when extension confirms new_tab', () => {
    const before = [tab({ index: 0, url: 'https://example.com/a', active: true, id: 1 })]
    const after = [
      tab({ index: 0, url: 'https://example.com/a', active: false, id: 1 }),
      tab({ index: 1, url: 'https://dianping.com', active: true, id: 2 }),
    ]
    expect(
      detectGotoTabOverwrite(before, after, 'https://dianping.com', { new_tab: true, url: 'https://dianping.com' }, true),
    ).toBeNull()
  })

  it('detects when previous active tab URL changed', () => {
    const before = [tab({ index: 0, url: 'https://example.com/work', active: true, id: 10 })]
    const after = [tab({ index: 0, url: 'https://dianping.com', active: true, id: 10 })]
    const msg = detectGotoTabOverwrite(
      before,
      after,
      'https://dianping.com',
      { new_tab: false, url: 'https://dianping.com' },
      true,
    )
    expect(msg).toContain('已覆盖')
    expect(msg).toContain('about:debugging')
  })

  it('detects stale extension without new_tab confirmation', () => {
    const before = [tab({ index: 0, url: 'https://example.com/work', active: true, id: 10 })]
    const after = [tab({ index: 0, url: 'https://www.dianping.com/', active: true, id: 10 })]
    const msg = detectGotoTabOverwrite(
      before,
      after,
      'https://www.dianping.com/',
      { url: 'https://www.dianping.com/' },
      true,
    )
    expect(msg).toMatch(/过旧|已覆盖/)
  })
})
