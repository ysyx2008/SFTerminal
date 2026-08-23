<script setup lang="ts">
/**
 * 下拉选择：选项较多、不适合摊成一排档位时用。
 *
 * 面板里此前有九处各写各的下拉，宽窄、圆角、聚焦表现都不一样。
 * 选项少于四个且文字短的，优先用分段选择——一眼能看全比点开再看好。
 */
withDefaults(
  defineProps<{
    modelValue: string
    options: ReadonlyArray<{ value: string; label: string }>
    disabled?: boolean
    /** 撑满可用宽度，用于上下排布的表单字段 */
    block?: boolean
  }>(),
  { disabled: false, block: false }
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <select
    class="sf-select"
    :class="{ 'is-block': block }"
    :value="modelValue"
    :disabled="disabled"
    @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option v-for="opt in options" :key="opt.value" :value="opt.value">
      {{ opt.label }}
    </option>
  </select>
</template>

<style scoped>
.sf-select {
  min-width: 120px;
  padding: var(--sp-1) var(--sp-2);
  font-family: inherit;
  font-size: var(--fs-desc);
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  outline: none;
  transition: border-color 0.15s ease;
}

.sf-select.is-block {
  width: 100%;
}

.sf-select:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent-primary) 50%, var(--border-color));
}

.sf-select:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 1px;
}

.sf-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
