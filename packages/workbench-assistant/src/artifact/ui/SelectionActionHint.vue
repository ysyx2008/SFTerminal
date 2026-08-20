<script setup lang="ts">
/**
 * 选区提示：划完一段后浮在选区旁，告诉用户选完还能做什么。
 * 不占预览高度、不吃指针事件，位置由自身实测尺寸收进预览可视范围。
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Sparkles } from 'lucide-vue-next'
import {
  intersectViewport,
  placeSelectionHint,
  type ContextMenuBox
} from '../domain/context-menu-position'

const props = defineProps<{
  anchor: ContextMenuBox | null
  /** 预览容器：提示不画到它外面 */
  clipEl?: HTMLElement | null
}>()

const { t } = useI18n()

const ESTIMATE = { width: 190, height: 26 }
const hintRef = ref<HTMLElement | null>(null)
const pos = ref({ left: 0, top: 0 })
/** 锚点是视口坐标的快照：预览一滚动就对不上选区了，直接收起 */
const stale = ref(false)
const visible = computed(() => !!props.anchor && !stale.value)

function place(size = ESTIMATE) {
  const anchor = props.anchor
  if (!anchor) return
  pos.value = placeSelectionHint({
    anchor,
    hintWidth: size.width,
    hintHeight: size.height,
    viewport: intersectViewport(props.clipEl?.getBoundingClientRect())
  })
}

function markStale() {
  stale.value = true
}

function bindStaleWatchers(on: boolean) {
  const fn = on ? window.addEventListener : window.removeEventListener
  fn.call(window, 'scroll', markStale, true)
  fn.call(window, 'resize', markStale)
}

watch(
  () => props.anchor,
  (anchor) => {
    stale.value = false
    bindStaleWatchers(!!anchor)
    if (!anchor) return
    place()
    void nextTick(() => {
      const el = hintRef.value
      if (!el) return
      const r = el.getBoundingClientRect()
      place({ width: r.width, height: r.height })
    })
  },
  { immediate: true }
)

onUnmounted(() => bindStaleWatchers(false))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="hintRef"
      class="artifact-selection-hint"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
      aria-hidden="true"
    >
      <Sparkles :size="12" aria-hidden="true" />
      <span>{{ t('canvas.selectionActionHint') }}</span>
    </div>
  </Teleport>
</template>

<style scoped>
.artifact-selection-hint {
  position: fixed;
  z-index: 10040;
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: min(320px, calc(100vw - 24px));
  padding: 4px 9px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 999px;
  background: var(--bg-secondary, #252525);
  color: var(--text-secondary, #bbb);
  font-size: 11px;
  line-height: 1.3;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
  animation: artifactSelectionHintIn 0.12s ease;
}

@keyframes artifactSelectionHintIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
