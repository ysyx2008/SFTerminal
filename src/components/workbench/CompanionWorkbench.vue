<script setup lang="ts">
/**
 * CompanionWorkbench —— 联络（__companion__）工作台
 *
 * 联络的定位是「人 / 常驻关系线」，多渠道（IM/Gateway/桌面）汇入同一会话，
 * 不是「专注产出文件」的工作台。因此它只含聊天锚点区（AiPanel），
 * 不挂产出物面板、不走 WorkbenchShell 的可显隐辅助区。
 *
 * 与 assistant 工作台平级（kind='companion'），契约见 src/workbench/companion/SPEC.md。
 * 统一渲染器 props 约定：{ tab, isActive }。
 */
import type { TerminalTab } from '../../stores/terminal'
import AiPanel from '../AiPanel.vue'

defineProps<{
  tab: TerminalTab
  isActive: boolean
}>()
</script>

<template>
  <!-- 单根容器：吸收 App.vue 透传的 class（AiPanel 是多根 fragment，class 无法直接继承） -->
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
