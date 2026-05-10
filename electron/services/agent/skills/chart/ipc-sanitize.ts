/**
 * 后端独有：把 ECharts option 转成可以走 Electron IPC 的形态。
 *
 * 对应前端 `shared/utils/echarts-formatters.ts` 的 reify 端，两端共同实现 marker 协议：
 * 后端投递前 sanitize → 前端 setOption 前 reify。详细背景见共享文件文档。
 *
 * 设计要点：
 * - 用 Symbol 在 function 上挂 id 标签（`tagFormatter`），不修改函数行为本身
 * - sanitize 只允许 tagged function 转 marker；陌生 function 一律丢弃，避免任何 eval
 * - 无副作用：sanitize 返回新对象，原 option 不变（让后端 SSR 仍可正常使用 function）
 */

import type { FormatterId } from '../../../../../shared/utils/echarts-formatters'

const FORMATTER_TAG = Symbol('echartsFormatterId')

/**
 * 给 formatter function 打上 id 标签，让后端 SSR 能直接调用、IPC 投递时也能识别 id。
 * 对同一 fn 重复打 tag 是 idempotent 的（写同一 Symbol 值）。
 */
export function tagFormatter<F extends (...args: unknown[]) => unknown>(id: FormatterId, fn: F): F {
  ;(fn as unknown as Record<symbol, FormatterId>)[FORMATTER_TAG] = id
  return fn
}

function getFormatterTag(fn: Function): FormatterId | undefined {
  return (fn as unknown as Record<symbol, FormatterId>)[FORMATTER_TAG]
}

/**
 * 递归遍历 option，把 tagged function 替换为 { __echartsFn: id } marker，
 * 把陌生 function 替换为 undefined（让 echarts 走默认 formatter）。
 * 返回深度复制后的新对象，原 option 不变。
 */
export function sanitizeOptionForIpc(option: unknown): unknown {
  if (Array.isArray(option)) {
    return option.map(sanitizeOptionForIpc)
  }
  if (typeof option === 'function') {
    const id = getFormatterTag(option)
    return id ? { __echartsFn: id } : undefined
  }
  if (typeof option === 'object' && option !== null) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(option)) {
      const cleaned = sanitizeOptionForIpc((option as Record<string, unknown>)[k])
      if (cleaned !== undefined) out[k] = cleaned
    }
    return out
  }
  return option
}

/**
 * 自由路径专用：递归删除 option 中所有 `__echartsFn` marker 占位符。
 *
 * 防止 AI 在 render_echarts_option 直传 `{ __echartsFn:'klineTooltip' }` 这类 marker：
 * marker 是 plain object（structuredClone 通得过 isIpcSafeForChart 检查），原样传到前端
 * 后 reifyFormattersForRender 会把内置 formatter（K 线 tooltip 假设 candlestick + bar 结构、
 * volume 数字格式化）装到散点/柱状/折线等其它图上，触发非预期 tooltip 渲染。
 *
 * marker 协议**仅供后端 generate_chart 路径内部使用**（buildOption 时 tagFormatter →
 * sanitizeOptionForIpc 时转 marker）；自由路径在投递前调本函数清理，确保 AI 永远碰不到
 * marker 协议。
 */
export function stripFormatterMarkers<T>(option: T): T {
  return stripImpl(option) as T
}

function stripImpl(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripImpl)
  }
  if (typeof node === 'object' && node !== null) {
    if ('__echartsFn' in node) return undefined
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(node)) {
      const cleaned = stripImpl((node as Record<string, unknown>)[k])
      if (cleaned !== undefined) out[k] = cleaned
    }
    return out
  }
  return node
}
