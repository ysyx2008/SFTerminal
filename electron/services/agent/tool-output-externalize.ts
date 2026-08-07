/**
 * 长输出落盘 + 指针（2026-08-06「上下文压缩完善」设计，见 agent/SPEC.md）。
 *
 * 工具输出超当前单次预算时：全文写入 scratch/tool-outputs/，对话里只留
 * 「指针 notice + 摘录」（文件类给头部、命令/执行类给尾部），AI 需要完整内容
 * 时用 read_file 分段读回——与 read_file / 子 Agent 结果回收同一心智。
 * 预算内返回 null，调用方原样返回，短输出零打扰。
 *
 * 禁止退回截断：落盘 IO 失败抛错，由调用方转成「明确报错 + 建议缩小范围」的
 * 工具错误，不得把残文当结果返回。
 */
import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from '../../utils/logger'
import { getScratchPath } from './workspace-paths'
import type { ToolOutputBudget } from './tool-output-budget'
import { t } from './i18n'

const log = createLogger('ToolOutputExternalize')

/** notice 预留字符：摘录长度 = maxChars − 该值，保证「notice + 摘录」整体仍在预算内 */
const NOTICE_RESERVE_CHARS = 400

export type OutputExcerptMode = 'head' | 'tail'

export interface ExternalizedOutput {
  /** 替换原输出的文本（指针 notice + 摘录） */
  text: string
  /** 落盘文件路径 */
  filePath: string
  /** 原输出总字符数 */
  totalChars: number
}

/** scratch/tool-outputs/<YYYYMMDD>/<tool>-<HHmmss>-<nonce>.txt；日期分目录便于人工翻阅与过期清理 */
function buildOutputFilePath(toolName: string): string {
  const now = new Date()
  const day = now.toISOString().slice(0, 10).replace(/-/g, '')
  const time = now.toTimeString().slice(0, 8).replace(/:/g, '')
  const nonce = Math.random().toString(36).slice(2, 6)
  const dir = path.join(getScratchPath(), 'tool-outputs', day)
  fs.mkdirSync(dir, { recursive: true })
  const safeTool = toolName.replace(/[^\w-]/g, '_')
  return path.join(dir, `${safeTool}-${time}-${nonce}.txt`)
}

/**
 * 长输出落盘：output 超 budget.maxChars 时把全文写入 scratch，返回指针 + 摘录；
 * 预算内（或空输出）返回 null。budget.maxChars <= 0（上下文余量耗尽）也落盘，
 * 此时只给指针不附摘录。
 *
 * @throws 落盘 IO 失败时抛错（调用方必须转成工具错误，禁止退回截断）
 */
export function externalizeToolOutput(opts: {
  output: string
  budget: ToolOutputBudget
  toolName: string
  excerpt: OutputExcerptMode
}): ExternalizedOutput | null {
  const { output, budget, toolName, excerpt } = opts
  if (!output) return null
  if (budget.maxChars > 0 && output.length <= budget.maxChars) return null

  const filePath = buildOutputFilePath(toolName)
  fs.writeFileSync(filePath, output, 'utf-8')
  log.info(`[${toolName}] output externalized to ${filePath} (${output.length} chars)`)

  const totalChars = output.length
  const total = totalChars.toLocaleString()
  const excerptChars = Math.max(0, budget.maxChars - NOTICE_RESERVE_CHARS)

  if (excerptChars === 0) {
    return {
      text: t('tool_output.externalized_only', { total, path: filePath }),
      filePath,
      totalChars
    }
  }

  const excerptText = excerpt === 'tail' ? output.slice(-excerptChars) : output.slice(0, excerptChars)
  const key = excerpt === 'tail' ? 'tool_output.externalized_tail' : 'tool_output.externalized_head'
  return {
    text: `${t(key, { total, path: filePath })}\n\n${excerptText}`,
    filePath,
    totalChars
  }
}

/**
 * 落盘失败的统一错误文案（调用方 catch 后用作工具 error）。
 */
export function externalizeFailedError(totalChars: number, reason: string): string {
  return t('tool_output.externalize_failed', { total: totalChars.toLocaleString(), reason })
}
