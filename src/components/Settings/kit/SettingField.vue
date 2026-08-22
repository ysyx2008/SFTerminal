<script setup lang="ts">
/**
 * 表单字段：标签在上、控件在下，用于输入框 / 下拉 / 文本域等较宽的控件。
 *
 * 与 SettingRow 的分工：一句话能说清、控件很小的用行；需要占据整行宽度的用字段。
 */
defineProps<{
  label: string
  /** 控件下方的说明，解释这个值怎么填 */
  hint?: string
  /** 校验未通过时的提示，出现时取代 hint */
  error?: string
}>()
</script>

<template>
  <div class="sf-field">
    <span class="sf-field-label">{{ label }}</span>
    <div class="sf-field-control">
      <slot />
    </div>
    <span v-if="error" class="sf-field-error">{{ error }}</span>
    <span v-else-if="hint" class="sf-field-hint">{{ hint }}</span>
  </div>
</template>

<style scoped>
.sf-field {
  display: flex;
  flex-direction: column;
  padding: var(--sp-3) 0;
  border-bottom: 1px solid var(--border-color);
}

.sf-field:last-child {
  border-bottom: none;
}

.sf-field-label {
  margin-bottom: var(--sp-2);
  font-size: var(--fs-label);
  font-weight: 500;
  color: var(--text-primary);
}

.sf-field-control {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.sf-field-hint {
  margin-top: var(--sp-1);
  font-size: var(--fs-desc);
  line-height: 1.5;
  color: var(--text-secondary);
}

.sf-field-error {
  margin-top: var(--sp-1);
  font-size: var(--fs-desc);
  line-height: 1.5;
  color: var(--color-error);
}
</style>
