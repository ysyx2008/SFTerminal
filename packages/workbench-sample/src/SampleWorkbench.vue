<script setup lang="ts">
/**
 * SampleWorkbench —— 业务台模板：同款对话（SDK AiPanel）+ 岗位可改 descriptor
 *
 * 外观不定制；差异靠 agentPrompt / skills / mcpServers。
 */
import type { TerminalTab } from '@/stores/terminal'
import { AiPanel } from '@sailfish/workbench-sdk/ai-panel'

defineProps<{
  tab: TerminalTab
  isActive: boolean
}>()
</script>

<template>
  <div class="sample-workbench">
    <AiPanel :tab-id="tab.id" :tab-active="isActive" />
  </div>
</template>

<style scoped>
.sample-workbench {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}
</style>
