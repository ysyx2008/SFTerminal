import { describe, expect, it, vi } from 'vitest'
import type { CanvasArtifact } from '@shared/types'
import {
  artifactNeedsContentReload,
  loadArtifactContentFromDisk
} from '../domain/artifact-content-loader'

const baseArtifact = (overrides: Partial<CanvasArtifact> = {}): CanvasArtifact => ({
  id: 'file:/tmp/a.md',
  renderer: 'markdown',
  title: 'a.md',
  content: '',
  filePath: '/tmp/a.md',
  origin: 'agent',
  editable: true,
  contentFromFile: true,
  createdAt: 0,
  updatedAt: 0,
  ...overrides
})

describe('artifactNeedsContentReload', () => {
  it('有 filePath 且 content 为空时需要回填', () => {
    expect(artifactNeedsContentReload(baseArtifact())).toBe(true)
  })

  it('已有 content 时不需要回填', () => {
    expect(artifactNeedsContentReload(baseArtifact({ content: '# hi' }))).toBe(false)
  })

  it('无 filePath 时不需要回填', () => {
    expect(artifactNeedsContentReload(baseArtifact({ filePath: null, content: '' }))).toBe(false)
  })
})

describe('loadArtifactContentFromDisk', () => {
  it('markdown 优先走 previewArtifact', async () => {
    const previewArtifact = vi.fn().mockResolvedValue({ success: true, data: '# from preview' })
    const readFile = vi.fn()

    const data = await loadArtifactContentFromDisk(baseArtifact(), { previewArtifact, readFile })

    expect(data).toBe('# from preview')
    expect(previewArtifact).toHaveBeenCalledWith('/tmp/a.md', 'markdown')
    expect(readFile).not.toHaveBeenCalled()
  })

  it('preview 失败时 markdown 回退 readFile', async () => {
    const previewArtifact = vi.fn().mockResolvedValue({ success: false })
    const readFile = vi.fn().mockResolvedValue({ success: true, data: '# from disk' })

    const data = await loadArtifactContentFromDisk(baseArtifact(), { previewArtifact, readFile })

    expect(data).toBe('# from disk')
    expect(readFile).toHaveBeenCalledWith('/tmp/a.md')
  })

  it('document 仅走 previewArtifact', async () => {
    const previewArtifact = vi.fn().mockResolvedValue({ success: true, data: '<p>doc</p>' })
    const readFile = vi.fn()

    const data = await loadArtifactContentFromDisk(
      baseArtifact({ renderer: 'document', filePath: '/tmp/a.docx' }),
      { previewArtifact, readFile }
    )

    expect(data).toBe('<p>doc</p>')
    expect(readFile).not.toHaveBeenCalled()
  })
})
