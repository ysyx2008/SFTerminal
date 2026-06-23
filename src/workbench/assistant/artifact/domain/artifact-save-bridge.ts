/**
 * 活跃 Renderer 向 ArtifactPanel 注册可编辑内容（如 Markdown draft）
 */
import { inject, provide, ref, type InjectionKey } from 'vue'

export interface ArtifactSaveHandler {
  getContent: () => string
  flushToStore?: () => void
  isDirty?: () => boolean
}

export interface ArtifactSaveBridge {
  register: (artifactId: string, handler: ArtifactSaveHandler) => void
  unregister: (artifactId: string) => void
  getHandler: (artifactId: string) => ArtifactSaveHandler | null
  flush: (artifactId: string) => void
  getContent: (artifactId: string, fallback: string) => string
  isDirty: (artifactId: string) => boolean
  setDirty: (artifactId: string, dirty: boolean) => void
  clearDirty: (artifactId: string) => void
}

const ARTIFACT_SAVE_BRIDGE_KEY: InjectionKey<ArtifactSaveBridge> = Symbol('artifact-save-bridge')

export function createArtifactSaveBridge(): ArtifactSaveBridge {
  const handlers = new Map<string, ArtifactSaveHandler>()
  const dirtyIds = ref(new Set<string>())

  function bumpDirty() {
    dirtyIds.value = new Set(dirtyIds.value)
  }

  return {
    register(artifactId, handler) {
      handlers.set(artifactId, handler)
    },
    unregister(artifactId) {
      handlers.delete(artifactId)
      dirtyIds.value.delete(artifactId)
      bumpDirty()
    },
    getHandler(artifactId) {
      return handlers.get(artifactId) ?? null
    },
    flush(artifactId) {
      handlers.get(artifactId)?.flushToStore?.()
    },
    getContent(artifactId, fallback) {
      return handlers.get(artifactId)?.getContent() ?? fallback
    },
    isDirty(artifactId) {
      void dirtyIds.value
      const handler = handlers.get(artifactId)
      if (handler?.isDirty) return handler.isDirty()
      return dirtyIds.value.has(artifactId)
    },
    setDirty(artifactId, dirty) {
      if (dirty) dirtyIds.value.add(artifactId)
      else dirtyIds.value.delete(artifactId)
      bumpDirty()
    },
    clearDirty(artifactId) {
      dirtyIds.value.delete(artifactId)
      bumpDirty()
    }
  }
}

export function provideArtifactSaveBridge(bridge: ArtifactSaveBridge): void {
  provide(ARTIFACT_SAVE_BRIDGE_KEY, bridge)
}

export function useArtifactSaveBridge(): ArtifactSaveBridge | null {
  return inject(ARTIFACT_SAVE_BRIDGE_KEY, null)
}
