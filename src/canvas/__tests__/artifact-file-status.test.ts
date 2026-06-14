/**
 * artifact-file-status 单元测试
 */
import { describe, it, expect } from 'vitest'
import type { CanvasArtifact } from '@shared/types'
import { findArtifactIdsWithMissingFiles } from '../artifact-file-status'

function artifact(id: string, filePath?: string): CanvasArtifact {
  return {
    id,
    renderer: 'markdown',
    title: id,
    content: '',
    filePath: filePath ?? null,
    origin: 'agent',
    editable: true,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('findArtifactIdsWithMissingFiles', () => {
  it('返回磁盘已不存在的 artifact id', () => {
    const map = new Map([
      ['/tmp/a.md', true],
      ['/tmp/b.md', false]
    ])
    const ids = findArtifactIdsWithMissingFiles(
      [artifact('a', '/tmp/a.md'), artifact('b', '/tmp/b.md'), artifact('c')],
      map
    )
    expect(ids).toEqual(['b'])
  })

  it('未检测到的 path 不移除', () => {
    const map = new Map<string, boolean>()
    const ids = findArtifactIdsWithMissingFiles([artifact('a', '/tmp/x.md')], map)
    expect(ids).toEqual([])
  })
})
