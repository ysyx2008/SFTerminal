<script setup lang="ts">
/**
 * 一行设置：左侧名称与描述，右侧控件。
 *
 * 名称与描述走 prop 而不是插槽，是刻意的约束——页面自己写标题结构正是
 * "107 个容器类名" 的来源之一。插槽只留给右侧控件。
 *
 * clickable 用于"整行即开关"的场景：渲染成 label，点整行都能切换。
 * 此时右侧控件必须是不含 label 的表单元素（kit 里的开关就是为此设计的）。
 */
withDefaults(
  defineProps<{
    label: string
    desc?: string
    /** 整行可点（渲染为 label，用于整行切换开关的场景） */
    clickable?: boolean
    /** 控件与文字上下排布，用于控件较宽（输入框、长下拉）的场景 */
    stacked?: boolean
  }>(),
  { clickable: false, stacked: false }
)
</script>

<template>
  <component
    :is="clickable ? 'label' : 'div'"
    class="sf-row"
    :class="{ 'is-clickable': clickable, 'is-stacked': stacked }"
  >
    <span class="sf-row-text">
      <span class="sf-row-label">{{ label }}</span>
      <span v-if="desc" class="sf-row-desc">{{ desc }}</span>
    </span>
    <span class="sf-row-control">
      <slot />
    </span>
  </component>
</template>

<style scoped>
.sf-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-5);
  min-height: 44px;
  padding: var(--sp-3) 0;
  border-bottom: 1px solid var(--border-color);
}

/* 同一张卡片里最后一行不画线，避免与卡片边框贴成双线 */
.sf-row:last-child {
  border-bottom: none;
}

.sf-row.is-clickable {
  cursor: pointer;
  user-select: none;
}

.sf-row.is-stacked {
  flex-direction: column;
  align-items: stretch;
  gap: var(--sp-2);
}

.sf-row-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.sf-row-label {
  font-size: var(--fs-label);
  font-weight: 500;
  color: var(--text-primary);
}

/* 描述用次要文字色而非最弱的一档：最弱色在深色主题下对比度约 2.9:1，读不动。
   限宽是为了不让长描述拉成难以回扫的一整行。 */
.sf-row-desc {
  margin-top: 3px;
  font-size: var(--fs-desc);
  line-height: 1.5;
  color: var(--text-secondary);
  max-width: 46em;
}

.sf-row-control {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
}

.sf-row.is-stacked .sf-row-control {
  flex-shrink: 1;
}
</style>
