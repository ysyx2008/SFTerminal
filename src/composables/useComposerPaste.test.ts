import { describe, it, expect } from 'vitest'
import { planComposerPaste } from './useComposerPaste'

function mockPasteEvent(options: {
  plain?: string
  files?: File[]
  imageItems?: File[]
}): ClipboardEvent {
  const files = options.files ?? []
  const imageItems = options.imageItems ?? []
  const itemList = imageItems.map((file) => ({
    kind: 'file' as const,
    type: file.type,
    getAsFile: () => file
  }))

  return {
    clipboardData: {
      getData: (type: string) => (type === 'text/plain' ? (options.plain ?? '') : ''),
      files: Object.assign(files, { length: files.length, item: (i: number) => files[i] }),
      items: {
        length: itemList.length,
        [Symbol.iterator]: function* () {
          for (const item of itemList) yield item
        }
      }
    }
  } as unknown as ClipboardEvent
}

describe('planComposerPaste', () => {
  it('有实质纯文本时走默认粘贴（不挂附件）', () => {
    const png = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
    const plan = planComposerPaste(
      mockPasteEvent({ plain: 'hello from word', imageItems: [png] })
    )
    expect(plan).toEqual({ kind: 'default' })
  })

  it('纯空白文本视为无文本，可收图片', () => {
    const png = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
    const plan = planComposerPaste(mockPasteEvent({ plain: '  \n  ', imageItems: [png] }))
    expect(plan.kind).toBe('attachments')
    if (plan.kind === 'attachments') {
      expect(plan.files).toHaveLength(1)
    }
  })

  it('仅图片时收为附件', () => {
    const png = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })
    const plan = planComposerPaste(mockPasteEvent({ imageItems: [png] }))
    expect(plan.kind).toBe('attachments')
  })

  it('剪贴板 files 列表优先于 items', () => {
    const doc = new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' })
    const plan = planComposerPaste(mockPasteEvent({ files: [doc] }))
    expect(plan).toEqual({ kind: 'attachments', files: [doc] })
  })
})
