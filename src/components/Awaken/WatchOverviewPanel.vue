<script setup lang="ts">
/**
 * 关切运营总览仪表盘
 *
 * 在「关切」tab 列表里选中「总览」虚拟项时显示。
 * 一屏看清：异常关切 / 运行中 / 即将执行 / 最近执行流水。
 *
 * 本组件不发起 IPC 调用，全部数据由父组件 Awaken.vue 注入；
 * select-watch 让父组件切换到对应 watch 的详情视图。
 */

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  AlertTriangle, RefreshCw, Clock, History,
  CheckCircle2, ChevronRight, AlertCircle
} from 'lucide-vue-next'
import type { WatchDefinition, WatchHistoryRecord } from '@shared/types'

const props = defineProps<{
  watches: WatchDefinition[]
  history: WatchHistoryRecord[]
  runningWatches: Set<string>
}>()

const emit = defineEmits<{
  'select-watch': [id: string]
  'view-history-detail': [record: WatchHistoryRecord]
}>()

const { t, locale } = useI18n()

// ==================== 派生数据 ====================

// 异常：启用且上次失败/超时，按上次失败时间倒序
const anomalies = computed<WatchDefinition[]>(() =>
  props.watches
    .filter(w => w.enabled && (w.lastRun?.status === 'failed' || w.lastRun?.status === 'timeout'))
    .sort((a, b) => (b.lastRun?.at ?? 0) - (a.lastRun?.at ?? 0))
)

// 运行中：在 runningWatches 集合中
const running = computed<WatchDefinition[]>(() =>
  props.watches.filter(w => props.runningWatches.has(w.id))
)

// 即将执行：启用且 nextRun 在未来，按时间正序，取前 6
const upcoming = computed<WatchDefinition[]>(() => {
  const now = Date.now()
  return props.watches
    .filter(w => w.enabled && typeof w.nextRun === 'number' && (w.nextRun as number) > now)
    .sort((a, b) => (a.nextRun ?? 0) - (b.nextRun ?? 0))
    .slice(0, 6)
})

// 最近流水：父组件传入的 history 已是按 at 倒序，这里防御性 slice
const recentHistory = computed<WatchHistoryRecord[]>(() =>
  [...props.history].sort((a, b) => b.at - a.at).slice(0, 20)
)

// ==================== 时间格式化 ====================

function formatTimeAgo(ts: number): string {
  const now = Date.now()
  const diff = now - ts
  if (diff < 0) return formatUpcoming(ts)
  const sec = Math.floor(diff / 1000)
  if (sec < 10) return t('watch.timeJustNow')
  if (sec < 60) return t('watch.timeSecAgo', { n: sec })
  const min = Math.floor(sec / 60)
  if (min < 60) return t('watch.timeMinAgo', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('watch.timeHrAgo', { n: hr })
  const day = Math.floor(hr / 24)
  if (day < 7) return t('watch.timeDayAgo', { n: day })
  return formatAbsoluteShort(ts)
}

function formatUpcoming(ts: number): string {
  const now = Date.now()
  const diff = ts - now
  if (diff <= 0) return t('watch.timeNow')
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return t('watch.timeInSec', { n: sec })
  const min = Math.floor(sec / 60)
  if (min < 60) return t('watch.timeInMin', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('watch.timeInHr', { n: hr })
  const day = Math.floor(hr / 24)
  if (day < 7) return t('watch.timeInDay', { n: day })
  return formatAbsoluteShort(ts)
}

function formatAbsoluteShort(ts: number): string {
  const d = new Date(ts)
  const opts: Intl.DateTimeFormatOptions = { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
  return new Intl.DateTimeFormat(locale.value, opts).format(d)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const min = Math.floor(sec / 60)
  const restSec = Math.floor(sec - min * 60)
  return restSec > 0 ? `${min}m ${restSec}s` : `${min}m`
}

// ==================== 单条流水状态视觉 ====================

function historyStatusClass(s: string): string {
  switch (s) {
    case 'completed': return 'success'
    case 'failed':
    case 'timeout':   return 'error'
    case 'cancelled':
    case 'skipped':   return 'warning'
    case 'running':   return 'running'
    default:          return 'idle'
  }
}

function historyStatusLabel(s: string): string {
  switch (s) {
    case 'completed': return t('watch.statusCompleted')
    case 'failed':    return t('watch.statusFailed')
    case 'timeout':   return t('watch.statusTimeout')
    case 'cancelled': return t('watch.statusCancelled')
    case 'skipped':   return t('watch.statusSkipped')
    case 'running':   return t('watch.statusRunning')
    default:          return s
  }
}

function anomalySummary(w: WatchDefinition): string {
  const last = w.lastRun
  if (!last) return ''
  if (last.error) return last.error
  if (last.status === 'timeout') return t('watch.statusTimeout')
  return ''
}

// 当前正在执行已运行了多久（基于 lastRun.at 估算，仅展示）
function runningDurationText(w: WatchDefinition): string {
  const startAt = w.lastRun?.at
  if (typeof startAt !== 'number') return ''
  const ms = Date.now() - startAt
  if (ms < 0) return ''
  return formatDuration(ms)
}

// 历史摘要：截断 output，没有则取 error/skipReason
function historySummary(r: WatchHistoryRecord): string {
  const text = r.error || r.skipReason || r.output || ''
  if (!text) return ''
  return text.length > 80 ? text.slice(0, 80) + '…' : text
}
</script>

<template>
  <div class="watch-overview">
    <header class="overview-header">
      <h2 class="overview-title">{{ t('watch.overviewHeader') }}</h2>
      <p class="overview-subtitle">{{ t('watch.overviewSubtitle') }}</p>
    </header>

    <!-- ============ 异常关切 ============ -->
    <section class="overview-section">
      <div class="section-header">
        <AlertTriangle :size="16" class="section-icon icon-error" />
        <span class="section-title">{{ t('watch.sectionAnomalies') }}</span>
        <span class="section-count" :class="{ 'count-error': anomalies.length > 0 }">{{ anomalies.length }}</span>
      </div>
      <div class="section-body">
        <button
          v-for="w in anomalies"
          :key="w.id"
          class="ov-row ov-row-error"
          @click="emit('select-watch', w.id)"
        >
          <span class="ov-row-dot"></span>
          <div class="ov-row-main">
            <div class="ov-row-line1">
              <span class="ov-row-name">{{ w.name }}</span>
              <span class="ov-row-time">{{ w.lastRun ? formatTimeAgo(w.lastRun.at) : '' }}</span>
            </div>
            <div class="ov-row-line2" v-if="anomalySummary(w)">{{ anomalySummary(w) }}</div>
          </div>
          <ChevronRight :size="14" class="ov-row-arrow" />
        </button>
        <div v-if="anomalies.length === 0" class="ov-empty ov-empty-good">
          <CheckCircle2 :size="14" />
          <span>{{ t('watch.noAnomalies') }}</span>
        </div>
      </div>
    </section>

    <!-- ============ 正在执行 ============ -->
    <section class="overview-section">
      <div class="section-header">
        <RefreshCw :size="16" class="section-icon icon-running" :class="{ spinning: running.length > 0 }" />
        <span class="section-title">{{ t('watch.sectionRunning') }}</span>
        <span class="section-count" :class="{ 'count-running': running.length > 0 }">{{ running.length }}</span>
      </div>
      <div class="section-body">
        <button
          v-for="w in running"
          :key="w.id"
          class="ov-row ov-row-running"
          @click="emit('select-watch', w.id)"
        >
          <span class="ov-row-dot"></span>
          <div class="ov-row-main">
            <div class="ov-row-line1">
              <span class="ov-row-name">{{ w.name }}</span>
              <span class="ov-row-time" v-if="runningDurationText(w)">
                {{ t('watch.runningFor', { d: runningDurationText(w) }) }}
              </span>
            </div>
          </div>
          <ChevronRight :size="14" class="ov-row-arrow" />
        </button>
        <div v-if="running.length === 0" class="ov-empty">
          <span>{{ t('watch.noRunning') }}</span>
        </div>
      </div>
    </section>

    <!-- ============ 即将执行 ============ -->
    <section class="overview-section">
      <div class="section-header">
        <Clock :size="16" class="section-icon" />
        <span class="section-title">{{ t('watch.sectionUpcoming') }}</span>
        <span class="section-count">{{ upcoming.length }}</span>
      </div>
      <div class="section-body">
        <button
          v-for="w in upcoming"
          :key="w.id"
          class="ov-row"
          @click="emit('select-watch', w.id)"
        >
          <span class="ov-row-dot dot-upcoming"></span>
          <div class="ov-row-main">
            <div class="ov-row-line1">
              <span class="ov-row-name">{{ w.name }}</span>
              <span class="ov-row-time">{{ formatUpcoming(w.nextRun as number) }}</span>
            </div>
            <div class="ov-row-line2 muted" v-if="w.nextRun">{{ formatAbsoluteShort(w.nextRun as number) }}</div>
          </div>
          <ChevronRight :size="14" class="ov-row-arrow" />
        </button>
        <div v-if="upcoming.length === 0" class="ov-empty">
          <span>{{ t('watch.noUpcoming') }}</span>
        </div>
      </div>
    </section>

    <!-- ============ 最近流水 ============ -->
    <section class="overview-section">
      <div class="section-header">
        <History :size="16" class="section-icon" />
        <span class="section-title">{{ t('watch.sectionRecent') }}</span>
        <span class="section-count">{{ recentHistory.length }}</span>
      </div>
      <div class="section-body">
        <button
          v-for="r in recentHistory"
          :key="r.id"
          class="ov-row"
          :class="`ov-row-${historyStatusClass(r.status)}`"
          @click="emit('view-history-detail', r)"
        >
          <span class="ov-row-dot"></span>
          <div class="ov-row-main">
            <div class="ov-row-line1">
              <span class="ov-row-name">{{ r.watchName }}</span>
              <span class="ov-row-time">{{ formatTimeAgo(r.at) }}</span>
            </div>
            <div class="ov-row-line2 muted">
              <span class="hist-status">{{ historyStatusLabel(r.status) }}</span>
              <span class="hist-sep" v-if="r.duration > 0">·</span>
              <span v-if="r.duration > 0">{{ formatDuration(r.duration) }}</span>
              <span class="hist-sep" v-if="historySummary(r)">·</span>
              <span class="hist-summary" v-if="historySummary(r)">{{ historySummary(r) }}</span>
            </div>
          </div>
          <ChevronRight :size="14" class="ov-row-arrow" />
        </button>
        <div v-if="recentHistory.length === 0" class="ov-empty">
          <AlertCircle :size="14" />
          <span>{{ t('watch.noHistoryYet') }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.watch-overview {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 20px 24px 32px;
  overflow-y: auto;
  gap: 20px;
}

.overview-header {
  flex-shrink: 0;
}
.overview-title {
  margin: 0 0 4px 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}
.overview-subtitle {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

/* ============ 区块 ============ */

.overview-section {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
  overflow: hidden;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-tertiary, var(--bg-secondary));
}
.section-icon { color: var(--text-secondary); flex-shrink: 0; }
.section-icon.icon-error { color: #e74c3c; }
.section-icon.icon-running { color: var(--accent-primary); }
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  flex: 1;
}
.section-count {
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  padding: 2px 8px;
  border-radius: 9px;
  background: var(--bg-hover);
  color: var(--text-secondary);
  min-width: 22px;
  text-align: center;
}
.section-count.count-error { background: rgba(231, 76, 60, 0.18); color: #e74c3c; }
.section-count.count-running { background: rgba(var(--accent-rgb, 137, 180, 250), 0.2); color: var(--accent-primary); }

.section-body {
  display: flex;
  flex-direction: column;
}

/* ============ 行 ============ */

.ov-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  border-top: 1px solid var(--border-color);
  transition: background 0.12s;
  width: 100%;
  color: inherit;
}
.ov-row:first-of-type { border-top: 0; }
.ov-row:hover { background: var(--bg-hover); }

.ov-row-dot {
  width: 8px; height: 8px; border-radius: 50%;
  margin-top: 6px;
  background: var(--text-muted);
  flex-shrink: 0;
}
.ov-row-success .ov-row-dot { background: #2ecc71; }
.ov-row-error   .ov-row-dot { background: #e74c3c; }
.ov-row-warning .ov-row-dot { background: #f39c12; }
.ov-row-running .ov-row-dot {
  background: var(--accent-primary);
  animation: ov-pulse 1.4s ease-in-out infinite;
}
.dot-upcoming { background: var(--accent-primary); opacity: 0.55; }

.ov-row-main { flex: 1; min-width: 0; }

.ov-row-line1 {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}
.ov-row-name {
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.ov-row-time {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.ov-row-line2 {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-row-line2.muted { color: var(--text-muted); }
.ov-row-error .ov-row-line2 { color: #e74c3c; }

.hist-status { font-weight: 500; }
.hist-sep { margin: 0 6px; }
.hist-summary { color: var(--text-muted); }

.ov-row-arrow {
  margin-top: 4px;
  color: var(--text-muted);
  flex-shrink: 0;
  opacity: 0.6;
}
.ov-row:hover .ov-row-arrow { opacity: 1; }

/* ============ 空状态 ============ */

.ov-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 18px 14px;
  font-size: 12px;
  color: var(--text-muted);
}
.ov-empty-good { color: #2ecc71; }

@keyframes ov-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.4; transform: scale(0.85); }
}

.spinning { animation: ov-spin 1s linear infinite; }
@keyframes ov-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
</style>
