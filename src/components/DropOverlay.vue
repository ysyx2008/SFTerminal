<script setup lang="ts">
defineProps<{
  title: string
  hint?: string
  compact?: boolean
}>()
</script>

<template>
  <div class="drop-overlay" :class="{ compact }">
    <div class="drop-content">
      <slot name="icon" />
      <p>{{ title }}</p>
      <span v-if="hint" class="drop-hint">{{ hint }}</span>
    </div>
  </div>
</template>

<style scoped>
.drop-overlay {
  position: absolute;
  inset: 0;
  background: rgba(var(--accent-rgb), 0.15);
  backdrop-filter: blur(4px);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 3px dashed var(--accent-primary);
  border-radius: 8px;
  animation: dropOverlayFadeIn 0.2s ease;
  pointer-events: none;
}

.drop-overlay.compact {
  border-width: 2px;
  border-radius: 6px;
}

@keyframes dropOverlayFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.drop-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--accent-primary);
  text-align: center;
  padding: 24px;
  background: var(--bg-primary);
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

.compact .drop-content {
  flex-direction: row;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 8px;
}

.drop-content :slotted(svg) {
  animation: dropIconBounce 0.5s ease infinite alternate;
  flex-shrink: 0;
}

.compact .drop-content :slotted(svg) {
  animation: none;
}

@keyframes dropIconBounce {
  from { transform: translateY(0); }
  to { transform: translateY(-8px); }
}

.drop-content p {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.compact .drop-content p {
  font-size: 12px;
  font-weight: 500;
}

.drop-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.compact .drop-hint {
  display: none;
}
</style>
