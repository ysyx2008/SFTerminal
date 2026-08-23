<script setup lang="ts">
/**
 * 就近帮助：一个小触发器，点开在旁边浮出一段说明。
 *
 * 用于"怎么拿到这个凭证 / 这一步在对方后台怎么点"这类内容——它只在用户
 * 正在填这一项时才有意义，常年铺在页面底部只会变成一堵与当前操作无关的文字墙。
 *
 * 浮层挂到 body 并用视口坐标定位，因为设置卡片普遍开着 overflow: hidden
 * 来裁圆角，留在原地会被裁掉。
 */
import { ref, computed, onBeforeUnmount, nextTick } from 'vue'
import { HelpCircle, X } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    /** 触发器文字；不传则只显示图标 */
    label?: string
    /** 浮层标题 */
    title?: string
    /** 浮层宽度 */
    width?: number
  }>(),
  { width: 380 }
)

const open = ref(false)
const triggerEl = ref<HTMLElement | null>(null)
const pos = ref({ top: 0, left: 0, maxHeight: 0 })

const MARGIN = 8

function place() {
  const el = triggerEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight

  // 左边缘对齐触发器，越界则向左收，始终留出边距
  const left = Math.max(MARGIN, Math.min(r.left, vw - props.width - MARGIN))

  const below = vh - r.bottom - MARGIN * 2
  const above = r.top - MARGIN * 2
  // 下方放不下且上方更宽裕时翻到上方；高度按可用空间封顶，内部滚动
  const useAbove = below < 200 && above > below
  const maxHeight = Math.max(160, useAbove ? above : below)
  const top = useAbove ? Math.max(MARGIN, r.top - MARGIN - maxHeight) : r.bottom + MARGIN

  pos.value = { top, left, maxHeight }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

// 任意祖先滚动都会让浮层与触发器脱节，捕获阶段监听以覆盖内层滚动容器
function close() {
  if (!open.value) return
  open.value = false
  window.removeEventListener('scroll', close, true)
  window.removeEventListener('resize', close)
  document.removeEventListener('keydown', onKeydown, true)
}

async function toggle() {
  if (open.value) {
    close()
    return
  }
  open.value = true
  await nextTick()
  place()
  window.addEventListener('scroll', close, true)
  window.addEventListener('resize', close)
  document.addEventListener('keydown', onKeydown, true)
}

onBeforeUnmount(close)

const panelStyle = computed(() => ({
  top: `${pos.value.top}px`,
  left: `${pos.value.left}px`,
  width: `${props.width}px`,
  maxHeight: `${pos.value.maxHeight}px`,
}))
</script>

<template>
  <button
    ref="triggerEl"
    type="button"
    class="sf-help-trigger"
    :class="{ 'is-open': open, 'is-icon-only': !label }"
    :aria-expanded="open"
    @click.stop="toggle"
  >
    <HelpCircle :size="13" />
    <span v-if="label">{{ label }}</span>
  </button>

  <Teleport to="body">
    <template v-if="open">
      <div class="sf-help-backdrop" @click="close" />
      <div class="sf-help-panel settings-scope" :style="panelStyle" @click.stop>
        <header v-if="title" class="sf-help-head">
          <span class="sf-help-title">{{ title }}</span>
          <button type="button" class="sf-help-close" @click="close">
            <X :size="14" />
          </button>
        </header>
        <div class="sf-help-body">
          <slot />
        </div>
      </div>
    </template>
  </Teleport>
</template>

<style scoped>
.sf-help-trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 2px var(--sp-2) 2px var(--sp-1);
  font-family: inherit;
  font-size: var(--fs-desc);
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease;
}

/* 只有图标时左右留白必须相等，否则挤在表头或标签旁边会明显偏心 */
.sf-help-trigger.is-icon-only {
  padding: 2px;
  border-radius: var(--radius-full);
}

.sf-help-trigger:hover,
.sf-help-trigger.is-open {
  color: var(--accent-primary);
  background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
}

.sf-help-trigger:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 1px;
}

/* 透明遮罩只负责"点外面关掉"，不压暗界面——帮助是辅助，不该打断当前操作 */
.sf-help-backdrop {
  position: fixed;
  inset: 0;
  z-index: 3000;
}

.sf-help-panel {
  position: fixed;
  z-index: 3001;
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}

.sf-help-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-3) var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--border-color);
}

.sf-help-title {
  font-size: var(--fs-label);
  font-weight: 600;
  color: var(--text-primary);
}

.sf-help-close {
  display: inline-flex;
  padding: var(--sp-1);
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.sf-help-close:hover {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

.sf-help-body {
  padding: var(--sp-4);
  overflow-y: auto;
  font-size: var(--fs-desc);
  line-height: 1.6;
  color: var(--text-secondary);
}

/* 帮助内容最常见的形态就是"照着做"的步骤表，直接在这里定好，
   免得每个用到的页面各写一份 */
.sf-help-body :deep(ol),
.sf-help-body :deep(ul) {
  margin: 0;
  padding-left: var(--sp-5);
}

.sf-help-body :deep(li) + :deep(li) {
  margin-top: var(--sp-2);
}

.sf-help-body :deep(p) {
  margin: 0 0 var(--sp-3);
}

.sf-help-body :deep(p:last-child) {
  margin-bottom: 0;
}

.sf-help-body :deep(code) {
  padding: 1px 5px;
  font-size: 0.92em;
  background: var(--bg-tertiary);
  border-radius: 4px;
}
</style>
