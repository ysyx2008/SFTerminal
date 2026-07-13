<script setup lang="ts">
/**
 * CompanionWorkbench —— 联络（__companion__）工作台
 *
 * 联络的定位是「人 / 常驻关系线」，多渠道（IM/Gateway/桌面）汇入同一会话，
 * 不是「专注产出文件」的工作台。因此它只含聊天锚点区（AiPanel），
 * 不挂产出物面板、不走 WorkbenchShell 的可显隐辅助区。
 *
 * W6：组件物理在本包；AiPanel 仍依赖 desktop `@/`（P2 前）。
 */
import type { TerminalTab } from '@/stores/terminal'
import { AiPanel } from '@sailfish/workbench-sdk/ai-panel'

defineProps<{
  tab: TerminalTab
  isActive: boolean
}>()
</script>

<template>
  <div class="companion-workbench">
    <AiPanel :tab-id="tab.id" :tab-active="isActive" />
  </div>
</template>

<style scoped>
.companion-workbench {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}
</style>
