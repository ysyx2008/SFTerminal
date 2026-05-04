<!--
  tool_call 步骤的 content 渲染。
  content 形如「阅读网页: https://example.com/foo」「执行命令: ls -la # 注释」，
  既要保留命令里 # / --- / * 的原貌（不能走 markdown），又希望 URL 能点击。

  策略：toolArgs 含 http(s) url 字段时把 URL 部分包成 <a>，其余走纯文本插值（Vue
  自动 escape），点击后由 Electron setWindowOpenHandler 调系统浏览器。

  按字段语义（'url'）而非工具名识别——任何工具的 args 含 url 都享受到这个能力，
  不违反 agent-oop-boundary 规则。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { splitContentByUrl } from '../utils/tool-call-link'

const props = defineProps<{
  content: string
  toolArgs?: Record<string, unknown>
}>()

const parts = computed(() => splitContentByUrl(props.content, props.toolArgs))
</script>

<template>
  <div class="step-text tool-call-content">
    <template v-if="parts">{{ parts.before }}<a
      :href="parts.url"
      target="_blank"
      rel="noopener noreferrer"
      class="external-url-link"
      :title="parts.url"
    >{{ parts.url }}</a>{{ parts.after }}</template>
    <template v-else>{{ content }}</template>
  </div>
</template>
