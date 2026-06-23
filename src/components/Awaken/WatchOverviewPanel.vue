<script setup lang="ts">
/**
 * 关切运营总览仪表盘
 *
 * 在「关切」tab 列表里选中「总览」虚拟项时显示。
 * 一屏看清：下一次执行（hero）→ 异常/运行中状态条 → 即将执行 → 最近流水。
 *
 * 本组件不发起 IPC 调用，全部数据由父组件 Awaken.vue 注入；
 * select-watch 让父组件切换到对应 watch 的详情视图。
 */

import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  AlertTriangle, RefreshCw, Clock, History,
  CheckCircle2, ChevronRight, AlertCircle, RotateCcw
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
  'retry-watch': [id: string]
}>()

const { t, locale } = useI18n()

// ==================== 内置心跳过滤 ====================
// __wakeup__（每 30 分钟一次的心跳）和 __daily_patrol__ 在最近流水里出现频率极高，
// 会把用户配置的关切流水挤出屏幕，因此总览面板里一律隐藏。
const BUILTIN_WATCH_IDS = new Set(['__wakeup__', '__daily_patrol__'])

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

// 即将执行：启用且 nextRun 在未来，按时间正序
const upcomingAll = computed<WatchDefinition[]>(() => {
  const now = Date.now()
  return props.watches
    .filter(w => w.enabled && typeof w.nextRun === 'number' && (w.nextRun as number) > now)
    .sort((a, b) => (a.nextRun ?? 0) - (b.nextRun ?? 0))
})

const UPCOMING_DEFAULT = 5
const upcomingExpanded = ref(false)
const upcoming = computed<WatchDefinition[]>(() =>
  upcomingExpanded.value ? upcomingAll.value : upcomingAll.value.slice(0, UPCOMING_DEFAULT)
)
const upcomingHidden = computed(() =>
  Math.max(0, upcomingAll.value.length - UPCOMING_DEFAULT)
)

// hero：最近的下一次执行（用于顶部突出展示）
const nextRunHero = computed<WatchDefinition | undefined>(() => upcomingAll.value[0])

// 最近流水：过滤掉内置心跳，按 at 倒序，取前 20
const recentHistory = computed<WatchHistoryRecord[]>(() =>
  [...props.history]
    .filter(r => !BUILTIN_WATCH_IDS.has(r.watchId))
    .sort((a, b) => b.at - a.at)
    .slice(0, 20)
)

// 异常 / 运行中均为 0 时算「健康」状态，可折叠为单行徽章
const isHealthy = computed(() => anomalies.value.length === 0 && running.value.length === 0)

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

// 历史摘要：error / skipReason 优先；否则用 output（更克制的截断）
const HISTORY_SUMMARY_MAX = 60
function historySummary(r: WatchHistoryRecord): string {
  const text = (r.error || r.skipReason || r.output || '').trim()
  if (!text) return ''
  return text.length > HISTORY_SUMMARY_MAX ? text.slice(0, HISTORY_SUMMARY_MAX) + '…' : text
}

function selectWatchById(id: string) {
  emit('select-watch', id)
}
</script>

<template>
  <div class="watch-overview">
    <!-- ============ 顶部 hero：下一次执行 + 健康状态 ============ -->
    <header class="overview-hero">
      <div class="hero-left">
        <h2 class="overview-title">{{ t('watch.overviewHeader') }}</h2>
        <p class="overview-subtitle">{{ t('watch.overviewSubtitle') }}</p>
      </div>

      <!-- 健康状况：0 异常 + 0 运行中 时显示「一切就绪」绿色徽章；否则显示具体迷你统计 -->
      <div class="hero-right">
        <div v-if="isHealthy" class="health-pill health-pill-good">
          <CheckCircle2 :size="14" />
          <span>{{ t('watch.overviewHealthAllGood') }}</span>
        </div>
        <template v-else>
          <button
            v-if="anomalies.length > 0"
            class="health-pill health-pill-error"
            :title="t('watch.errorCountBadge', { n: anomalies.length })"
            @click="selectWatchById(anomalies[0].id)"
          >
            <AlertTriangle :size="14" />
            <span class="health-pill-num">{{ anomalies.length }}</span>
            <span class="health-pill-label">{{ t('watch.overviewMiniAnomaly') }}</span>
          </button>
          <div v-if="running.length > 0" class="health-pill health-pill-running">
            <RefreshCw :size="14" class="spinning" />
            <span class="health-pill-num">{{ running.length }}</span>
            <span class="health-pill-label">{{ t('watch.overviewMiniRunning') }}</span>
          </div>
        </template>
      </div>
    </header>

    <!-- ============ 下一次执行（hero card） ============ -->
    <section class="next-run-card" :class="{ empty: !nextRunHero }">
      <div class="next-run-label">
        <Clock :size="14" />
        <span>{{ t('watch.overviewNextRunLabel') }}</span>
      </div>
      <button
        v-if="nextRunHero"
        class="next-run-body"
        @click="selectWatchById(nextRunHero.id)"
      >
        <span class="next-run-name">{{ nextRunHero.name }}</span>
        <span class="next-run-time">
          <span class="next-run-relative">{{ formatUpcoming(nextRunHero.nextRun as number) }}</span>
          <span class="next-run-absolute">{{ formatAbsoluteShort(nextRunHero.nextRun as number) }}</span>
        </span>
        <ChevronRight :size="14" class="next-run-arrow" />
      </button>
      <div v-else class="next-run-empty">
        <span>{{ t('watch.overviewNoUpcoming') }}</span>
      </div>
    </section>

    <!-- ============ 异常关切（仅在 >0 时展开为完整列表） ============ -->
    <section v-if="anomalies.length > 0" class="overview-section">
      <div class="section-header">
        <AlertTriangle :size="16" class="section-icon icon-error" />
        <span class="section-title">{{ t('watch.sectionAnomalies') }}</span>
        <span class="section-count count-error">{{ anomalies.length }}</span>
      </div>
      <div class="section-body">
        <div
          v-for="w in anomalies"
          :key="w.id"
          class="ov-row ov-row-error"
        >
          <span class="ov-row-dot"></span>
          <button class="ov-row-main ov-row-clickable" @click="selectWatchById(w.id)">
            <div class="ov-row-line1">
              <span class="ov-row-name">{{ w.name }}</span>
              <span class="ov-row-time">{{ w.lastRun ? formatTimeAgo(w.lastRun.at) : '' }}</span>
            </div>
            <div class="ov-row-line2" v-if="anomalySummary(w)">{{ anomalySummary(w) }}</div>
          </button>
          <button
            class="ov-retry-btn"
            :disabled="runningWatches.has(w.id)"
            :title="t('watch.retryWatch')"
            @click.stop="emit('retry-watch', w.id)"
          >
            <RotateCcw :size="13" :class="{ spinning: runningWatches.has(w.id) }" />
          </button>
        </div>
      </div>
    </section>

    <!-- ============ 正在执行（仅在 >0 时展开为完整列表） ============ -->
    <section v-if="running.length > 0" class="overview-section">
      <div class="section-header">
        <RefreshCw :size="16" class="section-icon icon-running spinning" />
        <span class="section-title">{{ t('watch.sectionRunning') }}</span>
        <span class="section-count count-running">{{ running.length }}</span>
      </div>
      <div class="section-body">
        <button
          v-for="w in running"
          :key="w.id"
          class="ov-row ov-row-running"
          @click="selectWatchById(w.id)"
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
      </div>
    </section>

    <!-- ============ 即将执行 ============ -->
    <section class="overview-section" v-if="upcomingAll.length > 0">
      <div class="section-header">
        <Clock :size="16" class="section-icon" />
        <span class="section-title">{{ t('watch.sectionUpcoming') }}</span>
        <span class="section-count">{{ upcomingAll.length }}</span>
      </div>
      <div class="section-body">
        <button
          v-for="w in upcoming"
          :key="w.id"
          class="ov-row"
          :title="formatAbsoluteShort(w.nextRun as number)"
          @click="selectWatchById(w.id)"
        >
          <span class="ov-row-dot dot-upcoming"></span>
          <div class="ov-row-main">
            <div class="ov-row-line1">
              <span class="ov-row-name">{{ w.name }}</span>
              <span class="ov-row-time">{{ formatUpcoming(w.nextRun as number) }}</span>
            </div>
          </div>
          <ChevronRight :size="14" class="ov-row-arrow" />
        </button>
        <button
          v-if="upcomingHidden > 0 || upcomingExpanded"
          class="ov-row-toggle"
          @click="upcomingExpanded = !upcomingExpanded"
        >
          {{ upcomingExpanded ? t('watch.overviewShowLess') : t('watch.overviewShowMore', { n: upcomingHidden }) }}
        </button>
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
  padding: 18px 22px 28px;
  overflow-y: auto;
  gap: 14px;
}

/* ============ 顶部 hero：标题 + 健康状态 ============ */

.overview-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-shrink: 0;
}
.hero-left { min-width: 0; }
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

.hero-right {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  align-items: center;
}

.health-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  cursor: default;
}
button.health-pill { cursor: pointer; }
button.health-pill:hover { filter: brightness(1.08); }

.health-pill-good {
  color: var(--brand-vital, #2ecc71);
  background: rgba(46, 204, 113, 0.1);
  border-color: rgba(46, 204, 113, 0.28);
}
.health-pill-error {
  color: var(--brand-alert, #e74c3c);
  background: rgba(231, 76, 60, 0.12);
  border-color: rgba(231, 76, 60, 0.32);
}
.health-pill-running {
  color: var(--accent-primary);
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.14);
  border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.32);
}
.health-pill-num { font-weight: 700; font-variant-numeric: tabular-nums; }
.health-pill-label { opacity: 0.85; }

/* ============ 下一次执行 hero card ============ */

.next-run-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
}
.next-run-card.empty {
  background: transparent;
  border-style: dashed;
}
.next-run-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  letter-spacing: 0.02em;
}
.next-run-body {
  display: flex;
  align-items: center;
  gap: 12px;
  background: transparent;
  border: 0;
  padding: 0;
  text-align: left;
  cursor: pointer;
  color: inherit;
}
.next-run-name {
  flex: 1;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.next-run-time {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  flex-shrink: 0;
}
.next-run-relative {
  font-size: 13px;
  font-weight: 600;
  color: var(--accent-primary);
  font-variant-numeric: tabular-nums;
}
.next-run-absolute {
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.next-run-arrow {
  color: var(--text-muted);
  opacity: 0.6;
}
.next-run-body:hover .next-run-arrow { opacity: 1; }
.next-run-empty {
  font-size: 13px;
  color: var(--text-muted);
  padding: 4px 0;
}

/* ============ 区块 ============ */

.overview-section {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
}

/* sticky section header：滚动时仍能看到当前所在分类 */
.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-tertiary, var(--bg-secondary));
  position: sticky;
  top: 0;
  z-index: 1;
  border-radius: 10px 10px 0 0;
}
.section-icon { color: var(--text-secondary); flex-shrink: 0; }
.section-icon.icon-error { color: var(--brand-alert, #e74c3c); }
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
.section-count.count-error {
  background: rgba(231, 76, 60, 0.18);
  color: var(--brand-alert, #e74c3c);
}
.section-count.count-running {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.2);
  color: var(--accent-primary);
}

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
  box-sizing: border-box;
}
.ov-row:first-of-type { border-top: 0; }
.ov-row:hover { background: var(--bg-hover); }

.ov-row-dot {
  width: 8px; height: 8px; border-radius: 50%;
  margin-top: 6px;
  background: var(--text-muted);
  flex-shrink: 0;
}
.ov-row-success .ov-row-dot { background: var(--brand-vital, #2ecc71); }
.ov-row-error   .ov-row-dot { background: var(--brand-alert, #e74c3c); }
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
.ov-row-error .ov-row-line2 { color: var(--brand-alert, #e74c3c); }

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

.ov-row-clickable {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: 0;
  padding: 0;
  text-align: left;
  cursor: pointer;
  color: inherit;
}

.ov-retry-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--brand-alert, #e74c3c);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, border-color 0.12s;
  margin-top: 2px;
}
.ov-row:hover .ov-retry-btn { opacity: 0.7; }
.ov-retry-btn:hover {
  opacity: 1 !important;
  background: rgba(231, 76, 60, 0.12);
  border-color: rgba(231, 76, 60, 0.32);
}
.ov-retry-btn:disabled {
  opacity: 0.35 !important;
  cursor: not-allowed;
}

/* "展开剩余 N 项" 按钮 */
.ov-row-toggle {
  border: 0;
  background: transparent;
  padding: 8px 14px;
  border-top: 1px solid var(--border-color);
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  text-align: center;
  transition: background 0.12s;
}
.ov-row-toggle:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

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

@keyframes ov-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.4; transform: scale(0.85); }
}

.spinning { animation: ov-spin 1s linear infinite; }
@keyframes ov-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
</style>
