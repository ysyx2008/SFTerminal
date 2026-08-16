/**
 * 脱敏 —— 把运行时已知的真实值从诊断内容里换掉
 *
 * 原则：以「运行时已知具体真实值的精确替换」为主，不写靠猜语义的关键词正则。
 * 家目录、主机名、登录名、已配置的 SSH 主机与登录名都是运行时确定可知的具体值，
 * 精确替换既不会漏也不会误伤。
 *
 * 唯一的例外是密钥兜底：它匹配的是「固定前缀 + 长串」这种形态明确、无歧义的
 * 字符串，用来兜住日志里意外打印出的密钥，同样不是对自然语言的模式猜测。
 *
 * 不从凭据服务里取明文来做匹配——那会为了脱敏反而把密钥读进处理链路。
 */

export interface RedactionInput {
  homeDir?: string
  hostName?: string
  userName?: string
  /** 其他运行时已知的真实值：已配置的 SSH 主机与登录名、AI 服务域名等 */
  values?: string[]
}

export type Redactor = (text: string) => string

/** 太短的值（两字母登录名之类）精确替换会波及无关文本，宁可不换 */
const MIN_VALUE_LENGTH = 3

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 同一路径在日志里可能以 \ 或 / 出现，Windows 上还大小写不敏感 */
function pathPattern(p: string): RegExp {
  return new RegExp(escapeRegExp(p).replace(/\\\\|\//g, '[\\\\/]'), 'gi')
}

const SECRET_SHAPES: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '<REDACTED-KEY>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, 'Bearer <REDACTED-KEY>'],
]

export function buildRedactor(input: RedactionInput): Redactor {
  const rules: Array<[RegExp, string]> = []

  // 家目录必须先换：它本身就含登录名，先换掉能连带处理绝大多数路径
  if (input.homeDir && input.homeDir.length >= MIN_VALUE_LENGTH) {
    rules.push([pathPattern(input.homeDir), '~'])
  }

  const named: Array<[string, string]> = []
  if (input.hostName) named.push([input.hostName, '<HOST>'])
  if (input.userName) named.push([input.userName, '<USER>'])
  for (const value of input.values ?? []) {
    named.push([value, '<REDACTED>'])
  }

  // 长值先换：短值往往是长值的子串（登录名是主机名或域名的一部分很常见）
  named.sort((a, b) => b[0].length - a[0].length)
  for (const [value, replacement] of named) {
    if (value.length < MIN_VALUE_LENGTH) continue
    rules.push([new RegExp(escapeRegExp(value), 'gi'), replacement])
  }

  rules.push(...SECRET_SHAPES)

  return (text: string) => {
    let out = text
    for (const [pattern, replacement] of rules) {
      out = out.replace(pattern, replacement)
    }
    return out
  }
}
