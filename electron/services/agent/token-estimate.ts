/**
 * Token 估算纯函数
 *
 * 口径:UTF-8 字节数 ÷ 4。BPE 分词本就在 UTF-8 字节序列上做合并,token 数与字节数
 * 的相关性远高于与字符数的相关性——这也是 Codex Harness 采用的口径。
 *
 * 实测校准（qwen3.8-27b,真实 API prompt_tokens 对账,见 scripts/calibrate-context-estimate.js）:
 *   工具 schema 24.7K 字符  真实 9549  字节法 9542（-0.1%）  旧字符法 18170（+90%）
 *   system prompt 8.3K 字符 真实 4033  字节法 4152（+3.0%）  旧字符法  7754（+92%）
 *   纯中文正文              真实  959  字节法 1305（+36%）   旧字符法  2490（+160%）
 *
 * 旧口径按字符数算（中文 1.5、其他 0.5),对中英文双双大幅高估;真实上下文里
 * 高估会与「漏算工具清单」的低估互相抵消,掩盖了两处错误。纯中文仍偏高 36%
 * （现代中文分词约 5.4 字节/token),但真实对话是中英文 + 代码 + JSON 混合,
 * 混合内容下误差收敛到几个百分点。
 *
 * 这是**粗略估算,不是精确计数**。真正的用量以 API 返回的 prompt_tokens 为准,
 * 本估算只在够不着真实值的地方兜底（冷启动首轮、上次响应之后的新增消息）。
 *
 * 注:`knowledge/chunker.ts` 另有一份 0.25 系数的估算,服务于知识分块的不同用途,刻意不并入。
 */

/** 经验常数:平均每个 token 约 4 个 UTF-8 字节 */
const APPROX_BYTES_PER_TOKEN = 4

export function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0
  return Math.ceil(Buffer.byteLength(text, 'utf8') / APPROX_BYTES_PER_TOKEN)
}
