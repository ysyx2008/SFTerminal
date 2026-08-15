// @vitest-environment jsdom
/**
 * 渲染器侧 content 回填：必须按 (tabId, artifactId, content) 写入，
 * 不能把正文当成 id（否则面板记录正常、预览却是空的）。
 */
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAssistantArtifactStore } from '../store'
import { useArtifactContentHydration } from '../composables/useArtifactContentHydration'

const FILE_PATH = '/tmp/hydration-a.md'
const ARTIFACT_ID = `file:${FILE_PATH}`
const DISK_CONTENT = '# from disk\n\n正文。'

function stubFsApis(data: string) {
  const previewArtifact = vi.fn().mockResolvedValue({ success: true, data })
  const readFile = vi.fn().mockResolvedValue({ success: true, data })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    localFs: { previewArtifact, readFile }
  }
  return { previewArtifact, readFile }
}

describe('useArtifactContentHydration', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  it('空 content 读盘后写入对应 artifact，而不是把正文当成 id', async () => {
    const store = useAssistantArtifactStore()
    store.open('tab-1', {
      renderer: 'markdown',
      title: 'a.md',
      content: '',
      filePath: FILE_PATH,
      contentFromFile: true
    })
    expect(store.getArtifactById('tab-1', ARTIFACT_ID)?.content).toBe('')

    stubFsApis(DISK_CONTENT)
    const scope = effectScope()
    scope.run(() => {
      useArtifactContentHydration('tab-1', () => ARTIFACT_ID)
    })

    await vi.waitFor(() => {
      expect(store.getArtifactById('tab-1', ARTIFACT_ID)?.content).toBe(DISK_CONTENT)
    })
    expect(store.getArtifactById('tab-1', DISK_CONTENT)).toBeNull()

    scope.stop()
    await nextTick()
  })

  it('首次读盘失败后会退避重试并回填', async () => {
    const store = useAssistantArtifactStore()
    store.open('tab-1', {
      renderer: 'markdown',
      title: 'a.md',
      content: '',
      filePath: FILE_PATH,
      contentFromFile: true
    })

    const previewArtifact = vi.fn()
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true, data: DISK_CONTENT })
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      localFs: { previewArtifact, readFile: vi.fn().mockResolvedValue({ success: false }) }
    }

    const scope = effectScope()
    scope.run(() => {
      useArtifactContentHydration('tab-1', () => ARTIFACT_ID)
    })

    await vi.waitFor(() => {
      expect(store.getArtifactById('tab-1', ARTIFACT_ID)?.content).toBe(DISK_CONTENT)
    })
    expect(previewArtifact).toHaveBeenCalledTimes(2)

    scope.stop()
    await nextTick()
  })
})
