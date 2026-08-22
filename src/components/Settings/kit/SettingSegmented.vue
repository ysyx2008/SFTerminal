<script setup lang="ts">
/**
 * 分段选择：在少量互斥选项之间切换。
 *
 * 按内容宽度收敛，不撑满整行——两个选项各占三百多像素是历史上常见的走形。
 * 收敛靠轨道自身 fit-content 即可，不给每段设最小宽度：那只会把短标签硬撑开、
 * 让本该紧凑的一小组档位显得松垮。
 *
 * 选项可标记为 danger：用于"选中即放弃一道保护"的档位（如全自动执行），
 * 选中时用警示色而非强调色，让代价一眼可见。
 */
withDefaults(
  defineProps<{
    modelValue: string
    options: ReadonlyArray<{
      value: string
      label: string
      title?: string
      tone?: 'default' | 'danger'
    }>
    disabled?: boolean
  }>(),
  { disabled: false }
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <div class="sf-segmented" role="radiogroup">
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="radio"
      class="sf-segment"
      :class="{ 'is-active': modelValue === opt.value, 'is-danger': opt.tone === 'danger' }"
      :aria-checked="modelValue === opt.value"
      :title="opt.title"
      :disabled="disabled"
      @click="emit('update:modelValue', opt.value)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>

<style scoped>
/* 轨道比卡片底更深，让整组档位读作一个凹槽；选中/悬停的那块再从槽里浮起来。
   少了这层深浅，控件会平得像一排文字。 */
.sf-segmented {
  display: flex;
  width: fit-content;
  gap: 2px;
  padding: 2px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

.sf-segment {
  flex: 0 0 auto;
  min-width: 76px;
  padding: var(--sp-1) var(--sp-3);
  font-family: inherit;
  font-size: var(--fs-desc);
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  /* 内圆角小于轨道，否则两层圆角同径会显得发胀 */
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.sf-segment:hover:not(:disabled):not(.is-active) {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.sf-segment.is-danger:hover:not(:disabled):not(.is-active) {
  background: color-mix(in srgb, var(--color-error) 15%, transparent);
  color: var(--color-error);
}

.sf-segment.is-active {
  background: var(--accent-primary);
  color: var(--accent-contrast);
}

.sf-segment.is-danger.is-active {
  background: var(--color-error);
  color: #fff;
}

.sf-segment:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.sf-segment:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 1px;
}
</style>
