/**
 * 主动压缩的 AI 小结输入装配（2026-08-06「上下文压缩完善」设计，见 agent/SPEC.md）。
 *
 * 把待归档消息格式化为「只带文字」的紧凑转录：用户消息、assistant 文本、
 * 工具名 + 工具输出头部（落盘指针 notice 在头部，必须让摘要模型看到）。
 * 图片/大块原文不重复送——AI 此前的分析已在对话文字里。
 *
 * 整体超摘要预算时保留头尾（头 = 任务起源，尾 = 最近进展），中间以标记省略；
 * 原始消息仍在 taskMessageLog / 归档里，这里只是给摘要模型看的选段。
 */
import type { AiMessage } from '../ai.service'
import { estimateTextTokens } from './token-estimate'

/** 单条消息字符上限：用户/助手文本 */
const MESSAGE_TEXT_CAP = 2000
/** 单条工具输出头部上限（指针 notice 在头部，500 足够覆盖） */
const TOOL_OUTPUT_HEAD_CAP = 500
/** 工具调用参数头部上限 */
const TOOL_ARGS_HEAD_CAP = 100

/** 从消息提取纯文本（图片以 [图片] 占位，不送摘要） */
function extractText(msg: AiMessage): string {
  const text = msg.content ?? ''
  if (msg.images?.length) {
    return text ? `${text}\n[图片×${msg.images.length}]` : '[图片]'
  }
  return text
}

function head(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap) + '…'
}

/**
 * 待归档消息 → 紧凑文本转录。空转录（无可摘要内容）返回空串。
 */
export function formatMessagesForSummary(messages: AiMessage[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = extractText(msg).trim()
      if (text) lines.push(`[用户] ${head(text, MESSAGE_TEXT_CAP)}`)
    } else if (msg.role === 'assistant') {
      const text = extractText(msg).trim()
      if (text) lines.push(`[助手] ${head(text, MESSAGE_TEXT_CAP)}`)
      if (msg.tool_calls?.length) {
        const calls = msg.tool_calls
          .map(tc => `${tc.function.name}(${head(tc.function.arguments ?? '', TOOL_ARGS_HEAD_CAP)})`)
          .join('; ')
        lines.push(`[助手调用工具] ${head(calls, TOOL_OUTPUT_HEAD_CAP)}`)
      }
    } else if (msg.role === 'tool') {
      const text = extractText(msg).trim()
      if (text) lines.push(`[工具输出] ${head(text, TOOL_OUTPUT_HEAD_CAP)}`)
    }
    // system 消息不进摘要输入
  }
  return lines.join('\n\n')
}

/** 摘要输出预算（字符）：与 aiService.chat 的 max_tokens=2048 对齐 */
export const SUMMARY_OUTPUT_BUDGET_CHARS = 2000

/**
 * 摘要输入整体预算控制：超 budgetTokens 时保留头 40% + 尾 40%（按字符近似），
 * 中间以省略标记隔开。头 = 任务起源，尾 = 最近进展，是摘要最关键的两端。
 */
export function capSummaryInput(text: string, budgetTokens: number): string {
  if (estimateTextTokens(text) <= budgetTokens) return text
  // token ≈ 中英混合字符数的一个比例，用字符数做保守近似：预算字符 = budgetTokens * 2
  // （estimateTextTokens 对中文约 1 字 ≈ 1 token、英文约 4 字符 ≈ 1 token，取 2 偏保守）
  const budgetChars = Math.max(1000, budgetTokens * 2)
  if (text.length <= budgetChars) return text
  const headChars = Math.floor(budgetChars * 0.4)
  const tailChars = Math.floor(budgetChars * 0.4)
  return (
    text.slice(0, headChars) +
    `\n\n[……中间 ${(text.length - headChars - tailChars).toLocaleString()} 字符从摘要输入中省略……]\n\n` +
    text.slice(-tailChars)
  )
}
