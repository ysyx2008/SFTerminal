/**
 * Token 估算纯函数
 *
 * 估算文本的 token 数:中文字符约 1.5 tokens/字,非中文约 0.5 tokens/字符
 *（URL、路径、JSON、标点等被 tokenizer 切分较碎,取 0.5 作为均值;实测混合数据与
 * API 实际计数误差 < 10%）。
 *
 * 收敛了原先散在 `ContextWindowManager`(上下文窗口管理)与 `context-builder`(任务记忆
 * token 预算)的两份逐字节相同实现——「改一处忘另一处」裂缝消除。
 *
 * 注:`knowledge/chunker.ts` 另有一份 0.25 系数的估算,服务于知识分块的不同用途,刻意不并入。
 */
export function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const otherChars = text.length - chineseChars
  return Math.ceil(chineseChars * 1.5 + otherChars * 0.5)
}
