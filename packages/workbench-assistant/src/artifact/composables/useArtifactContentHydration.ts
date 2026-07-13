/**
 * 渲染器侧兜底：store 读盘回填失败或组件晚挂载时，按 filePath 再次尝试加载 content
 */
import { computed, ref, watch, type Ref } from 'vue'
import { useAssistantArtifactStore } from '../store'
import {
  artifactNeedsContentReload,
  loadArtifactContentFromDisk
} from '../domain/artifact-content-loader'

export function useArtifactContentHydration(
  tabId: string,
  artifactId: Ref<string> | (() => string)
) {
  const artifactStore = useAssistantArtifactStore()
  const loadingFromDisk = ref(false)

  const resolvedArtifactId = computed(() =>
    typeof artifactId === 'function' ? artifactId() : artifactId.value
  )

  const artifact = computed(() =>
    artifactStore.getArtifactById(tabId, resolvedArtifactId.value)
  )

  async function ensureContentLoaded() {
    const art = artifact.value
    if (!art || !artifactNeedsContentReload(art)) return

    const previewApi = window.electronAPI?.localFs?.previewArtifact
    const readApi = window.electronAPI?.localFs?.readFile
    if (!previewApi && !readApi) return

    loadingFromDisk.value = true
    try {
      const data = await loadArtifactContentFromDisk(art, {
        previewArtifact: previewApi,
        readFile: readApi
      })
      if (data) {
        artifactStore.updateContent(tabId, data, art.id)
      }
    } finally {
      loadingFromDisk.value = false
    }
  }

  watch(
    () => [artifact.value?.content, artifact.value?.filePath, resolvedArtifactId.value] as const,
    () => { void ensureContentLoaded() },
    { immediate: true }
  )

  return { loadingFromDisk, ensureContentLoaded }
}
