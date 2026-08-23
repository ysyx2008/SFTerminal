<script setup lang="ts">
/**
 * 滑块：用于连续数值（字号、行数、音量）。
 * 右侧常驻读数——拖动时没有读数，用户只能靠猜。
 */
withDefaults(
  defineProps<{
    modelValue: number
    min: number
    max: number
    step?: number
    /** 读数后缀，如 px、% */
    suffix?: string
    disabled?: boolean
  }>(),
  { step: 1, suffix: '', disabled: false }
)

const emit = defineEmits<{ 'update:modelValue': [value: number] }>()
</script>

<template>
  <div class="sf-slider">
    <input
      class="sf-slider__input"
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue"
      :disabled="disabled"
      @input="emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
    />
    <span class="sf-slider__value">{{ modelValue }}{{ suffix }}</span>
  </div>
</template>

<style scoped>
.sf-slider {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.sf-slider__input {
  width: 160px;
  height: 4px;
  appearance: none;
  background: var(--bg-tertiary);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}

.sf-slider__input::-webkit-slider-thumb {
  appearance: none;
  width: 14px;
  height: 14px;
  background: var(--accent-primary);
  border-radius: 50%;
  cursor: pointer;
  transition: transform 0.15s ease;
}

.sf-slider__input:hover::-webkit-slider-thumb {
  transform: scale(1.15);
}

.sf-slider__input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.sf-slider__input:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 4px;
}

/* 读数定宽，拖动时数字变长不推挤滑块 */
.sf-slider__value {
  min-width: 52px;
  font-size: var(--fs-desc);
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: var(--text-secondary);
}
</style>
