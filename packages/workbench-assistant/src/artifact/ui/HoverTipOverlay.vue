<script setup lang="ts">
/**
 * 产出物包内悬浮提示 UI。与 desktop `HoverTipOverlay.vue` 独立；样式用主题 token。
 */
import type { HoverTipState } from './useHoverTip'

defineProps<{
  tip: HoverTipState | null
}>()
</script>

<template>
  <Teleport to="body">
    <div
      v-if="tip"
      class="artifact-hover-tip"
      :class="`artifact-hover-tip--${tip.placement}`"
      :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
    >
      {{ tip.text }}
    </div>
  </Teleport>
</template>

<style scoped>
/* 使用 desktop 主题 token 名；值由宿主注入 */
.artifact-hover-tip {
  position: fixed;
  z-index: 10001;
  max-width: min(320px, calc(100vw - 24px));
  padding: 6px 10px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  background: var(--bg-secondary, #252525);
  color: var(--text-primary, #eee);
  font-size: 12px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
  animation: artifactHoverTipIn 0.12s ease;
}

@keyframes artifactHoverTipIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.artifact-hover-tip--left {
  transform: translate(-100%, -50%);
}

.artifact-hover-tip--top {
  transform: translate(-50%, -100%);
}

.artifact-hover-tip--bottom {
  transform: translate(-50%, 0);
}
</style>
