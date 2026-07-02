<script setup lang="ts">
/**
 * 思考过程展示组件
 *
 * 设计参照行业标准（Claude Desktop/Code、ChatGPT thinking 模型、Cursor Agent、Copilot Chat）：
 * 折叠态不展示原始 reasoning 字符流，只显示状态 + 已用时长，文字带流光动画提供活性反馈；
 * 想看具体内容由用户主动展开。
 *
 * 行为：
 * - 折叠态（默认）单行：
 *    · 流式中：spinner + 流光"思考中 4.2s" + "· 点击查看"
 *    · 完成后："✓ 思考完成 · 用时 4.2s · 点击查看"
 * - 展开态（用户点击切换）：内嵌容器显示完整 reasoning
 *    · 流式中：固定高度 + 自动滚到底（让 list 项整体高度恒定，不被 reasoning 增长拖动）
 *    · 完成后：max-height + 内部 scroll
 *
 * 时长：组件内部基于 startedAt（即 step.timestamp）+ setInterval 100ms 实时累计；
 * isStreaming 切换为 false 时停止 interval、定格 finalDurationMs，完成后不再消耗时钟。
 *
 * expanded 状态由父级 AiPanel 集中管理（按 stepId 索引），让 DynamicScroller 的
 * size-dependencies 能感知"用户主动切换"这一次高度变化。
 */
import { computed, ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMarkdown } from '../composables'

const props = defineProps<{
  reasoning: string
  isStreaming: boolean
  expanded: boolean
  /** reasoning 起点的毫秒时间戳，通常传 step.timestamp */
  startedAt: number
  /**
   * 父组件按 stepId 缓存的最终时长（毫秒）。
   * DynamicScroller 是虚拟列表，已完成的步骤滚出视区后组件会 unmount，再滚回时 remount——
   * 此时仅用 startedAt 重算会得到"从起点到现在"的错乱值。父组件缓存可保证 remount 后取回真实时长。
   */
  cachedDurationMs?: number
  /**
   * 流式态显示的标签文字，未指定时用 t('ai.thinking.streaming')。
   * Agent 创建初期的"正在准备..."占位会传 step.content 进来，让外观与后续真实 thinking 完全一致。
   */
  label?: string
}>()

const emit = defineEmits<{
  'toggle': [anchorEl: HTMLElement]
  'finalize': [durationMs: number]
}>()

const { t } = useI18n()
const { renderMarkdown } = useMarkdown()

const fullRef = ref<HTMLDivElement | null>(null)
const elapsedMs = ref(0)
const finalDurationMs = ref<number | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

const updateElapsed = () => {
  elapsedMs.value = Math.max(0, Date.now() - props.startedAt)
}

const startTimer = () => {
  if (timer) return
  updateElapsed()
  timer = setInterval(updateElapsed, 100)
}

const stopTimer = () => {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  updateElapsed()
  finalDurationMs.value = elapsedMs.value
}

onMounted(() => {
  if (props.isStreaming) {
    startTimer()
  } else if (props.cachedDurationMs !== undefined) {
    // 完成的步骤被 remount（虚拟列表回收→重建）：用父组件缓存的时长，避免 Date.now() 重算错乱
    finalDurationMs.value = props.cachedDurationMs
  }
  // 否则（无缓存的历史步骤）保留 finalDurationMs = null，durationText 返回空，不显示错误时长
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

watch(() => props.isStreaming, (streaming) => {
  if (streaming) {
    finalDurationMs.value = null
    startTimer()
  } else {
    stopTimer()
    if (finalDurationMs.value !== null) {
      emit('finalize', finalDurationMs.value)
    }
  }
})

// props.cachedDurationMs 在父组件缓存命中时可能晚于 mount 到来，watch 一下兜底
watch(() => props.cachedDurationMs, (cached) => {
  if (!props.isStreaming && cached !== undefined && finalDurationMs.value === null) {
    finalDurationMs.value = cached
  }
})

const durationText = computed(() => {
  const ms = finalDurationMs.value ?? elapsedMs.value
  if (ms < 100) return ''
  const seconds = ms / 1000
  if (seconds < 10) return seconds.toFixed(1) + 's'
  return Math.round(seconds) + 's'
})

const renderedReasoning = computed(() => renderMarkdown(props.reasoning))

const hasReasoning = computed(() => !!props.reasoning)
const streamingLabel = computed(() => props.label || t('ai.thinking.streaming'))

const handleClick = (event: MouseEvent) => {
  // reasoning 为空时（如初始"正在准备..."占位）不响应点击：没东西可展开
  if (!hasReasoning.value) return
  const anchorEl = event.currentTarget
  if (!(anchorEl instanceof HTMLElement)) return
  emit('toggle', anchorEl)
}

watch(
  () => props.reasoning,
  async () => {
    if (props.expanded && props.isStreaming) {
      await nextTick()
      const el = fullRef.value
      if (el) el.scrollTop = el.scrollHeight
    }
  }
)
</script>

<template>
  <div class="thinking-block" :class="{ streaming: isStreaming, expanded, 'no-content': !hasReasoning }">
    <div class="thinking-line" @click="handleClick($event)">
      <span v-if="isStreaming" class="thinking-spinner-inline" aria-hidden="true"></span>
      <span v-else class="thinking-icon-done" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      <span class="thinking-status" :class="{ 'streaming-text': isStreaming }">
        {{ isStreaming ? streamingLabel : t('ai.thinking.done') }}<span
          v-if="durationText"
          class="thinking-duration"
        > {{ isStreaming ? '' : '· ' }}{{ durationText }}</span>
      </span>
      <span v-if="hasReasoning" class="thinking-toggle-hint">· {{ expanded ? t('ai.thinking.clickHide') : t('ai.thinking.clickShow') }}</span>
    </div>
    <Transition name="thinking-expand">
      <div
        v-if="expanded"
        ref="fullRef"
        class="thinking-full markdown-content"
        :class="{ 'streaming-full': isStreaming }"
        v-html="renderedReasoning"
      ></div>
    </Transition>
  </div>
</template>

<style scoped>
.thinking-block {
  margin: 4px 0;
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 0;
  max-width: 100%;
}

.thinking-line {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  user-select: none;
  cursor: pointer;
  transition: opacity 0.15s ease;
  min-width: 0;
  overflow: hidden;
  /* 锁定行高/最小高度，避免「思考中 spinner」→「思考完成 三角」切换时
     因图标盒模型差异引起 1~2px 高度跳变，进而带动下方正文位移 */
  line-height: 16px;
  min-height: 20px;
}

/* 没有 reasoning 内容时（如 Agent 启动初期"正在准备..."占位），
   不允许点击展开，光标也不显示手型 */
.thinking-block.no-content .thinking-line {
  cursor: default;
}

.thinking-line:hover {
  opacity: 1;
}

.thinking-spinner-inline {
  flex-shrink: 0;
  width: 11px;
  height: 11px;
  box-sizing: border-box;
  border: 1.5px solid rgba(var(--brand-vital-rgb), 0.25);
  border-top-color: var(--brand-vital);
  border-radius: 50%;
  animation: thinking-spin 0.9s linear infinite;
}

/* 完成态用淡灰三角，跟「✓ 任务完成」的高亮绿对号区分；
   ▸/▾ 切换强化"可展开/已展开"的交互暗示。
   尺寸与 spinner 对齐（11×11），用 inline-flex 居中字符，
   保证从 spinner 切到三角时占用空间完全一致 */
.thinking-icon-done {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 11px;
  height: 11px;
  font-size: 10px;
  line-height: 1;
  color: var(--text-muted);
  opacity: 0.7;
}

.thinking-line:hover .thinking-icon-done {
  opacity: 1;
}

.thinking-status {
  flex-shrink: 0;
  white-space: nowrap;
  opacity: 0.9;
}

/* 流式中"思考中 4.2s"整段文字流光动画——这是唯一的活性反馈来源 */
.thinking-status.streaming-text {
  background: linear-gradient(
    90deg,
    rgba(var(--brand-vital-rgb), 0.55) 0%,
    rgba(var(--brand-vital-rgb), 1) 50%,
    rgba(var(--brand-vital-rgb), 0.55) 100%
  );
  background-size: 200% 100%;
  animation: thinking-gradient 2.4s linear infinite;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  opacity: 1;
}

.thinking-duration {
  font-variant-numeric: tabular-nums;
}

.thinking-toggle-hint {
  flex-shrink: 0;
  opacity: 0.6;
  font-size: 11px;
  margin-left: 4px;
  white-space: nowrap;
}

.thinking-line:hover .thinking-toggle-hint {
  opacity: 0.9;
}

/* 展开后的完整推理：透明 + 细灰左边框（第一版风格），低调地与正文区分。
   margin-top 6px 与单行思考行拉开，margin-bottom 10px 与下方正文/工具卡拉开，
   不再加自身背景，避免与 step 外层颜色条形成"双层卡片"挤压感。 */
.thinking-full {
  margin: 6px 0 10px;
  padding: 2px 10px;
  border-left: 2px solid rgba(255, 255, 255, 0.08);
  background: transparent;
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.55;
  opacity: 0.88;
  overflow-wrap: anywhere;
  overflow-y: auto;
  max-height: 360px;
}

/* 流式中展开：限制最大高度，内容随 reasoning 增长自然撑开 */
.thinking-full.streaming-full {
  max-height: 200px;
}

.thinking-full :deep(p) {
  margin: 4px 0;
}

.thinking-full :deep(ul),
.thinking-full :deep(ol) {
  margin: 4px 0;
  padding-left: 20px;
}

.thinking-full :deep(li) {
  margin: 2px 0;
}

.thinking-full :deep(li > p) {
  margin: 0;
}

.thinking-full :deep(code) {
  background: rgba(0, 0, 0, 0.2);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 10.5px;
}

.thinking-full :deep(pre) {
  margin: 4px 0;
  padding: 6px 10px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 4px;
  overflow-x: auto;
}

.thinking-full :deep(strong) {
  color: var(--text-primary);
  opacity: 0.9;
}

@keyframes thinking-spin {
  to { transform: rotate(360deg); }
}

@keyframes thinking-gradient {
  to { background-position: -200% 0; }
}

.thinking-expand-enter-active,
.thinking-expand-leave-active {
  transition: max-height 0.22s ease, opacity 0.18s ease, padding 0.22s ease;
  overflow: hidden;
}

.thinking-expand-enter-from,
.thinking-expand-leave-to {
  max-height: 0 !important;
  opacity: 0;
  padding-top: 0;
  padding-bottom: 0;
}

.thinking-expand-enter-to,
.thinking-expand-leave-from {
  max-height: 420px;
  opacity: 0.9;
}
</style>
