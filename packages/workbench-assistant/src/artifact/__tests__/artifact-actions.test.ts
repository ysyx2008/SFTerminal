/**
 * artifact-actions 单元测试
 */
import { describe, it, expect, vi } from 'vitest'
import type { CanvasArtifact } from '@shared/types'
import {
  artifactBasename,
  artifactDisplayLabel,
  canSaveArtifact,
  canSaveAsArtifact,
  defaultSaveFileName,
  saveAllArtifacts,
  saveArtifact,
  saveArtifactAs
} from '../domain/artifact-actions'

function artifact(
  overrides: Partial<CanvasArtifact> & Pick<CanvasArtifact, 'id' | 'renderer'>
): CanvasArtifact {
  return {
    title: 'test',
    content: 'body',
    origin: 'agent',
    editable: overrides.renderer === 'markdown',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('artifact-actions', () => {
  it('artifactBasename 取文件名', () => {
    expect(artifactBasename('/tmp/report.docx')).toBe('report.docx')
    expect(artifactBasename('C:\\docs\\a.md')).toBe('a.md')
  })

  it('defaultSaveFileName 标题优先，扩展名取自物理文件', () => {
    expect(
      defaultSaveFileName({
        title: '数据榜单',
        filePath: '/tmp/data_2026-08-04_9a5d7c3e.xlsx',
        renderer: 'spreadsheet'
      })
    ).toBe('数据榜单.xlsx')
    // 无标题时退化为物理文件名
    expect(
      defaultSaveFileName({ title: '', filePath: '/tmp/data.xlsx', renderer: 'spreadsheet' })
    ).toBe('data.xlsx')
    // 标题已带扩展名时不重复追加
    expect(
      defaultSaveFileName({ title: 'data.xlsx', filePath: '/tmp/data.xlsx', renderer: 'spreadsheet' })
    ).toBe('data.xlsx')
  })

  it('artifactDisplayLabel 标题优先，无标题时退化为文件名', () => {
    expect(
      artifactDisplayLabel({
        title: '华云信息介绍',
        filePath: '/Users/yushen/Desktop/华云信息介绍_2026-08-04_9a5d7c3e.md'
      })
    ).toBe('华云信息介绍')
    expect(
      artifactDisplayLabel({ title: '', filePath: '/Users/yushen/Desktop/华云信息介绍.md' })
    ).toBe('华云信息介绍.md')
    expect(artifactDisplayLabel({ title: '仅标题', filePath: null })).toBe('仅标题')
  })

  it('canSave 仅 markdown 且有 path', () => {
    expect(canSaveArtifact(artifact({ id: '1', renderer: 'markdown', filePath: '/a.md' }))).toBe(true)
    expect(canSaveArtifact(artifact({ id: '2', renderer: 'markdown' }))).toBe(false)
    expect(canSaveArtifact(artifact({ id: '3', renderer: 'document', filePath: '/a.docx' }))).toBe(false)
  })

  it('canSaveAs markdown 任意；其它需 path', () => {
    expect(canSaveAsArtifact(artifact({ id: '1', renderer: 'markdown' }))).toBe(true)
    expect(canSaveAsArtifact(artifact({ id: '2', renderer: 'document', filePath: '/a.docx' }))).toBe(true)
    expect(canSaveAsArtifact(artifact({ id: '3', renderer: 'document' }))).toBe(false)
  })

  it('saveArtifact 写入 markdown', async () => {
    const writeFile = vi.fn().mockResolvedValue({ success: true })
    const a = artifact({ id: '1', renderer: 'markdown', filePath: '/tmp/n.md', content: 'old' })
    const res = await saveArtifact(a, {
      writeFile,
      copyFile: vi.fn(),
      selectSavePath: vi.fn(),
      getContent: () => 'new content'
    })
    expect(res.ok).toBe(true)
    expect(writeFile).toHaveBeenCalledWith('/tmp/n.md', 'new content')
  })

  it('saveArtifactAs 取消对话框', async () => {
    const a = artifact({ id: '1', renderer: 'markdown' })
    const res = await saveArtifactAs(a, {
      writeFile: vi.fn(),
      copyFile: vi.fn(),
      selectSavePath: vi.fn().mockResolvedValue({ canceled: true, path: '' }),
      getContent: () => 'x'
    })
    expect(res.ok).toBe(false)
    expect(res.canceled).toBe(true)
  })

  it('saveAllArtifacts 只保存可覆盖的 markdown', async () => {
    const writeFile = vi.fn().mockResolvedValue({ success: true })
    const list = [
      artifact({ id: '1', renderer: 'markdown', filePath: '/a.md' }),
      artifact({ id: '2', renderer: 'document', filePath: '/b.docx' }),
      artifact({ id: '3', renderer: 'markdown' })
    ]
    const result = await saveAllArtifacts(list, {
      writeFile,
      copyFile: vi.fn(),
      selectSavePath: vi.fn(),
      getContent: () => 'content'
    })
    expect(result.saved).toBe(1)
    expect(result.failed).toBe(0)
    expect(writeFile).toHaveBeenCalledTimes(1)
  })
})
