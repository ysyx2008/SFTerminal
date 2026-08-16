<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from 'lucide-vue-next'
import type { TodoItem } from '@sailfish/shared-types'
import { useConfigStore } from '../../stores/config'

const props = defineProps<{
  item: TodoItem
  x: number
  y: number
}>()

const emit = defineEmits<{
  handle: []
  schedule: [minutes: number]
  openCalendarSettings: []
  close: []
}>()

const { t } = useI18n()
const configStore = useConfigStore()

const menuEl = ref<HTMLElement | null>(null)
const pos = ref({ x: props.x, y: props.y })
const submenuOpen = ref(false)

const done = computed(() => props.item.status === 'completed' || props.item.status === 'cancelled')
const hasCalendar = computed(() => configStore.calendarAccounts.length > 0)
const scheduleDisabled = computed(() => done.value || !hasCalendar.value)

const durations = [
  { minutes: 30, key: 'todoPanel.menu.duration30' },
  { minutes: 60, key: 'todoPanel.menu.duration60' },
  { minutes: 120, key: 'todoPanel.menu.duration120' },
  { minutes: 240, key: 'todoPanel.menu.durationHalfDay' },
] as const

function clamp() {
  const el = menuEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const pad = 8
  let x = props.x
  let y = props.y
  if (x + rect.width > window.innerWidth - pad) x = Math.max(pad, window.innerWidth - rect.width - pad)
  if (y + rect.height > window.innerHeight - pad) y = Math.max(pad, window.innerHeight - rect.height - pad)
  pos.value = { x, y }
}

watch(() => [props.x, props.y], () => {
  pos.value = { x: props.x, y: props.y }
  nextTick(clamp)
})

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape') {
    ev.preventDefault()
    emit('close')
  }
}

onMounted(() => {
  nextTick(clamp)
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})

function onHandle() {
  if (done.value) return
  emit('handle')
}

function onScheduleClick() {
  if (done.value) return
  if (!hasCalendar.value) {
    emit('openCalendarSettings')
    return
  }
  submenuOpen.value = true
}

function pickDuration(minutes: number) {
  if (scheduleDisabled.value) return
  emit('schedule', minutes)
}
</script>

<template>
  <Teleport to="body">
    <div class="todo-menu-overlay" @click="emit('close')" @contextmenu.prevent="emit('close')" />
    <div
      ref="menuEl"
      class="todo-menu"
      :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <button
        type="button"
        class="todo-menu-item"
        :disabled="done"
        @click="onHandle"
      >
        {{ t('todoPanel.menu.handle') }}
      </button>
      <div
        class="todo-menu-submenu-wrap"
        @mouseenter="submenuOpen = !scheduleDisabled"
        @mouseleave="submenuOpen = false"
      >
        <button
          type="button"
          class="todo-menu-item has-sub"
          :disabled="done"
          :title="!hasCalendar && !done ? t('todoPanel.menu.needCalendar') : undefined"
          @click="onScheduleClick"
        >
          <span>{{ t('todoPanel.menu.schedule') }}</span>
          <ChevronRight :size="12" />
        </button>
        <div v-if="submenuOpen && hasCalendar && !done" class="todo-submenu">
          <button
            v-for="d in durations"
            :key="d.minutes"
            type="button"
            class="todo-menu-item"
            @click="pickDuration(d.minutes)"
          >
            {{ t(d.key) }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.todo-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
}

.todo-menu {
  position: fixed;
  min-width: 148px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);
  padding: 3px;
  z-index: 10000;
}

.todo-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 5px 10px;
  font-size: 12px;
  font-family: inherit;
  line-height: 1.25;
  color: var(--text-primary);
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}

.todo-menu-item:hover:not(:disabled) {
  background: var(--bg-hover);
}

.todo-menu-item:disabled {
  color: var(--text-muted);
  cursor: default;
}

.todo-menu-item.has-sub {
  padding-right: 6px;
}

.todo-menu-submenu-wrap {
  position: relative;
}

.todo-submenu {
  position: absolute;
  left: 100%;
  top: 0;
  min-width: 120px;
  margin-left: 2px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);
  padding: 3px;
  z-index: 10001;
}
</style>
