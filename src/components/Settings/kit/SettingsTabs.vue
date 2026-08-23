<script setup lang="ts">
/**
 * 页内标签条：在同一页的几大块之间切换。
 *
 * 与分段选择的分工是这一层存在的理由。两者都是一排互斥按钮，但分段选择说的是
 * 「这个设置的取值是 X」，标签条说的是「你正在看第 X 块」——一个取值，一个导航。
 * 把导航画成填充色块的药丸，读起来就成了某个设置项的值，正好犯了「同一个视觉
 * 信号在这页表示选中、在那页表示别的」。
 *
 * 所以标签条与侧栏同属导航语言：只有文字和一道当前位置的标记，不占强调色块。
 */
defineProps<{
  modelValue: string
  tabs: ReadonlyArray<{ value: string; label: string; title?: string }>
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <div class="sf-tabs" role="tablist">
    <button
      v-for="tab in tabs"
      :key="tab.value"
      type="button"
      role="tab"
      class="sf-tab"
      :class="{ 'is-active': modelValue === tab.value }"
      :aria-selected="modelValue === tab.value"
      :title="tab.title"
      @click="emit('update:modelValue', tab.value)"
    >
      {{ tab.label }}
    </button>
  </div>
</template>

<style scoped>
.sf-tabs {
  display: flex;
  gap: var(--sp-5);
  padding: 0 var(--sp-1);
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
  scrollbar-width: none;
}

.sf-tabs::-webkit-scrollbar {
  display: none;
}

.sf-tab {
  flex: 0 0 auto;
  padding: var(--sp-2) 0;
  /* 当前标记压住整条底线，标签条才读作一层而不是两条平行线 */
  margin-bottom: -1px;
  font-family: inherit;
  font-size: var(--fs-body);
  font-weight: 500;
  line-height: 1.5;
  white-space: nowrap;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease;
}

.sf-tab:hover:not(.is-active) {
  color: var(--text-primary);
  border-bottom-color: var(--border-color);
}

.sf-tab.is-active {
  color: var(--text-primary);
  border-bottom-color: var(--accent-primary);
}

.sf-tab:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
  border-radius: 2px;
}
</style>
