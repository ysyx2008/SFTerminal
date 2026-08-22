<script setup lang="ts">
/**
 * 设置页根容器：只负责分组之间的纵向节奏。
 *
 * 内容限宽由 SettingsModal 统一施加于内容区的直接子元素，
 * 这样未迁移的页面同样受限，不必等迁移完成才有限宽。
 */
</script>

<template>
  <div class="sf-page">
    <slot />
  </div>
</template>

<style scoped>
.sf-page {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}
</style>
