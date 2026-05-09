<script setup lang="ts">
/**
 * 「活图」渲染器：把 chart skill 投递的 EChartsStepPayload 在浏览器里实例化为
 * ECharts 实例，提供 tooltip / legend toggle / dataZoom 等原生交互能力，并暴露
 * getDataURL() 给父组件用来"复制图片 / 另存为"以及大图预览。
 *
 * 关键设计：
 * - 懒加载 echarts（~1MB 包体积），首次见到活图时才发起动态 import；后续命中模块缓存
 * - SVG renderer：与后端 SSR 视觉一致（chart skill 已把主题 inline 到 option），保留矢量
 *   清晰度的同时 getDataURL({type:'png'}) 也能输出高 DPI PNG（echarts 内部转 canvas）
 * - DynamicScroller 离屏会 unmount —— 自动 dispose，无需我们做 IntersectionObserver
 * - ResizeObserver 让容器尺寸变化时自动 resize，保证图表填满容器
 * - 使用 aspectRatio 锁宽高比，避免 echarts.init 在 offsetHeight 为 0 时拿不到尺寸
 *   （CSS aspect-ratio 比 padding-bottom hack 干净，且现代浏览器支持充分）
 *
 * 为什么不在缩略图里禁用动画 / 交互：因为活图的核心价值就是"用户能直接 hover 看
 * 数值"，缩略图也得是活的。echarts SVG renderer 在常见图表（几百到几千数据点）下
 * 性能足够，对话里同屏几个活图无压力。
 */
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { EChartsStepPayload } from '@shared/types'
import { createLogger } from '../utils/logger'

const log = createLogger('EChartsCanvas')
const { t } = useI18n()

/**
 * 缩略图最大宽度（px）。把活图嵌进对话气泡时如果完全跟随后端建议尺寸，
 * 大画布（如全年日 K 4800px）会撑爆气泡；这里一刀切到 480 让所有缩略图大小受控，
 * 超过此宽度的图按比例缩小。预览模态不受此限制（由 .image-preview-echarts 的 90vw 控制）。
 */
const THUMBNAIL_MAX_WIDTH_PX = 480

const props = defineProps<{
  payload: EChartsStepPayload
  /**
   * thumb：对话气泡里的小图（CSS 限制最大宽度，避免占满气泡）
   * preview：大图预览模态（充满预览容器，由父级约束）
   */
  mode?: 'thumb' | 'preview'
  /** 用于 a11y / 错误兜底 alt 文本 */
  alt?: string
}>()

const emit = defineEmits<{
  /** 单击触发大图预览，dataUrl 是当前图的 PNG dataURL（@2x） */
  preview: [dataUrl: string]
  /** 右键触发图片菜单，dataUrl 同上 —— 父组件用 useImageActions 复制 / 另存为 */
  contextmenu: [data: { event: MouseEvent; dataUrl: string }]
}>()

// 锁宽高比，让容器即使在父级没明确高度时也有可量算的尺寸（echarts.init 依赖 offsetHeight）
const containerStyle = computed(() => {
  const ratio = props.payload.width / Math.max(1, props.payload.height)
  if (props.mode === 'preview') {
    // 充满父容器宽度（父容器自己用 max-width: 90vw 等约束最大尺寸），高度跟 aspect-ratio
    return { aspectRatio: `${ratio}`, width: '100%' }
  }
  // 缩略图最多占 THUMBNAIL_MAX_WIDTH_PX，但保留后端建议尺寸作为天花板（小图不放大）
  return {
    aspectRatio: `${ratio}`,
    maxWidth: `min(${props.payload.width}px, ${THUMBNAIL_MAX_WIDTH_PX}px)`,
    width: '100%'
  }
})

const containerRef = ref<HTMLDivElement | null>(null)
const renderError = ref<string | null>(null)

// echarts 实例与 ResizeObserver 用普通变量保存（不需要响应式追踪），减少 Vue 代理开销
let chartInstance: import('echarts').ECharts | null = null
let resizeObserver: ResizeObserver | null = null
// 防竞态：组件已经 unmount 后异步 import 才完成时，丢弃这次 init
let disposed = false

async function ensureChart(): Promise<void> {
  if (!containerRef.value || disposed) return
  // 防 0×0 init：DynamicScroller 虚拟滚动场景下，组件 mount 时容器可能仍未完成布局
  // （aspect-ratio 需要至少一帧才生效；scroller 自身有时也会先把高度设为 0 再撑开）。
  // echarts.init 接到 0×0 容器会渲染空白且不会自愈。直接退出，等下面 ResizeObserver
  // 看到容器变非零尺寸时再触发本函数 —— 那时既能 init 也能补上 setOption
  if (containerRef.value.offsetWidth === 0 || containerRef.value.offsetHeight === 0) {
    return
  }
  try {
    const echarts = await import('echarts')
    if (disposed || !containerRef.value) return

    if (!chartInstance) {
      chartInstance = echarts.init(containerRef.value, null, { renderer: 'svg' })
    }
    // notMerge:true 避免重渲染时旧 option 字段残留；lazyUpdate:true 把 setOption 推迟到
    // 下一帧合并，对话流里多个图同时初始化时减少卡顿
    chartInstance.setOption(props.payload.option, { notMerge: true, lazyUpdate: true })
    renderError.value = null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('Failed to render echarts:', msg)
    renderError.value = msg
  }
}

onMounted(() => {
  if (!containerRef.value) return
  // ResizeObserver 在 onMounted 立即创建并 observe：observe 后会立刻同步触发一次回调
  // 报告当前尺寸，所以无论容器是 0×0 还是已经有尺寸，逻辑都统一在 callback 里处理
  // —— 不需要 RAF + 主动调 ensureChart 的双轨路径
  resizeObserver = new ResizeObserver(() => {
    if (disposed) return
    if (!chartInstance) {
      // 还没 init —— 容器有尺寸时尝试 init + setOption，反复 0×0 时只会反复 noop
      void ensureChart()
    } else {
      chartInstance.resize()
    }
  })
  resizeObserver.observe(containerRef.value)
})

watch(
  () => props.payload.option,
  () => { void ensureChart() },
  // option 是后端一次性产物，引用变化即视为内容变化；不开 deep 避免每次深比较开销
  { deep: false }
)

onBeforeUnmount(() => {
  disposed = true
  resizeObserver?.disconnect()
  resizeObserver = null
  chartInstance?.dispose()
  chartInstance = null
})

/**
 * 把当前图导出成 dataURL。
 *   - PNG：默认 @2x（pixelRatio=2），剪贴板/Word/PPT 缩放显示后依旧锐利
 *   - SVG：直接拿 SVG renderer 的字符串，纯矢量
 * 拿不到实例（init 失败 / 还没 init）时返回空串，调用方应自行兜底（用 props.alt 提示）
 */
function getDataURL(type: 'png' | 'svg' = 'png'): string {
  if (!chartInstance) return ''
  // option 里的 backgroundColor 是 chart skill 的 applyCommon 注入的（light=#fff / dark=#0c0e12）；
  // PNG 显式传入避免某些 echarts 版本忽略 option 内的 backgroundColor 导致透明背景被剪贴板渲染成黑底
  const bg = (props.payload.option.backgroundColor as string | undefined) ?? '#ffffff'
  return chartInstance.getDataURL({ type, pixelRatio: 2, backgroundColor: bg })
}

defineExpose({ getDataURL })

function handleClick(): void {
  const dataUrl = getDataURL('png')
  if (dataUrl) emit('preview', dataUrl)
}

function handleContextMenu(e: MouseEvent): void {
  e.preventDefault()
  e.stopPropagation()
  const dataUrl = getDataURL('png')
  if (dataUrl) emit('contextmenu', { event: e, dataUrl })
}
</script>

<template>
  <div
    ref="containerRef"
    class="echarts-canvas"
    :class="{ 'is-preview': mode === 'preview' }"
    :style="containerStyle"
    :title="alt"
    @click="handleClick"
    @contextmenu="handleContextMenu"
  >
    <div v-if="renderError" class="echarts-canvas-error">
      <span>{{ t('ai.echartsCanvas.renderFailed') }}</span>
      <small>{{ renderError }}</small>
    </div>
  </div>
</template>

<style scoped>
.echarts-canvas {
  display: block;
  border-radius: 6px;
  cursor: pointer;
  background: var(--bg-secondary, #1e1e1e);
  transition: transform 0.15s, box-shadow 0.15s;
  overflow: hidden;
  position: relative;
}

.echarts-canvas:hover {
  transform: scale(1.01);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.echarts-canvas.is-preview {
  cursor: default;
  /* 大图预览容器尺寸由父模态约束；hover 阴影/缩放在那里都不需要 */
  transform: none !important;
  box-shadow: none !important;
}

.echarts-canvas-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px;
  font-size: 12px;
  color: var(--text-muted, #888);
  text-align: center;
}

.echarts-canvas-error small {
  font-size: 10px;
  opacity: 0.7;
  word-break: break-all;
  max-width: 100%;
}
</style>
