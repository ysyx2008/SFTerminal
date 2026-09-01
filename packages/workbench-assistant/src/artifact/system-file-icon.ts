/**
 * 系统文件图标的唯一取图入口。产出物和聊天附件都走这里。
 * 按 cacheKey（默认文件扩展名）缓存成功与失败，没有磁盘路径就不请求。
 */

const iconUrlCache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

function extFromPath(filePath?: string | null): string {
  if (!filePath) return ''
  const base = filePath.replace(/\\/g, '/').split('/').pop() || filePath
  const idx = base.lastIndexOf('.')
  if (idx <= 0 || idx === base.length - 1) return ''
  return base.slice(idx + 1).toLowerCase()
}

export function resolveSystemFileIconCacheKey(
  filePath?: string | null,
  cacheKey?: string,
): string {
  return (cacheKey || extFromPath(filePath)).trim()
}

export async function loadSystemFileIconUrl(options: {
  filePath?: string | null
  cacheKey?: string
}): Promise<string | null> {
  const key = resolveSystemFileIconCacheKey(options.filePath, options.cacheKey)
  if (key && iconUrlCache.has(key)) return iconUrlCache.get(key) ?? null

  const path = options.filePath
  if (!path) return null
  if (key && inflight.has(key)) return inflight.get(key)!

  const request = (async () => {
    try {
      const res = await window.electronAPI?.localFs?.getFileIcon?.(path)
      const url = res?.success && res.dataUrl ? res.dataUrl : null
      if (key) iconUrlCache.set(key, url)
      return url
    } catch {
      if (key) iconUrlCache.set(key, null)
      return null
    } finally {
      if (key) inflight.delete(key)
    }
  })()

  if (key) inflight.set(key, request)
  return request
}

/** 仅测试用 */
export function resetSystemFileIconCacheForTests(): void {
  iconUrlCache.clear()
  inflight.clear()
}
