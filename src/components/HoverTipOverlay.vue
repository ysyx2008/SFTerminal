<script setup lang="ts">
import type { HoverTipState } from '../composables/useHoverTip'

defineProps<{
  tip: HoverTipState | null
}>()
</script>

<template>
  <Teleport to="body">
    <div
      v-if="tip"
      class="hover-tip-floating"
      :class="[`hover-tip-floating--${tip.placement}`, { 'hover-tip-floating--wrap': tip.wrap }]"
      :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
    >
      {{ tip.text }}
    </div>
  </Teleport>
</template>
