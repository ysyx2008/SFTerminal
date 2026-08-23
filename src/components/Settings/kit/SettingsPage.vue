<script setup lang="ts">
/**
 * 设置页根容器：页头 + 若干分组。
 *
 * 页头是这一层存在的理由。面板原本没有「页名」的固定位置，各页只好拿第一个
 * 分组的标题当页名使——那个标题于是既不是页名（侧栏已经写了）也不是分组名
 * （它下面还有别的分组没标题）。同一个洞在不同页面发作，看起来就像「每页各有
 * 各的风格」。
 *
 * 内容限宽由 SettingsModal 统一施加于内容区的直接子元素，
 * 这样未迁移的页面同样受限，不必等迁移完成才有限宽。
 */
defineProps<{
  /** 页名，须与侧栏当前项一致 */
  title?: string
  /** 一句话说明这一页管什么 */
  desc?: string
}>()
</script>

<template>
  <div class="sf-page">
    <header v-if="title || $slots.actions" class="sf-page-head">
      <div class="sf-page-heading">
        <h2 v-if="title" class="sf-page-title">{{ title }}</h2>
        <p v-if="desc" class="sf-page-desc">{{ desc }}</p>
      </div>
      <div v-if="$slots.actions" class="sf-page-actions">
        <slot name="actions" />
      </div>
    </header>

    <div class="sf-page-groups">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.sf-page {
  display: flex;
  flex-direction: column;
}

.sf-page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  /* 与首个分组之间留得比组间距更宽，页头才不会被读成又一个分组 */
  margin-bottom: var(--sp-6);
  padding: 0 var(--sp-1);
}

.sf-page-heading {
  min-width: 0;
}

.sf-page-title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 600;
  color: var(--text-primary);
}

.sf-page-desc {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-desc);
  line-height: 1.6;
  color: var(--text-secondary);
  max-width: 56em;
}

.sf-page-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
}

.sf-page-groups {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}
</style>
