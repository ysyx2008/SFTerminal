<script setup lang="ts">
/**
 * 一个设置分组 = 组标题 + 一张卡片。
 *
 * 标题放在卡片**外面**当眉标，卡片里只剩设置项——这样"这是一组"和"这是一项"
 * 一眼分得开。纯 CSS 路线做不到这点（要改十几个页面的模板结构），组件化才有条件。
 *
 * 卡片可以安全地加边框：它的内容只应是设置行一类的扁平元素，不会再套带边框的盒子。
 * 历史上 IM 页出现三层嵌套边框，正是因为往卡片里塞了自带边框的容器。
 */
withDefaults(
  defineProps<{
    /** 组标题；不传则只渲染内容 */
    title?: string
    /** 组说明，位于标题下方、内容之外 */
    desc?: string
    /** 内容下方的补充说明，用于整组共用的提示 */
    footnote?: string
    /**
     * plain 不画卡片，用于内容本身就是一排独立盒子（列表项、卡片墙）的场景——
     * 那种内容外面再套一层底色框，只会多出一圈什么也不说明的边界。
     */
    variant?: 'card' | 'plain'
    /** 卡片自带内边距。内容自行控制留白时置 false（plain 下无效） */
    padded?: boolean
  }>(),
  { variant: 'card', padded: true }
)
</script>

<template>
  <section class="sf-group">
    <header v-if="title || $slots.actions" class="sf-group-head">
      <div class="sf-group-heading">
        <h3 v-if="title" class="sf-group-title">{{ title }}</h3>
        <p v-if="desc" class="sf-group-desc">{{ desc }}</p>
      </div>
      <div v-if="$slots.actions" class="sf-group-actions">
        <slot name="actions" />
      </div>
    </header>

    <div
      class="sf-group-body"
      :class="[`is-${variant}`, { 'is-padded': variant === 'card' && padded }]"
    >
      <slot />
    </div>

    <p v-if="footnote" class="sf-group-footnote">{{ footnote }}</p>
  </section>
</template>

<style scoped>
.sf-group {
  display: flex;
  flex-direction: column;
}

.sf-group-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-bottom: var(--sp-2);
  padding: 0 var(--sp-1);
}

.sf-group-heading {
  min-width: 0;
}

/* 眉标：明显退后于设置项名，与侧栏分组标签同一套语言 */
.sf-group-title {
  margin: 0;
  font-size: var(--fs-meta);
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
}

.sf-group-desc {
  margin: var(--sp-1) 0 0;
  font-size: var(--fs-desc);
  line-height: 1.5;
  color: var(--text-secondary);
  max-width: 52em;
}

.sf-group-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
}

.sf-group-body.is-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.sf-group-body.is-padded {
  padding: 0 var(--sp-4);
}

.sf-group-footnote {
  margin: var(--sp-2) 0 0;
  padding: 0 var(--sp-1);
  font-size: var(--fs-desc);
  line-height: 1.5;
  color: var(--text-secondary);
}
</style>
