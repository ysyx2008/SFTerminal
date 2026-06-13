/**
 * artifact-tab-layout 单元测试
 */
import { describe, it, expect } from 'vitest'
import type { CanvasArtifact } from '@shared/types'
import {
  ARTIFACT_VISIBLE_TAB_MAX,
  filterArtifactsByQuery,
  pickVisibleArtifactTabs,
  sortArtifactsByRecent
} from '../../canvas/artifact-tab-layout'

function artifact(id: string, title: string, updatedAt: number): CanvasArtifact {
  return {
    id,
    renderer: 'markdown',
    title,
    content: '',
    createdAt: updatedAt,
    updatedAt
  }
}

describe('artifact-tab-layout', () => {
  it('数量不超过上限时全部可见', () => {
    const list = [artifact('a', 'a', 1), artifact('b', 'b', 2)]
    const { visible, overflowCount } = pickVisibleArtifactTabs(list, 'a')
    expect(visible).toHaveLength(2)
    expect(overflowCount).toBe(0)
  })

  it('超出上限时保留 active 并补最近更新项', () => {
    const list = [
      artifact('old', 'old', 1),
      artifact('mid', 'mid', 5),
      artifact('new', 'new', 10),
      artifact('active-old', 'active', 2),
      artifact('extra', 'extra', 8)
    ]
    const { visible, overflowCount } = pickVisibleArtifactTabs(list, 'active-old', 4)
    expect(visible.map(a => a.id)).toContain('active-old')
    expect(visible).toHaveLength(4)
    expect(overflowCount).toBe(1)
  })

  it('按 updatedAt 降序排序', () => {
    const list = [artifact('a', 'a', 1), artifact('b', 'b', 3), artifact('c', 'c', 2)]
    expect(sortArtifactsByRecent(list).map(a => a.id)).toEqual(['b', 'c', 'a'])
  })

  it('搜索匹配标题或路径', () => {
    const list = [
      { ...artifact('1', 'report', 1), filePath: '/tmp/report.docx' },
      { ...artifact('2', 'data', 2), filePath: '/tmp/sheet.xlsx' }
    ]
    expect(filterArtifactsByQuery(list, 'xlsx').map(a => a.id)).toEqual(['2'])
    expect(filterArtifactsByQuery(list, 'report').map(a => a.id)).toEqual(['1'])
  })

  it('默认可见 tab 上限为 4', () => {
    expect(ARTIFACT_VISIBLE_TAB_MAX).toBe(4)
  })
})
