/**
 * 全文搜索流式展示：过期请求过滤 + 命中即追加。
 * 侧栏与历史弹窗共用，避免换词后旧扫描结果混进新列表。
 */

export function isCurrentSearchRequest(activeRequestId: string, incomingRequestId: string): boolean {
  return activeRequestId === incomingRequestId
}

export function applySearchMatch<T extends { id: string }>(
  hits: readonly T[],
  liveCount: number,
  hit: T
): { hits: T[]; liveCount: number } {
  if (hits.some(h => h.id === hit.id)) {
    return { hits: hits as T[], liveCount }
  }
  const next = [...hits, hit]
  return { hits: next, liveCount: Math.max(liveCount, next.length) }
}
