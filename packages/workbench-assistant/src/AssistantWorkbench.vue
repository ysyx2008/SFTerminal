<script setup lang="ts">
/**
 * AssistantWorkbench —— 独立助手工作台（声明式区域，走通用 WorkbenchShell）
 *
 * 锚点区 = 聊天（AiPanel，常驻）；可隐区 = 产出物面板（ArtifactPanel，按需显隐）。
 * 由 Agent step 的 canvasData 驱动 artifactStore 注册/更新产出物。
 *
 * 统一渲染器 props 约定：{ tab, isActive }。
 *
 * W3：组件物理在本包；AiPanel / artifact / store 仍依赖 desktop `@/`（P2 前过渡）。
 */
import { computed } from 'vue'
import type { TerminalTab } from '@/stores/terminal'
import { useAssistantArtifactStore } from '@/workbench/assistant/artifact/store'
import WorkbenchShell from '@/components/workbench/WorkbenchShell.vue'
import AiPanel from '@/components/AiPanel.vue'
import ArtifactPanel from '@/workbench/assistant/artifact/components/ArtifactPanel.vue'
import ArtifactPanelRail from '@/workbench/assistant/artifact/components/ArtifactPanelRail.vue'

const props = defineProps<{
  tab: TerminalTab
  isActive: boolean
}>()

const artifactStore = useAssistantArtifactStore()

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
