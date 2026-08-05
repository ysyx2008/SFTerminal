<script setup lang="ts">
/**
 * AssistantWorkbench —— 独立助手工作台（声明式区域，走通用 WorkbenchShell）
 *
 * 锚点区 = 聊天（AiPanel，常驻）；可隐区 = 产出物面板（ArtifactPanel，按需显隐）。
 * step→产出物接线在本岗挂载（useArtifactAgentBridge）。
 * 「跳到生成处」/「引用到 Composer」经 AiPanel defineExpose，由本壳持 ref 转发。
 * Markdown 选区作用域：发送前经 consumeSelectionScope 静默附带，不进引用胶囊。
 */
import { computed, ref } from 'vue'
import type { WorkbenchRendererProps } from '@sailfish/workbench-sdk'
import { AiPanel } from '@sailfish/workbench-sdk/ai-panel'
import { WorkbenchShell } from '@sailfish/workbench-sdk/workbench-shell'
import type { ArtifactComposerQuote } from './artifact/composer-quote'
import { consumeSelectionScope } from './artifact/selection-scope'
import type { WorkbenchContext } from '@shared/types'
import { useAssistantArtifactStore } from './artifact/store'
import { useArtifactAgentBridge } from './artifact/composables/useArtifactAgentBridge'
import ArtifactPanel from './artifact/components/ArtifactPanel.vue'
import ArtifactPanelRail from './artifact/components/ArtifactPanelRail.vue'

const props = defineProps<WorkbenchRendererProps>()

const artifactStore = useAssistantArtifactStore()
useArtifactAgentBridge(() => props.tab.id)

/** AiPanel 对外接口（defineExpose） */
const aiPanelRef = ref<{
  scrollToAgentStep: (stepId: string) => void | Promise<void>
  addComposerQuote: (snippet: ArtifactComposerQuote) => void
  addComposerImage: (image: { dataUrl: string; name: string; width?: number; height?: number }) => void
  setComposerDraft: (text: string) => void
} | null>(null)

function scrollToAgentStep(stepId: string) {
  void aiPanelRef.value?.scrollToAgentStep(stepId)
}

function addComposerQuote(snippet: ArtifactComposerQuote) {
  aiPanelRef.value?.addComposerQuote(snippet)
}

function addComposerImage(image: { dataUrl: string; name: string; width?: number; height?: number }) {
  aiPanelRef.value?.addComposerImage(image)
}

function setComposerDraft(text: string) {
  aiPanelRef.value?.setComposerDraft(text)
}

/** 发送时静默取出 Markdown 选区作用域（取出即清除 sticky；不上聊天气泡） */
function consumeWorkbenchContext(): WorkbenchContext | undefined {
  const scope = consumeSelectionScope(props.tab.id)
  if (!scope?.excerpt.trim()) return undefined
  return {
    selectionScope: {
      label: scope.label,
      sourcePath: scope.sourcePath,
      sourceLinesAccurate: scope.sourceLinesAccurate,
      startLine: scope.startLine,
      endLine: scope.endLine,
      excerpt: scope.excerpt
    }
  }
}

const docExpanded = computed(() => artifactStore.isVisible(props.tab.id))
const panelMinimized = computed(() => artifactStore.isPanelMinimized(props.tab.id))
const toggleVisible = computed(() => docExpanded.value || panelMinimized.value)
const ratio = computed({
  get: () => artifactStore.splitRatio,
  set: (v: number) => { artifactStore.splitRatio = v },
})

function expandPanel(artifactId?: string) {
  artifactStore.expandPanel(props.tab.id)
  if (artifactId) {
    artifactStore.setActiveArtifact(props.tab.id, artifactId)
  }
}
</script>

<template>
  <WorkbenchShell
    :toggle-visible="toggleVisible"
    :toggle-collapsed="panelMinimized"
    v-model:toggle-ratio="ratio"
    toggle-side="right"
  >
    <template #anchor>
      <AiPanel
        ref="aiPanelRef"
        :tab-id="tab.id"
        :tab-active="isActive"
        :consume-workbench-context="consumeWorkbenchContext"
      />
    </template>
    <template #toggle>
      <ArtifactPanel
        v-if="docExpanded"
        :tab-id="tab.id"
        :scroll-to-agent-step="scrollToAgentStep"
        :add-composer-quote="addComposerQuote"
        :add-composer-image="addComposerImage"
        :set-composer-draft="setComposerDraft"
      />
      <ArtifactPanelRail
        v-else-if="panelMinimized"
        :tab-id="tab.id"
        @expand="expandPanel"
      />
    </template>
  </WorkbenchShell>
</template>
