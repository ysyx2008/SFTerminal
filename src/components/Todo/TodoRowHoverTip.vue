<script setup lang="ts">
/**
 * 待办悬停速览卡 —— 跟随鼠标、即时出现
 *
 * 定位用真实渲染尺寸（ResizeObserver 测量），不用固定宽高假设——
 * 卡片内容量随条目差异很大（有无备注/标签/到期），估算值早晚会跟真实尺寸脱节，
 * 导致翻转判断错误（该翻转的没翻转 / 不该翻转的翻转了）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TodoItem } from '@sailfish/shared-types'

type UrgencyTier = 'urgent' | 'watch' | 'relaxed'

const props = defineProps<{
  item: TodoItem
  remainLabel?: string | null
  urgencyLabel?: string | null
  urgencyTier?: UrgencyTier | null
  showBarHint?: boolean
  /** 鼠标原始 viewport 坐标；卡片相对光标的偏移与翻转在本组件内计算 */
  cursorX: number
  cursorY: number
}>()

const { t, locale } = useI18n()

const tipEl = ref<HTMLElement | null>(null)
const size = ref({ w: 240, h: 90 })
let resizeObserver: ResizeObserver | null = null

function measure() {
  if (!tipEl.value) return
  const rect = tipEl.value.getBoundingClientRect()
  if (rect.width > 0 && rect.height > 0) {
    size.value = { w: rect.width, h: rect.height }
  }
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && tipEl.value) {
    resizeObserver = new ResizeObserver(() => measure())
    resizeObserver.observe(tipEl.value)
  }
})
onBeforeUnmount(() => resizeObserver?.disconnect())
// 内容变化（换到另一条目）时尺寸会变，ResizeObserver 已覆盖；这里兜底一次同步测量避免首帧偏差
watch(() => props.item.id, () => measure())

const OFFSET = 14
const PAD = 8

const style = computed(() => {
  const { w, h } = size.value
  let x = props.cursorX + OFFSET
  let y = props.cursorY + OFFSET
  if (x + w > window.innerWidth - PAD) x = props.cursorX - w - OFFSET
  if (y + h > window.innerHeight - PAD) y = props.cursorY - h - OFFSET
  x = Math.min(Math.max(x, PAD), Math.max(PAD, window.innerWidth - w - PAD))
  y = Math.min(Math.max(y, PAD), Math.max(PAD, window.innerHeight - h - PAD))
  return { left: `${x}px`, top: `${y}px` }
})

const urgencyColorVar = computed(() => {
  switch (props.urgencyTier) {
    case 'urgent':
      return '--brand-alert'
    case 'watch':
      return '--brand-caution'
    case 'relaxed':
      return '--brand-vital'
    default:
      return null
  }
})

const descPreview = computed(() => {
  const d = props.item.description?.trim()
  if (!d) return ''
  return d.length > 200 ? `${d.slice(0, 200)}…` : d
})

function formatShort(iso?: string): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return new Intl.DateTimeFormat(locale.value, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d)
  } catch {
    return iso
  }
}

function formatDue(iso?: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return new Intl.DateTimeFormat(locale.value, { month: '2-digit', day: '2-digit' }).format(d)
  } catch {
    return iso
  }
}

const priorityText = computed(() => {
  const p = props.item.priority
  if (!p || p === 'normal') return t('todoPanel.priority.normal')
  return t(`todoPanel.priority.${p}`)
})

const dueLine = computed(() => {
  if (!props.item.dueDate) return ''
  const parts = [formatDue(props.item.dueDate)]
  if (props.remainLabel) parts.push(props.remainLabel)
  return parts.join(' · ')
})

const timeLine = computed(() => {
  if (props.item.completedAt) {
    return `${t('todoPanel.fieldCompleted')} ${formatShort(props.item.completedAt)}`
  }
  return `${t('todoPanel.fieldCreated')} ${formatShort(props.item.createdAt)} · ${t('todoPanel.fieldUpdated')} ${formatShort(props.item.updatedAt)}`
})
</script>

<template>
  <aside ref="tipEl" class="due-hover-tip" role="tooltip" :style="style">
    <div class="tip-header">
      <div class="tip-title">{{ item.title }}</div>
      <p v-if="descPreview" class="tip-desc">{{ descPreview }}</p>
    </div>

    <div class="tip-divider" />

    <div class="tip-body">
      <div class="tip-row">
        <span class="tip-badge">{{ t(`todoPanel.status.${item.status}`) }}</span>
        <span v-if="item.priority && item.priority !== 'normal'" class="tip-badge" :data-p="item.priority">
          {{ priorityText }}
        </span>
      </div>

      <div v-if="dueLine" class="tip-row tip-due">
        <span v-if="urgencyColorVar" class="tip-dot" :style="{ background: `var(${urgencyColorVar})` }" />
        <span class="tip-due-text">{{ dueLine }}</span>
        <span v-if="urgencyLabel" class="tip-urgency">{{ urgencyLabel }}</span>
      </div>

      <p v-if="item.tags?.length" class="tip-tags">{{ item.tags.join(' · ') }}</p>

      <p class="tip-time">{{ timeLine }}</p>
    </div>

    <p v-if="showBarHint" class="tip-hint">{{ t('todoPanel.dueBarHint') }}</p>
  </aside>
</template>

<style scoped>
.due-hover-tip {
  position: fixed;
  z-index: 10000;
  width: max-content;
  max-width: min(300px, calc(100vw - 24px));
  padding: 10px 12px;
  border-radius: 9px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  box-shadow: 0 8px 22px color-mix(in srgb, #000 30%, transparent);
  pointer-events: none;
  white-space: normal;
  transition: none;
}

.tip-title {
  font-size: 12.5px;
  font-weight: 600;
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.tip-desc {
  margin: 3px 0 0;
  font-size: 11px;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
}

.tip-divider {
  height: 1px;
  margin: 8px 0;
  background: color-mix(in srgb, var(--border-color) 70%, transparent);
}

.tip-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tip-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.tip-badge {
  flex-shrink: 0;
  height: 18px;
  padding: 0 7px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 550;
  line-height: 18px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--text-primary) 8%, transparent);
}
.tip-badge[data-p='urgent'],
.tip-badge[data-p='high'] {
  color: var(--accent-warning);
  background: color-mix(in srgb, var(--accent-warning) 16%, transparent);
}
.tip-badge[data-p='low'] {
  color: var(--text-muted);
}

.tip-row.tip-due {
  font-variant-numeric: tabular-nums;
}

.tip-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.tip-due-text {
  color: var(--text-primary);
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tip-urgency {
  flex-shrink: 0;
  margin-left: auto;
  color: var(--text-muted);
  font-size: 10px;
}

.tip-tags {
  margin: 0;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tip-time {
  margin: 0;
  color: var(--text-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.tip-hint {
  margin: 8px 0 0;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--border-color) 80%, transparent);
  font-size: 10px;
  color: var(--text-muted);
}
</style>
