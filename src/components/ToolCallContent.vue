<!--
  tool_call 步骤的 content 渲染。
  content 形如「阅读网页: https://example.com/foo」「执行命令: ls -la # 注释」
  「读取文件: ~/a/b.txt」，既要保留命令里 # / --- / * 的原貌（不能走 markdown），
  又希望 URL / 本地路径能点击。

  策略：splitToolCallContent 按 toolArgs.url / toolArgs.path + 裸路径扫描拆成片段，
  其余纯文本插值（Vue 自动 escape）。路径点击经 data-file-path 事件委托
  （与消息 Markdown 同源）；URL 由 Electron setWindowOpenHandler 打开。

  按字段语义（url / path）而非工具名识别——不违反 agent-oop-boundary。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { splitToolCallContent } from '../utils/tool-call-link'

const props = defineProps<{
  content: string
  toolArgs?: Record<string, unknown>
}>()

const segments = computed(() => splitToolCallContent(props.content, props.toolArgs))
</script>

<template>
  <div class="step-text tool-call-content">
    <template v-for="(seg, i) in segments" :key="i">
      <template v-if="seg.kind === 'text'">{{ seg.text }}</template>
      <a
        v-else-if="seg.kind === 'url'"
        :href="seg.url"
        target="_blank"
        rel="noopener noreferrer"
        class="external-url-link"
        :title="seg.url"
      >{{ seg.url }}</a>
      <a
        v-else
        class="file-path-link"
        :data-file-path="seg.path"
        :title="seg.path"
      >{{ seg.display }}</a>
    </template>
  </div>
</template>
