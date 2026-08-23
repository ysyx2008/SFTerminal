<script setup lang="ts">
/**
 * 输入框：文字、数字、密码共用一套外观。
 *
 * 面板里十几个页面各写了一套输入框样式，高度、圆角、聚焦描边都不一样，
 * 同一个弹窗里前后两页看着像两个软件。
 */
withDefaults(
  defineProps<{
    modelValue: string | number
    type?: 'text' | 'number' | 'password'
    placeholder?: string
    disabled?: boolean
    min?: number
    max?: number
    /** 撑满可用宽度，用于上下排布的表单字段 */
    block?: boolean
    /** 定宽，用于数字这类内容很短的输入 */
    compact?: boolean
  }>(),
  { type: 'text', disabled: false, block: false, compact: false }
)

const emit = defineEmits<{ 'update:modelValue': [value: string | number] }>()

const onInput = (e: Event) => {
  const el = e.target as HTMLInputElement
  emit('update:modelValue', el.type === 'number' ? Number(el.value) : el.value)
}
</script>

<template>
  <input
    class="sf-input"
    :class="{ 'is-block': block, 'is-compact': compact }"
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :min="min"
    :max="max"
    @input="onInput"
  />
</template>

<style scoped>
.sf-input {
  min-width: 0;
  padding: var(--sp-2) var(--sp-3);
  font-family: inherit;
  font-size: var(--fs-desc);
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  outline: none;
  transition: border-color 0.15s ease;
}

.sf-input.is-block {
  width: 100%;
}

.sf-input.is-compact {
  width: 84px;
}

.sf-input::placeholder {
  color: var(--text-tertiary);
}

.sf-input:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent-primary) 50%, var(--border-color));
}

.sf-input:focus-visible {
  border-color: var(--accent-primary);
  outline: 2px solid color-mix(in srgb, var(--accent-primary) 35%, transparent);
  outline-offset: 0;
}

.sf-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
