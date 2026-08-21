/**
 * 主动压缩的 AI 小结输出预算。
 *
 * 小结指令现在直接追加在当前对话末尾发出（见 Agent.summarizeForCompression），
 * 模型在原本的语境里写交接，不再需要把待归档消息拍平成转录文本再截断——
 * 那既拿不到前缀缓存，又得把同一批内容重新输入一遍。
 */

/** 摘要输出预算（字符）：与 aiService.chat 的 max_tokens=2048 对齐 */
export const SUMMARY_OUTPUT_BUDGET_CHARS = 2000
