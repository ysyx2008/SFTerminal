/**
 * ECharts 服务端 SVG 渲染封装
 *
 * 通过 echarts v6+ 内置的 SSR 模式，在 Node.js 主进程中无 DOM、无 canvas
 * 直接渲染出 SVG 字符串，再由调用方编码成 data URL 或落盘。
 *
 * echarts 是技能首次使用时由 init() 动态 import 的，避免拖慢 Electron 冷启动。
 */

import type { EChartsOption } from './render'

export interface RenderSize {
  width: number
  height: number
}

/**
 * echarts 命名空间的最小子集类型，避免在本文件强依赖 echarts 类型。
 * echarts 实例真正持有 setOption / renderToSVGString / dispose。
 */
interface EChartsLike {
  init(
    dom: null,
    theme: null,
    opts: { renderer: 'svg'; ssr: true; width: number; height: number }
  ): {
    setOption(option: EChartsOption): void
    renderToSVGString(): string
    dispose(): void
  }
}

let echartsModule: EChartsLike | null = null

/**
 * 懒加载 echarts。在 skill init() 中预热一次，避免首次调用工具时延时。
 *
 * echarts 在不同打包模式下导出形态不一：
 *   - CJS：require('echarts') 直接拿到 namespace（含 init 等顶层方法）
 *   - ESM 动态 import：可能是 namespace，可能在 .default 里包一层
 * 通过运行时探测「是否存在 init 函数」来决定取哪一层，避免硬绑定 .default。
 */
export async function loadEcharts(): Promise<EChartsLike> {
  if (echartsModule) return echartsModule
  const mod = await import('echarts')
  const candidate = mod as unknown as Record<string, unknown> & { default?: unknown }
  const ns = (typeof candidate.init === 'function' ? candidate : candidate.default) as EChartsLike | undefined
  if (!ns || typeof ns.init !== 'function') {
    throw new Error('Failed to resolve echarts module: init() not found')
  }
  echartsModule = ns
  return ns
}

/**
 * 把一份 ECharts option 渲染成 SVG 字符串。
 * 调用方负责把 option 构造正确，本函数只做渲染 + 资源回收。
 */
export async function renderToSvg(option: EChartsOption, size: RenderSize): Promise<string> {
  const echarts = await loadEcharts()
  const chart = echarts.init(null, null, {
    renderer: 'svg',
    ssr: true,
    width: size.width,
    height: size.height
  })
  try {
    chart.setOption(option)
    return chart.renderToSVGString()
  } finally {
    chart.dispose()
  }
}
