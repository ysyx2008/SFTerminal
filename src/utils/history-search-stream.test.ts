import { describe, it, expect } from 'vitest'
import { applySearchMatch, isCurrentSearchRequest } from './history-search-stream'

describe('history-search-stream', () => {
  it('过期 requestId 不接收命中', () => {
    expect(isCurrentSearchRequest('sidebar-2', 'sidebar-1')).toBe(false)
    expect(isCurrentSearchRequest('sidebar-2', 'sidebar-2')).toBe(true)
    expect(isCurrentSearchRequest('history-modal-3', 'sidebar-3')).toBe(false)
  })

  it('命中立刻追加，重复 id 不叠两条', () => {
    const first = applySearchMatch([], 0, { id: 'a', title: '周报' })
    expect(first.hits).toEqual([{ id: 'a', title: '周报' }])
    expect(first.liveCount).toBe(1)

    const second = applySearchMatch(first.hits, first.liveCount, { id: 'b', title: '部署' })
    expect(second.hits.map(h => h.id)).toEqual(['a', 'b'])
    expect(second.liveCount).toBe(2)

    const dup = applySearchMatch(second.hits, second.liveCount, { id: 'a', title: '周报改名' })
    expect(dup.hits).toHaveLength(2)
    expect(dup.hits[0]).toEqual({ id: 'a', title: '周报' })
    expect(dup.liveCount).toBe(2)
  })

  it('扫完回报的总数不低于已展示条数，展示过程中不把总数往回改小', () => {
    const afterHits = applySearchMatch([{ id: 'a' }], 8, { id: 'b' })
    expect(afterHits.liveCount).toBe(8)
    expect(afterHits.hits).toHaveLength(2)
  })
})
