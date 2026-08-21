<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from 'lucide-vue-next'
import { ACTION_KIND_ORDER, type ActionKind, type ProcessFoldView } from '../utils/process-fold'

const props = defineProps<{
  fold: ProcessFoldView
  expanded?: boolean
}>()

const emit = defineEmits<{
  toggle: []
}>()

const { t } = useI18n()

// 跑着的时候秒数要走。只在这一行还活着时才计时，静止的历史行不占定时器。
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

const stopTicking = () => {
  if (timer === undefined) return
  clearInterval(timer)
  timer = undefined
}

// 思考写得比人读得快。一句话至少停留这么久再换下一句，否则整行字只是在闪。
const MIN_LABEL_DWELL_MS = 2000

const shownLiveText = ref(props.fold.liveText)
const shownWaitingHint = ref(props.fold.waitingHint === true)
let swapTimer: ReturnType<typeof setTimeout> | undefined
let lastSwapAt = 0

const stopSwapping = () => {
  if (swapTimer === undefined) return
  clearTimeout(swapTimer)
  swapTimer = undefined
}

const showLiveText = (text: string | undefined, waitingHint: boolean) => {
  shownLiveText.value = text
  shownWaitingHint.value = waitingHint
  lastSwapAt = Date.now()
}

watch(
  () => [props.fold.liveText, props.fold.waitingHint === true] as const,
  ([next, nextHint]) => {
    stopSwapping()
    if (next === shownLiveText.value && nextHint === shownWaitingHint.value) return
    // 等待提示让位给真正的思考：立刻换色，别让流光再停两秒
    const leavingHint = shownWaitingHint.value && !nextHint
    const wait = leavingHint ? 0 : MIN_LABEL_DWELL_MS - (Date.now() - lastSwapAt)
    if (wait <= 0) {
      showLiveText(next, nextHint)
      return
    }
    // 等够了再换，且换的是那一刻最新的一句，中间刷过去的不补播
    swapTimer = setTimeout(() => {
      swapTimer = undefined
      showLiveText(props.fold.liveText, props.fold.waitingHint === true)
    }, wait)
  },
)

watch(
  () => props.fold.live,
  live => {
    stopTicking()
    if (live) {
      now.value = Date.now()
      timer = setInterval(() => { now.value = Date.now() }, 1000)
      return
    }
    // 做完了立刻定格成结论，不让排队中的那句盖回去
    stopSwapping()
    shownLiveText.value = props.fold.liveText
    shownWaitingHint.value = false
  },
  { immediate: true },
)

onUnmounted(() => {
  stopTicking()
  stopSwapping()
})

const actionLine = computed(() => {
  const parts: string[] = []
  for (const kind of ACTION_KIND_ORDER) {
    const n = props.fold.counts[kind as ActionKind] || 0
    if (n > 0) parts.push(t(`ai.processFold.${kind}`, { n }))
  }
  return parts.join(t('ai.processFold.sep'))
})

/** 跑着时说它在忙什么，做完说做了什么；没动手只想了想就照实说 */
const label = computed(() => {
  const idle = props.fold.thinkingOnly ? t('ai.processFold.thought') : t('ai.processFold.working')
  if (!props.fold.live) return actionLine.value || idle
  if (shownLiveText.value) return shownLiveText.value
  if (props.fold.liveAction) return t(`ai.processFold.doing.${props.fold.liveAction}`)
  return props.fold.thinkingOnly ? t('ai.processFold.thinking') : t('ai.processFold.working')
})

/** 做完之后才把「共做了什么」补在忙碌描述后面，跑着时那行已经够长 */
const trailing = computed(() => (props.fold.live && actionLine.value ? actionLine.value : ''))

const elapsedMs = computed(() => {
  if (!props.fold.live) return props.fold.durationMs || 0
  if (props.fold.startedAt === undefined) return 0
  return Math.max(0, now.value - props.fold.startedAt)
})

const elapsed = computed(() => {
  const ms = elapsedMs.value
  if (ms < 1000) return ''
  const total = Math.floor(ms / 1000)
  if (total < 60) return t('ai.processFold.seconds', { n: total })
  const min = Math.floor(total / 60)
  const sec = total % 60
  if (!sec) return t('ai.processFold.minutes', { n: min })
  return t('ai.processFold.minutesSeconds', { m: min, s: sec })
})
</script>

<template>
  <div class="process-fold" :class="{ 'is-live': fold.live, 'is-expanded': expanded }">
    <div
      class="process-fold__row"
      role="button"
      :aria-expanded="expanded"
      tabindex="0"
      @click="emit('toggle')"
      @keydown.enter.prevent="emit('toggle')"
      @keydown.space.prevent="emit('toggle')"
    >
      <span class="process-fold__label" :class="{ 'is-waiting-hint': fold.live && shownWaitingHint }">{{ label }}</span>
      <span v-if="trailing" class="process-fold__meta">{{ trailing }}</span>
      <span v-if="elapsed" class="process-fold__time">{{ elapsed }}</span>
      <span class="process-fold__marker">
        <span v-if="fold.live" class="process-fold__spinner" aria-hidden="true"></span>
        <ChevronRight v-else :size="13" class="process-fold__chevron" />
      </span>
    </div>

    <!-- 0fr → 1fr：不必预知内容高度就能平滑撑开 -->
    <div class="process-fold__drawer" :class="{ open: expanded }">
      <div class="process-fold__drawer-inner">
        <div class="process-fold__steps">
          <slot />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.process-fold__row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 6px 6px;
  margin: 0 -6px;
  border-radius: 5px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.process-fold__row:hover {
  background: rgba(127, 127, 127, 0.1);
  color: var(--text-primary);
}

.process-fold__row:focus-visible {
  outline: 1px solid var(--accent-primary);
  outline-offset: -1px;
}

.process-fold__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 只有启动等待提示跟原来 ThinkingBlock 一样流光；思考正文出来就回到次要色 */
.process-fold__label.is-waiting-hint {
  background: linear-gradient(
    90deg,
    rgba(var(--brand-vital-rgb), 0.55) 0%,
    rgba(var(--brand-vital-rgb), 1) 50%,
    rgba(var(--brand-vital-rgb), 0.55) 100%
  );
  background-size: 200% 100%;
  animation: process-fold-gradient 2.4s linear infinite;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.process-fold__meta,
.process-fold__time {
  flex-shrink: 0;
  opacity: 0.6;
}

.process-fold__meta::before,
.process-fold__time::before {
  content: '· ';
}

.process-fold__time {
  font-variant-numeric: tabular-nums;
}

/* 转环与箭头共用同一格：做完时原地换掉，文字一个像素都不动 */
.process-fold__marker {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  align-self: center;
}

.process-fold__chevron {
  opacity: 0.5;
  transition: transform 0.18s ease, opacity 0.12s ease;
}

.process-fold__row:hover .process-fold__chevron {
  opacity: 0.9;
}

.is-expanded .process-fold__chevron {
  transform: rotate(90deg);
}

.process-fold__spinner {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.5px solid rgba(127, 127, 127, 0.3);
  border-top-color: var(--accent-primary);
  animation: process-fold-spin 0.7s linear infinite;
}

@keyframes process-fold-spin {
  to { transform: rotate(360deg); }
}

@keyframes process-fold-gradient {
  to { background-position: -200% 0; }
}

.process-fold__drawer {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.22s ease;
}

.process-fold__drawer.open {
  grid-template-rows: 1fr;
}

.process-fold__drawer-inner {
  overflow: hidden;
  min-height: 0;
}

/* 左竖线把展开的内容归到刚才那一行名下 */
.process-fold__steps {
  margin-left: 3px;
  padding-left: 11px;
  border-left: 1px solid rgba(127, 127, 127, 0.22);
}

.process-fold__drawer.open .process-fold__steps {
  animation: process-fold-fade 0.22s ease;
}

@keyframes process-fold-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .process-fold__drawer,
  .process-fold__chevron {
    transition: none;
  }
  .process-fold__spinner {
    animation-duration: 2s;
  }
  .process-fold__label.is-waiting-hint {
    animation: none;
    background: none;
    -webkit-text-fill-color: var(--brand-vital);
    color: var(--brand-vital);
  }
  .process-fold__drawer.open .process-fold__steps {
    animation: none;
  }
}
</style>
