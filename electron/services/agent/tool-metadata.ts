/**
 * 工具元数据消费层（formatter / lookup helpers）
 *
 * 这是 Agent 基类访问"具体工具差异"的**唯一通道**。任何想"按工具名做行为分支"
 * 的代码都应改为读 `ToolMeta` 字段（在工具自己的 `_meta` 上声明），通过本文件提供的
 * helper 完成查询/渲染，从而保持 Agent 抽象基类对具体工具完全无感。
 *
 * 对应 SPEC.md「工具元数据驱动模型」一节。
 *
 * 现有 helper：
 * - getStreamPlaceholder()              "path 未到达时"的占位符文案
 * - buildStreamProgressSuffix(args, fs) 字符数尾缀
 * - formatStreamPreCardFromMeta(meta, args)        预卡片完整内容（前缀 + 尾缀），无 meta 时返回 null（调用方走兜底）
 * - formatToolCallPrefixFromMeta(meta, args)       仅前缀，供执行器 addStep 使用
 * - getMetaByName(tools, name)          从工具列表里按名查 meta
 */
import type { ToolDefinition } from '../ai.service'
import type { ToolDefinitionWithMeta, ToolMeta, ToolStreamDisplay } from './tools'
import { t } from './i18n'

/**
 * 流式预创建卡片中"path 还没流到"时的占位符。
 * path 到达后会被真实路径替换，用户先看到卡片出现、再看到路径填入。
 */
export function getStreamPlaceholder(): string {
  return t('agent.stream_pending_field')
}

/**
 * 计算指定字符串字段累计长度，构造实时进度尾缀，如 ` · 1234 字符`。
 *
 * 文件写入/编辑类工具的 path 是一次性短输出，主要内容藏在看不见的 content/markdown/
 * old_text 里。path 输出完后卡片主文本不再变化，用户会以为卡住；追加一个随 AI 流持续
 * 增长的字符数，让"还在工作"这件事可见。
 *
 * 统一使用字符数（不切换 KB）：数字位数多、每次更新跳动幅度大，能传达强烈的"在动"信号。
 * 不足 100 字符时返回空串，避免 path 刚流完就开始抖动。
 */
export function buildStreamProgressSuffix(parsed: Record<string, unknown>, fields: string[]): string {
  if (fields.length === 0) return ''
  let chars = 0
  for (const f of fields) {
    const v = parsed[f]
    if (typeof v === 'string') chars += v.length
  }
  if (chars < 100) return ''
  return ` · ${chars} ${t('file.chars')}`
}

/**
 * 解析 streamDisplay.titleKey（可能是 string 或 (args) => string）成最终 i18n 键。
 */
function resolveTitleKey(titleKey: ToolStreamDisplay['titleKey'], args: Record<string, unknown>): string {
  return typeof titleKey === 'function' ? titleKey(args) : titleKey
}

/**
 * 仅渲染前缀（标题 + 副标题），不附加进度尾缀。
 *
 * 用途：执行器 addStep 的 content 第一段。执行器可在此前缀后追加运行时信息
 *（如 excel 的「（N 个 Sheet）」），但 prefix 部分必须经过本函数生成，
 * 才能保证和流式 pre-card 的对齐契约不漂移。
 *
 * 返回 null 表示该工具未声明 streamDisplay，调用方应自行决定 fallback 文案。
 */
export function formatToolCallPrefixFromMeta(
  meta: ToolMeta | undefined,
  args: Record<string, unknown>
): string | null {
  const display = meta?.streamDisplay
  if (!display) return null
  const title = t(resolveTitleKey(display.titleKey, args))
  if (!display.titleField) return title
  const v = args[display.titleField]
  const subtitle = typeof v === 'string' ? v : getStreamPlaceholder()
  return `${title}: ${subtitle}`
}

/**
 * 完整预卡片内容（前缀 + 字符数尾缀）。
 *
 * 用途：流式 pre-card。返回 null 表示该工具未声明 streamDisplay，
 * 调用方应使用通用兜底（`调用: {toolName}`）。
 */
export function formatStreamPreCardFromMeta(
  meta: ToolMeta | undefined,
  args: Record<string, unknown>
): string | null {
  const prefix = formatToolCallPrefixFromMeta(meta, args)
  if (prefix === null) return null
  const suffix = buildStreamProgressSuffix(args, meta?.streamDisplay?.progressFields ?? [])
  return prefix + suffix
}

/**
 * 在工具列表里按名查 ToolMeta。
 * 工具列表中既可能是 `ToolDefinition`，也可能是 `ToolDefinitionWithMeta`，
 * 本函数兼容处理；找不到（如 MCP / plugin 工具未声明 meta）返回 undefined。
 */
export function getMetaByName(
  tools: readonly ToolDefinition[] | undefined,
  toolName: string
): ToolMeta | undefined {
  if (!tools) return undefined
  for (const tool of tools) {
    if (tool.function.name === toolName) {
      return (tool as ToolDefinitionWithMeta)._meta
    }
  }
  return undefined
}
