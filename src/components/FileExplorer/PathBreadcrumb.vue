<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  path: string
}>()

const emit = defineEmits<{
  navigate: [path: string]
}>()

// 解析路径为面包屑项
const breadcrumbs = computed(() => {
  const parts = props.path.split('/').filter(Boolean)
  const items: { name: string; path: string }[] = []

  // 添加根目录
  items.push({ name: '/', path: '/' })

  // 添加各级目录
  let currentPath = ''
  for (const part of parts) {
    currentPath += '/' + part
    items.push({ name: part, path: currentPath })
  }

  return items
})

// 点击导航
const handleClick = (path: string) => {
  emit('navigate', path)
}
</script>

<template>
  <div class="path-breadcrumb">
    <template v-for="(item, index) in breadcrumbs" :key="item.path">
      <span
        class="breadcrumb-item"
        :class="{ active: index === breadcrumbs.length - 1 }"
        @click="handleClick(item.path)"
        :title="item.path"
      >
        {{ item.name }}
      </span>
      <span v-if="index < breadcrumbs.length - 1" class="separator">/</span>
    </template>
  </div>
</template>

<style scoped>
.path-breadcrumb {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  padding: 0 8px;
  font-size: 13px;
  color: var(--text-secondary);
  overflow: hidden;
}

.breadcrumb-item {
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
  transition: all 0.15s;
}

.breadcrumb-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.breadcrumb-item.active {
  color: var(--text-primary);
  font-weight: 500;
}

.separator {
  margin: 0 2px;
  color: var(--text-muted);
  flex-shrink: 0;
}
</style>
