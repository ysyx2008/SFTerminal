// @vitest-environment jsdom
/**
 * 助手改完已打开的 Word 后，预览必须从磁盘重建（即使面板里已有旧 HTML）。
 */
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAssistantArtifactStore } from '../store'

const FILE_PATH = '/tmp/preview-refresh.docx'
const ARTIFACT_ID = `file:${FILE_PATH}`
const OLD_HTML = '<p>以上意见请斟酌修改</p>'
const NEW_HTML = '<p>以上意见请予斟酌采纳</p>'

function stubFsApis(data: string, modifyTime?: number) {
  const previewArtifact = vi.fn().mockResolvedValue({ success: true, data })
  const exists = vi.fn().mockResolvedValue({ success: true, data: true })
  const stat = vi.fn().mockImplementation(async () => ({
    success: true,
    data: modifyTime == null ? null : { modifyTime }
  }))
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    localFs: { previewArtifact, readFile: vi.fn(), exists, stat }
  }
  return { previewArtifact, exists, stat }
}

describe('Word 预览在改盘后刷新', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  it('exec 改完磁盘后，已有预览 HTML 也会换成新内容', async () => {
    const store = useAssistantArtifactStore()
    store.open('tab-1', {
      renderer: 'document',
      title: '招标文件修改意见.docx',
      content: OLD_HTML,
      filePath: FILE_PATH
    })
    expect(store.getArtifactById('tab-1', ARTIFACT_ID)?.content).toBe(OLD_HTML)

    const { previewArtifact } = stubFsApis(NEW_HTML)
    store.handleAgentStep('tab-1', {
      type: 'tool_result',
      toolName: 'exec',
      content: 'saved'
    } as never)

    await vi.waitFor(() => {
      expect(store.getArtifactById('tab-1', ARTIFACT_ID)?.content).toBe(NEW_HTML)
    })
    expect(previewArtifact).toHaveBeenCalledWith(FILE_PATH, 'document')
  })

  it('word_save 写盘后同样重建预览', async () => {
    const store = useAssistantArtifactStore()
    store.open('tab-1', {
      renderer: 'document',
      title: 'a.docx',
      content: OLD_HTML,
      filePath: FILE_PATH
    })
    stubFsApis(NEW_HTML)
    store.handleAgentStep('tab-1', {
      type: 'tool_result',
      toolName: 'word_save',
      content: 'saved'
    } as never)

    await vi.waitFor(() => {
      expect(store.getArtifactById('tab-1', ARTIFACT_ID)?.content).toBe(NEW_HTML)
    })
  })

  it('文件没变时不把尚未保存的预览冲回旧文件', async () => {
    const store = useAssistantArtifactStore()
    const { previewArtifact } = stubFsApis(NEW_HTML, 1_000)
    store.open('tab-1', {
      renderer: 'document',
      title: 'a.docx',
      content: OLD_HTML,
      filePath: FILE_PATH
    })
    await Promise.resolve()
    await Promise.resolve()

    store.updateContent('tab-1', '<p>会话里已润色</p>', ARTIFACT_ID)
    store.handleAgentStep('tab-1', {
      type: 'tool_result',
      toolName: 'exec',
      content: 'ls'
    } as never)

    await Promise.resolve()
    await Promise.resolve()
    expect(store.getArtifactById('tab-1', ARTIFACT_ID)?.content).toBe('<p>会话里已润色</p>')
    expect(previewArtifact).not.toHaveBeenCalled()
  })

  it('未改盘的步骤不会重做预览', async () => {
    const store = useAssistantArtifactStore()
    store.open('tab-1', {
      renderer: 'document',
      title: 'a.docx',
      content: OLD_HTML,
      filePath: FILE_PATH
    })
    const { previewArtifact } = stubFsApis(NEW_HTML)
    store.handleAgentStep('tab-1', {
      type: 'thinking',
      content: '考虑中'
    } as never)

    await Promise.resolve()
    expect(store.getArtifactById('tab-1', ARTIFACT_ID)?.content).toBe(OLD_HTML)
    expect(previewArtifact).not.toHaveBeenCalled()
  })
})
