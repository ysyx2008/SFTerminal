<script setup lang="ts">
/**
 * AssistantWorkbench —— 独立助手工作台（声明式区域，走通用 WorkbenchShell）
 *
 * 锚点区 = 聊天（AiPanel，常驻）；可隐区 = 产出物面板（ArtifactPanel，按需显隐）。
 * 由 Agent step 的 canvasData 驱动 artifactStore 注册/更新产出物。
 *
 * 统一渲染器 props 约定：{ tab, isActive }。
 */
import { computed } from 'vue'
import type { TerminalTab } from '../../stores/terminal'
import { useAssistantArtifactStore } from '../../workbench/assistant/artifact/store'
import WorkbenchShell from './WorkbenchShell.vue'
import AiPanel from '../AiPanel.vue'
import ArtifactPanel from '../../workbench/assistant/artifact/components/ArtifactPanel.vue'
import ArtifactPanelRail from '../../workbench/assistant/artifact/components/ArtifactPanelRail.vue'

const props = defineProps<{
  tab: TerminalTab
  isActive: boolean
}>()

const artifactStore = useAssistantArtifactStore()

const docVisible = computed(() => artifactStore.isVisible(props.tab.id))
const panelMinimized = computed(() => artifactStore.isPanelMinimized(props.tab.id))
const ratio = computed({
  get: () => artifactStore.splitRatio,
  set: (v: number) => { artifactStore.splitRatio = v },
})

function expandPanel() {
  artifactStore.expandPanel(props.tab.id)
}
</script>

<template>
  <WorkbenchShell
    :toggle-visible="docVisible"
    v-model:toggle-ratio="ratio"
    toggle-side="right"
  >
    <template #anchor>
      <div class="assistant-anchor-wrap" :class="{ 'assistant-anchor-wrap--rail': panelMinimized }">
        <AiPanel :tab-id="tab.id" :tab-active="isActive" />
        <ArtifactPanelRail
          v-if="panelMinimized"
          :tab-id="tab.id"
          @expand="expandPanel"
        />
      </div>
    </template>
    <template #toggle>
      <ArtifactPanel v-if="docVisible" :tab-id="tab.id" />
    </template>
  </WorkbenchShell>
</template>

<style scoped>
.assistant-anchor-wrap {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.assistant-anchor-wrap--rail {
  padding-right: 28px;
}
</style>
