<script setup lang="ts">
/**
 * 只读状态条：面板向用户陈述「现在是什么情况」。
 *
 * 与设置行的区别在于它不可操作——没有右侧控件，用户读完可能需要去别处做事，
 * 但这一条本身只负责说清现状（上次异常退出过、已连接几台、还差一步没配完）。
 *
 * 默认不带颜色。带色版本要省着用：颜色一旦泛滥就不再意味着「这里要当心」，
 * 而且按规范，说不出具体后果、给不了用户可做之事的提示，本就不该写。
 */
withDefaults(
  defineProps<{
    tone?: 'neutral' | 'info' | 'success' | 'warn' | 'danger'
  }>(),
  { tone: 'neutral' }
)
</script>

<template>
  <div class="sf-notice" :class="`is-${tone}`">
    <slot />
  </div>
</template>

<style scoped>
.sf-notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-1) var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  font-size: var(--fs-desc);
  line-height: 1.5;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
}

/* 带色版本只改左侧标记与文字亮度，不整块染色——整块染色会盖过它旁边的设置项 */
.sf-notice.is-info,
.sf-notice.is-success,
.sf-notice.is-warn,
.sf-notice.is-danger {
  color: var(--text-primary);
  border-left: 3px solid currentColor;
}

.sf-notice.is-info {
  border-left-color: var(--color-info);
}

.sf-notice.is-success {
  border-left-color: var(--color-success);
}

.sf-notice.is-warn {
  border-left-color: var(--color-warning);
}

.sf-notice.is-danger {
  border-left-color: var(--color-error);
}
</style>
