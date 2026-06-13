<script setup lang="ts">
/**
 * AssistantWorkbench —— 独立助手工作台（声明式区域，走通用 WorkbenchShell）
 *
 * 锚点区 = 聊天（AiPanel，常驻）；可隐区 = Artifact 面板（CanvasPanel，按需显隐）。
 * 由 Agent step 的 canvasData 驱动 canvasStore 注册/更新产出物。
 *
 * 统一渲染器 props 约定：{ tab, isActive }。
 */
import { computed } from 'vue'
import type { TerminalTab } from '../../stores/terminal'
import { useCanvasStore } from '../../stores/canvas'
import WorkbenchShell from './WorkbenchShell.vue'
import AiPanel from '../AiPanel.vue'
import CanvasPanel from '../Canvas/CanvasPanel.vue'

const props = defineProps<{
  tab: TerminalTab
  isActive: boolean
}>()

const canvasStore = useCanvasStore()

const docVisible = computed(() => canvasStore.isVisible(props.tab.id))
const ratio = computed({
  get: () => canvasStore.splitRatio,
  set: (v: number) => { canvasStore.splitRatio = v },
})
</script>

<template>
  <WorkbenchShell
    :toggle-visible="docVisible"
    v-model:toggle-ratio="ratio"
    toggle-side="right"
  >
    <template #anchor>
      <AiPanel :tab-id="tab.id" :tab-active="isActive" />
    </template>
    <template #toggle>
      <CanvasPanel v-if="docVisible" :tab-id="tab.id" />
    </template>
  </WorkbenchShell>
</template>
