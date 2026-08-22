<script setup lang="ts">
/**
 * 开关。
 *
 * 刻意不用 <label> 包裹：整行可点的设置行本身就是 label，label 不能嵌套。
 * 改为让透明的 input 铺满整个开关区域直接接收点击，既能独立点击，
 * 又能安全地放进 SettingRow 的 clickable 模式里。
 */
withDefaults(
  defineProps<{
    modelValue: boolean
    disabled?: boolean
    /** 小一号，用于列表项等密集场景 */
    small?: boolean
  }>(),
  { disabled: false, small: false }
)

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

function onChange(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).checked)
}
</script>

<template>
  <span class="sf-toggle" :class="{ 'is-small': small, 'is-disabled': disabled }">
    <input
      class="sf-toggle-input"
      type="checkbox"
      role="switch"
      :checked="modelValue"
      :disabled="disabled"
      @change="onChange"
    />
    <span class="sf-toggle-track">
      <span class="sf-toggle-thumb"></span>
    </span>
  </span>
</template>

<style scoped>
.sf-toggle {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 22px;
  flex-shrink: 0;
}

.sf-toggle.is-small {
  width: 34px;
  height: 19px;
}

.sf-toggle.is-disabled {
  opacity: 0.45;
}

/* 透明 input 铺满，直接接收点击 —— 因此不需要外层 label */
.sf-toggle-input {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.sf-toggle-input:disabled {
  cursor: not-allowed;
}

.sf-toggle-track {
  position: absolute;
  inset: 0;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  transition: background-color 0.2s ease, border-color 0.2s ease;
}

.sf-toggle-thumb {
  position: absolute;
  top: 50%;
  left: 2px;
  width: 16px;
  height: 16px;
  margin-top: -8px;
  background: var(--text-muted);
  border-radius: var(--radius-full);
  transition: transform 0.2s ease, background-color 0.2s ease;
}

.sf-toggle.is-small .sf-toggle-thumb {
  width: 13px;
  height: 13px;
  margin-top: -7px;
}

.sf-toggle-input:checked ~ .sf-toggle-track {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
}

.sf-toggle-input:checked ~ .sf-toggle-track .sf-toggle-thumb {
  transform: translateX(18px);
  background: var(--accent-contrast);
}

.sf-toggle.is-small .sf-toggle-input:checked ~ .sf-toggle-track .sf-toggle-thumb {
  transform: translateX(15px);
}

.sf-toggle-input:focus-visible ~ .sf-toggle-track {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
}
</style>
