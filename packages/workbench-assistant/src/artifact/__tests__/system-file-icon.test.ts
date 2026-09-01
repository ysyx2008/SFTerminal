import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadSystemFileIconUrl,
  resetSystemFileIconCacheForTests,
  resolveSystemFileIconCacheKey,
} from '../system-file-icon'

function stubGetFileIcon(impl: (filePath: string) => Promise<{ success: boolean; dataUrl?: string }>) {
  const getFileIcon = vi.fn(impl)
  ;(globalThis as { window?: unknown }).window = {
    electronAPI: { localFs: { getFileIcon } },
  }
  return getFileIcon
}

afterEach(() => {
  resetSystemFileIconCacheForTests()
  delete (globalThis as { window?: unknown }).window
})

describe('resolveSystemFileIconCacheKey', () => {
  it('uses explicit cacheKey, otherwise file extension', () => {
    expect(resolveSystemFileIconCacheKey('/tmp/a.xlsx')).toBe('xlsx')
    expect(resolveSystemFileIconCacheKey('/tmp/a.xlsx', 'pdf')).toBe('pdf')
  })
})

describe('loadSystemFileIconUrl', () => {
  it('does not call native icon API without a disk path', async () => {
    const getFileIcon = stubGetFileIcon(async () => ({ success: true, dataUrl: 'data:image/png;base64,xx' }))
    await expect(loadSystemFileIconUrl({ cacheKey: 'xlsx' })).resolves.toBeNull()
    expect(getFileIcon).not.toHaveBeenCalled()
  })

  it('caches a successful lookup by extension', async () => {
    const getFileIcon = stubGetFileIcon(async () => ({ success: true, dataUrl: 'data:image/png;base64,aa' }))
    const first = await loadSystemFileIconUrl({ filePath: '/tmp/one.xlsx' })
    const second = await loadSystemFileIconUrl({ filePath: '/other/two.xlsx' })
    expect(first).toBe('data:image/png;base64,aa')
    expect(second).toBe('data:image/png;base64,aa')
    expect(getFileIcon).toHaveBeenCalledTimes(1)
  })

  it('caches a failed lookup so it does not retry', async () => {
    const getFileIcon = stubGetFileIcon(async () => ({ success: false }))
    await expect(loadSystemFileIconUrl({ filePath: '/tmp/missing.xlsx' })).resolves.toBeNull()
    await expect(loadSystemFileIconUrl({ filePath: '/tmp/other.xlsx' })).resolves.toBeNull()
    expect(getFileIcon).toHaveBeenCalledTimes(1)
  })

  it('dedupes in-flight requests for the same cache key', async () => {
    let release!: (value: { success: boolean; dataUrl?: string }) => void
    const pending = new Promise<{ success: boolean; dataUrl?: string }>((resolve) => {
      release = resolve
    })
    const getFileIcon = stubGetFileIcon(() => pending)
    const a = loadSystemFileIconUrl({ filePath: '/tmp/a.xlsx' })
    const b = loadSystemFileIconUrl({ filePath: '/tmp/b.xlsx' })
    release({ success: true, dataUrl: 'data:image/png;base64,bb' })
    await expect(Promise.all([a, b])).resolves.toEqual([
      'data:image/png;base64,bb',
      'data:image/png;base64,bb',
    ])
    expect(getFileIcon).toHaveBeenCalledTimes(1)
  })
})
