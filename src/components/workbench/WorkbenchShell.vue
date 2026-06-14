<script setup lang="ts">
/**
 * WorkbenchShell —— 工作台通用布局外壳
 *
 * 负责「常驻锚点区 + 可显隐辅助区 + 可拖分隔条」这一固定布局模板，
 * 不认识具体内容（终端/聊天/文档），内容通过具名 slot 注入：
 *   - #anchor：常驻锚点区
 *   - #toggle：可显隐辅助区
 *
 * 行为对齐原 App.vue 的 assistant-split 实现（拖拽比例、过渡、热区均一致）。
 * 终端工作台因有 Terminal Teleport 保命池而走自定义渲染器逃生口，不使用本组件。
 */
import { ref, onUnmounted } from 'vue'

const props = withDefaults(defineProps<{
  /** 辅助区是否可见 */
  toggleVisible: boolean
  /** 辅助区占比（0-1） */
  toggleRatio: number
  /** 辅助区所在侧，默认右侧 */
  toggleSide?: 'left' | 'right'
  /** 拖拽比例下限 */
  minRatio?: number
  /** 拖拽比例上限 */
  maxRatio?: number
}>(), {
  toggleSide: 'right',
  minRatio: 0.2,
  maxRatio: 0.8,
})

const emit = defineEmits<{
  (e: 'update:toggleRatio', ratio: number): void
}>()

const shellRef = ref<HTMLElement | null>(null)

// 当前拖拽的清理函数；拖拽中组件被卸载（如切换 tab）时用于兜底，避免 body 光标/选区状态残留
let activeCleanup: (() => void) | null = null

function startResize(e: MouseEvent) {
  e.preventDefault()
  const startX = e.clientX
  const startRatio = props.toggleRatio
  const container = shellRef.value
  if (!container) return
  const containerWidth = container.getBoundingClientRect().width
  if (containerWidth <= 0) return

  // 右侧辅助区：分隔条右移（delta>0）应缩小辅助区比例；左侧辅助区方向相反
  const dir = props.toggleSide === 'left' ? -1 : 1

  const onMove = (ev: MouseEvent) => {
    const delta = ev.clientX - startX
    const newRatio = Math.max(
      props.minRatio,
      Math.min(props.maxRatio, startRatio - dir * delta / containerWidth)
    )
    emit('update:toggleRatio', newRatio)
  }

  const onUp = () => activeCleanup?.()

  activeCleanup = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    activeCleanup = null
  }

  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

onUnmounted(() => activeCleanup?.())
</script>

<template>
  <div
    ref="shellRef"
    class="workbench-shell"
    :class="`toggle-${toggleSide}`"
  >
    <div
      class="workbench-anchor"
      :style="toggleVisible ? { flex: `0 0 ${(1 - toggleRatio) * 100}%` } : undefined"
    >
      <slot name="anchor" />
    </div>
    <div
      v-show="toggleVisible"
      class="workbench-divider"
      @mousedown="startResize"
    ></div>
    <div
      class="workbench-region"
      :class="{ 'region-open': toggleVisible }"
      :style="toggleVisible ? { flex: `0 0 ${toggleRatio * 100}%` } : undefined"
    >
      <slot name="toggle" />
    </div>
  </div>
</template>

<style scoped>
.workbench-shell {
  display: flex;
  flex-direction: row;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  /* AiPanel system-info-bar 与 ArtifactPanel canvas-header 共用，保证分屏顶栏底边对齐 */
  --workbench-panel-header-height: 38px;
  /* 顶栏内 model-select / 产出物文件选择触发器共用（native select 视觉略大于纯 11px 文本） */
  --workbench-header-select-font-size: 12px;
  --workbench-header-select-height: 22px;
}

/* 左侧辅助区：反转主轴，让 DOM 顺序 anchor→divider→region 在视觉上变成 region→divider→anchor */
.workbench-shell.toggle-left {
  flex-direction: row-reverse;
}

.workbench-anchor {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 300px;
  overflow: hidden;
  transition: flex-basis 0.3s ease;
}

.workbench-divider {
  flex-shrink: 0;
  width: 0;
  position: relative;
  z-index: 2;
  cursor: col-resize;
}

/* 零宽占位，::before 提供 5px 拖拽热区，不占视觉间隙 */
.workbench-divider::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -2px;
  width: 5px;
  background: transparent;
  transition: background 0.25s ease;
}

.workbench-divider:hover::before,
.workbench-divider:active::before {
  background: linear-gradient(
    180deg,
    transparent,
    rgba(var(--accent-rgb, 137, 180, 250), 0.35),
    transparent
  );
}

.workbench-region {
  display: flex;
  flex-basis: 0;
  max-width: 0;
  min-width: 0;
  overflow: hidden;
  opacity: 0;
  transition: flex-basis 0.3s ease, max-width 0.3s ease, opacity 0.25s ease;
}

.workbench-region.region-open {
  min-width: 200px;
  max-width: 100%;
  opacity: 1;
}
</style>

<style>
/* 顶栏模型选择与产出物文件名触发器：同一套 metrics（scoped 子组件无法互引） */
.workbench-shell select.model-select.model-select-sm,
.workbench-shell .artifact-file-select {
  box-sizing: border-box;
  height: var(--workbench-header-select-height, 22px);
  padding: 2px 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  background-color: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--workbench-header-select-font-size, 12px);
  font-weight: inherit;
  line-height: 1.25;
  outline: none;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.workbench-shell select.model-select.model-select-sm {
  max-width: 140px;
  cursor: pointer;
  /* 去掉 macOS 原生 menulist 放大，使 CSS 字号与自定义按钮一致 */
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 2px center;
  background-size: 12px;
  padding-right: 18px;
}

.workbench-shell select.model-select.model-select-sm:hover {
  background-color: var(--bg-surface);
  color: var(--text-primary);
}

.workbench-shell .artifact-file-select {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: min(240px, 100%);
  min-width: 0;
  cursor: pointer;
  text-align: left;
}

.workbench-shell .artifact-file-select:hover,
.workbench-shell .artifact-file-select.active {
  background: var(--hover-bg, rgba(255, 255, 255, 0.06));
  color: var(--text-primary);
}

.workbench-shell .artifact-file-select-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
  font-size: inherit;
  line-height: inherit;
}

.workbench-shell .artifact-file-select-chevron {
  flex-shrink: 0;
  opacity: 0.65;
}

/* 与 AiPanel system-info-bar 内 btn-icon-sm 一致（仅图标按钮，不含文字按钮） */
.workbench-shell button.btn-icon.btn-icon-sm {
  width: 22px;
  height: 22px;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.workbench-shell button.btn-icon.btn-icon-sm:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}
</style>
