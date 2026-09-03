<script setup lang="ts">
/**
 * 待办截止日期选择器 —— Electron 原生 type=date 日历经常弹不出来，这里用自绘月历。
 * 值是本地日历日 YYYY-MM-DD；空字符串表示未设。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  modelValue: string
  variant?: 'field' | 'compact'
  disabled?: boolean
}>(), {
  variant: 'field',
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const { t, locale } = useI18n()

const open = ref(false)
const triggerRef = ref<HTMLButtonElement | null>(null)
const popoverRef = ref<HTMLElement | null>(null)
const popoverStyle = ref<Record<string, string>>({})
const viewYear = ref(new Date().getFullYear())
const viewMonth = ref(new Date().getMonth())

function toYmd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseYmd(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  const day = Number(m[3])
  const d = new Date(y, mo, day)
  if (d.getFullYear() !== y || d.getMonth() !== mo || d.getDate() !== day) return null
  return d
}

function weekStartsOn(tag: string): number {
  try {
    const loc = new Intl.Locale(tag) as Intl.Locale & { weekInfo?: { firstDay?: number } }
    const first = loc.weekInfo?.firstDay
    if (first == null) return tag.startsWith('zh') ? 1 : 0
    return first === 7 ? 0 : first
  } catch {
    return tag.startsWith('zh') ? 1 : 0
  }
}

const selectedYmd = computed(() => parseYmd(props.modelValue) ? props.modelValue.trim() : '')
const todayYmd = computed(() => toYmd(new Date()))

const displayText = computed(() => {
  const d = parseYmd(selectedYmd.value)
  if (!d) return ''
  return new Intl.DateTimeFormat(locale.value, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
})

const monthTitle = computed(() =>
  new Intl.DateTimeFormat(locale.value, { year: 'numeric', month: 'long' }).format(
    new Date(viewYear.value, viewMonth.value, 1)
  )
)

const weekdayLabels = computed(() => {
  const start = weekStartsOn(String(locale.value))
  const fmt = new Intl.DateTimeFormat(locale.value, { weekday: 'narrow' })
  return Array.from({ length: 7 }, (_, i) => {
    const day = (start + i) % 7
    return fmt.format(new Date(2024, 0, 7 + day))
  })
})

type DayCell = { ymd: string; day: number; inMonth: boolean }

const cells = computed<DayCell[]>(() => {
  const start = weekStartsOn(String(locale.value))
  const first = new Date(viewYear.value, viewMonth.value, 1)
  const offset = (first.getDay() - start + 7) % 7
  const origin = new Date(viewYear.value, viewMonth.value, 1 - offset)
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(origin.getFullYear(), origin.getMonth(), origin.getDate() + i)
    return {
      ymd: toYmd(d),
      day: d.getDate(),
      inMonth: d.getMonth() === viewMonth.value,
    }
  })
})

function syncViewToValue() {
  const d = parseYmd(selectedYmd.value) ?? new Date()
  viewYear.value = d.getFullYear()
  viewMonth.value = d.getMonth()
}

function placePopover() {
  const trigger = triggerRef.value
  const pop = popoverRef.value
  if (!trigger || !pop) return
  const rect = trigger.getBoundingClientRect()
  const pad = 8
  const gap = 6
  const w = pop.offsetWidth || 260
  const h = pop.offsetHeight || 280
  let left = rect.left
  if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad
  if (left < pad) left = pad
  let top = rect.bottom + gap
  if (top + h > window.innerHeight - pad) top = rect.top - h - gap
  if (top < pad) top = pad
  popoverStyle.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
  }
}

function close() {
  open.value = false
}

function toggle() {
  if (props.disabled) return
  if (open.value) {
    close()
    return
  }
  syncViewToValue()
  open.value = true
  nextTick(() => {
    placePopover()
    requestAnimationFrame(placePopover)
  })
}

function pick(ymd: string) {
  emit('update:modelValue', ymd)
  close()
}

function pickToday() {
  pick(todayYmd.value)
}

function clearDate() {
  emit('update:modelValue', '')
  close()
}

function shiftMonth(delta: number) {
  const d = new Date(viewYear.value, viewMonth.value + delta, 1)
  viewYear.value = d.getFullYear()
  viewMonth.value = d.getMonth()
  nextTick(placePopover)
}

function onPointerDown(ev: PointerEvent) {
  if (!open.value) return
  const target = ev.target
  if (!(target instanceof Node)) {
    close()
    return
  }
  if (popoverRef.value?.contains(target) || triggerRef.value?.contains(target)) return
  close()
}

function onKeydown(ev: KeyboardEvent) {
  if (!open.value) return
  if (ev.key !== 'Escape') return
  ev.preventDefault()
  ev.stopImmediatePropagation()
  close()
}

function onViewportChange() {
  if (open.value) placePopover()
}

watch(open, (isOpen) => {
  if (isOpen) {
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeydown, true)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
  } else {
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('resize', onViewportChange)
    window.removeEventListener('scroll', onViewportChange, true)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
})
</script>

<template>
  <div class="todo-date" :class="[`is-${variant}`, { open, filled: !!selectedYmd }]">
    <button
      ref="triggerRef"
      type="button"
      class="todo-date-trigger"
      :class="variant"
      :disabled="disabled"
      :aria-expanded="open"
      aria-haspopup="dialog"
      :title="displayText || t('todoPanel.dueDate')"
      @click="toggle"
    >
      <Calendar :size="14" class="todo-date-icon" />
      <span v-if="variant === 'field' || selectedYmd" class="todo-date-text">
        {{ displayText || t('todoPanel.datePicker.placeholder') }}
      </span>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="popoverRef"
        class="todo-date-popover"
        role="dialog"
        :aria-label="t('todoPanel.dueDate')"
        :style="popoverStyle"
      >
        <div class="cal-head">
          <button type="button" class="nav-btn" :title="t('todoPanel.datePicker.prevMonth')" @click="shiftMonth(-1)">
            <ChevronLeft :size="16" />
          </button>
          <span class="cal-title">{{ monthTitle }}</span>
          <button type="button" class="nav-btn" :title="t('todoPanel.datePicker.nextMonth')" @click="shiftMonth(1)">
            <ChevronRight :size="16" />
          </button>
        </div>

        <div class="cal-weekdays">
          <span v-for="(label, i) in weekdayLabels" :key="i" class="weekday">{{ label }}</span>
        </div>

        <div class="cal-grid">
          <button
            v-for="cell in cells"
            :key="cell.ymd"
            type="button"
            class="day"
            :class="{
              muted: !cell.inMonth,
              today: cell.ymd === todayYmd,
              selected: cell.ymd === selectedYmd,
            }"
            @click="pick(cell.ymd)"
          >
            {{ cell.day }}
          </button>
        </div>

        <div class="cal-foot">
          <button type="button" class="foot-btn" @click="pickToday">{{ t('todoPanel.dueToday') }}</button>
          <button type="button" class="foot-btn" :disabled="!selectedYmd" @click="clearDate">
            {{ t('todoPanel.datePicker.clear') }}
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.todo-date {
  display: flex;
  min-width: 0;
}
.todo-date.is-compact {
  height: 100%;
  flex-shrink: 0;
  border-left: 1px solid var(--border-color);
}

.todo-date-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  padding: 0;
}
.todo-date-trigger:disabled {
  opacity: 0.5;
  cursor: default;
}

.todo-date-trigger.field {
  width: 100%;
  box-sizing: border-box;
  border-radius: 7px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
  padding: 7px 9px;
  outline: none;
}
.todo-date-trigger.field:focus-visible,
.todo-date.is-field.open .todo-date-trigger.field {
  border-color: color-mix(in srgb, var(--accent-primary) 50%, var(--border-color));
}
.todo-date-trigger.field .todo-date-text {
  flex: 1;
  text-align: left;
}
.todo-date.is-field:not(.filled) .todo-date-text {
  color: var(--text-muted);
}

.todo-date-trigger.compact {
  height: 100%;
  min-width: 34px;
  padding: 0 8px;
  color: var(--text-muted);
}
.todo-date.is-compact.filled .todo-date-trigger.compact {
  color: var(--accent-primary);
  min-width: 100px;
}
.todo-date-trigger.compact .todo-date-text {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.todo-date-icon {
  flex-shrink: 0;
}

.todo-date-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

<style>
.todo-date-popover {
  position: fixed;
  z-index: 10000;
  width: 260px;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  box-shadow: 0 12px 32px color-mix(in srgb, #000 28%, transparent);
  box-sizing: border-box;
}
.todo-date-popover .cal-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.todo-date-popover .cal-title {
  flex: 1;
  text-align: center;
  font-size: 13px;
  font-weight: 600;
}
.todo-date-popover .nav-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.todo-date-popover .nav-btn:hover {
  background: color-mix(in srgb, var(--text-primary) 8%, transparent);
  color: var(--text-primary);
}
.todo-date-popover .cal-weekdays,
.todo-date-popover .cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
}
.todo-date-popover .weekday {
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--text-muted);
}
.todo-date-popover .day {
  height: 30px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.todo-date-popover .day:hover {
  background: color-mix(in srgb, var(--text-primary) 8%, transparent);
}
.todo-date-popover .day.muted {
  color: var(--text-muted);
}
.todo-date-popover .day.today:not(.selected) {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-primary) 55%, transparent);
}
.todo-date-popover .day.selected {
  background: var(--accent-primary);
  color: #fff;
}
.todo-date-popover .cal-foot {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
}
.todo-date-popover .foot-btn {
  border: none;
  background: transparent;
  color: var(--accent-primary);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
}
.todo-date-popover .foot-btn:disabled {
  color: var(--text-muted);
  cursor: default;
}
</style>
