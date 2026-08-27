import { describe, it, expect } from 'vitest'
import { pendingImageToAttachment, type PendingImage } from './useImageUpload'

describe('pendingImageToAttachment', () => {
  it('没有路径则不生成附件', () => {
    const img: PendingImage = { id: '1', dataUrl: 'data:image/png;base64,xx', name: 'a.png', size: 12 }
    expect(pendingImageToAttachment(img)).toBeNull()
  })

  it('有路径则带上文件名与类型', () => {
    const img: PendingImage = {
      id: '1',
      dataUrl: 'data:image/png;base64,xx',
      name: 'shot.png',
      size: 24,
      filePath: '/tmp/history/images/pasted/shot.png',
    }
    expect(pendingImageToAttachment(img)).toEqual({
      filename: 'shot.png',
      filePath: '/tmp/history/images/pasted/shot.png',
      fileSize: 24,
      fileType: 'png',
    })
  })

  it('文件名无扩展名时用落盘路径的扩展名', () => {
    const img: PendingImage = {
      id: '1',
      dataUrl: 'data:image/png;base64,xx',
      name: 'pasted-image',
      size: 24,
      filePath: '/tmp/history/images/pasted/pasted-20260826-200000.png',
    }
    expect(pendingImageToAttachment(img)).toEqual({
      filename: 'pasted-20260826-200000.png',
      filePath: '/tmp/history/images/pasted/pasted-20260826-200000.png',
      fileSize: 24,
      fileType: 'png',
    })
  })
})
