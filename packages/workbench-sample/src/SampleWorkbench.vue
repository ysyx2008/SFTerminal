<script setup lang="ts">
/**
 * SampleWorkbench —— 无对话的最小业务台 UI（W4 验证渲染器可从包加载）
 */
defineProps<{
  tab: { id: string; title?: string }
  isActive: boolean
}>()
</script>

<template>
  <div class="sample-workbench" :data-active="isActive">
    <h2>Sample Workbench</h2>
    <p>
      OEM / 业务工作台模板。kind=<code>sample</code>；
      通过 <code>tab.workbenchKind</code> 打开。无对话区（P2 前）。
    </p>
    <p class="meta">tab: {{ tab.id }}</p>
  </div>
</template>

<style scoped>
.sample-workbench {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 24px;
  height: 100%;
  box-sizing: border-box;
  color: var(--color-text-primary, #e8e8e8);
  background: var(--color-bg-primary, #1a1a1a);
}
.sample-workbench h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.sample-workbench p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--color-text-secondary, #aaa);
}
.sample-workbench code {
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
.meta {
  margin-top: auto;
  opacity: 0.7;
}
</style>
