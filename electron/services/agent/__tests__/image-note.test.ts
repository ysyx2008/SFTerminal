import { describe, it, expect, beforeAll } from 'vitest'
import { updateLocale } from '../i18n'
import { buildUserImageNote, collectImageAttachmentPaths } from '../image-note'

beforeAll(() => {
  updateLocale('zh-CN')
})

describe('collectImageAttachmentPaths', () => {
  it('只收带路径的图片附件', () => {
    expect(collectImageAttachmentPaths([
      { filename: 'a.png', filePath: '/tmp/a.png', fileSize: 10, fileType: 'png' },
      { filename: 'notes.pdf', filePath: '/tmp/notes.pdf', fileSize: 20, fileType: 'pdf' },
      { filename: 'orphan.png', fileSize: 10, fileType: 'png' },
    ])).toEqual(['/tmp/a.png'])
  })

  it('空附件返回空数组', () => {
    expect(collectImageAttachmentPaths()).toEqual([])
    expect(collectImageAttachmentPaths([])).toEqual([])
  })

  it('fileType 不像图但路径是图时仍收录', () => {
    expect(collectImageAttachmentPaths([
      { filename: 'pasted-image', filePath: '/tmp/history/images/pasted/pasted-1.png', fileSize: 10, fileType: 'pasted-image' },
    ])).toEqual(['/tmp/history/images/pasted/pasted-1.png'])
  })
})

describe('buildUserImageNote', () => {
  it('有视觉能力且有路径时写明磁盘位置', () => {
    const note = buildUserImageNote({
      count: 1,
      paths: ['/tmp/pasted/a.png'],
      visionAvailable: true,
    })
    expect(note).toContain('/tmp/pasted/a.png')
    expect(note).toContain('无需使用 read_file')
  })

  it('无路径时不提磁盘位置', () => {
    const note = buildUserImageNote({ count: 2, paths: [], visionAvailable: true })
    expect(note).toContain('2')
    expect(note).not.toContain('磁盘路径')
  })

  it('无视觉能力时仍告知路径', () => {
    const note = buildUserImageNote({
      count: 1,
      paths: ['/tmp/b.png'],
      visionAvailable: false,
    })
    expect(note).toContain('/tmp/b.png')
    expect(note).toContain('不具备视觉能力')
  })
})
