import { describe, it, expect } from 'vitest'
import type { CanvasArtifact } from '@shared/types'
import {
  artifactHasFileActions,
  getArtifactContextMenuFlags
} from '../artifact-context-menu'

function artifact(overrides: Partial<CanvasArtifact>): CanvasArtifact {
  return {
    id: '1',
    renderer: 'markdown',
    title: 'a',
    content: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('artifact-context-menu', () => {
  it('Markdown 有 path、未 dirty 时不显示保存', () => {
    const flags = getArtifactContextMenuFlags(
      artifact({ filePath: '/tmp/a.md' }),
      2,
      { isDirty: false, fileExists: true }
    )
    expect(flags.showSave).toBe(false)
    expect(flags.showSaveAs).toBe(true)
    expect(flags.showOpen).toBe(true)
  })

  it('文件不存在时不显示打开', () => {
    const flags = getArtifactContextMenuFlags(
      artifact({ filePath: '/tmp/a.md' }),
      1,
      { isDirty: true, fileExists: false }
    )
    expect(flags.showOpen).toBe(false)
    expect(flags.showSave).toBe(false)
    expect(artifactHasFileActions(flags)).toBe(true)
  })
})
