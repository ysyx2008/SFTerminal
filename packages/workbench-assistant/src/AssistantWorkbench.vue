<script setup lang="ts">
/**
 * AssistantWorkbench —— 独立助手工作台（声明式区域，走通用 WorkbenchShell）
 *
 * 锚点区 = 聊天（AiPanel，常驻）；可隐区 = 产出物面板（ArtifactPanel，按需显隐）。
 * step→产出物接线在本岗挂载（useArtifactAgentBridge），对话壳不再认识 artifactStore。
 */
import { computed } from 'vue'
import type { WorkbenchRendererProps } from '@sailfish/workbench-sdk'
import { AiPanel } from '@sailfish/workbench-sdk/ai-panel'
import { WorkbenchShell } from '@sailfish/workbench-sdk/workbench-shell'
import { useAssistantArtifactStore } from './artifact/store'
import { useArtifactAgentBridge } from './artifact/composables/useArtifactAgentBridge'
import ArtifactPanel from './artifact/components/ArtifactPanel.vue'
import ArtifactPanelRail from './artifact/components/ArtifactPanelRail.vue'

const props = defineProps<WorkbenchRendererProps>()

const artifactStore = useAssistantArtifactStore()
useArtifactAgentBridge(() => props.tab.id)

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
      <AiPanel :tab-id="tab.id" :tab-active="isActive" />
    </template>
    <template #toggle>
      <ArtifactPanel v-if="docExpanded" :tab-id="tab.id" />
      <ArtifactPanelRail
        v-else-if="panelMinimized"
        :tab-id="tab.id"
        @expand="expandPanel"
      />
    </template>
  </WorkbenchShell>
</template>
