/**
 * 清洗错误文案，保证可安全经 Electron IPC 传回前端。
 * 避免控制字符 / 孤立 surrogate / 过长原文把 invoke 序列化打崩。
 */

function sanitizeIsolatedSurrogates(s: string): string {
  if (!s) return s
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
    .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, '$1\uFFFD')
}

export function toSafeErrorMessage(msg: string, maxLen = 300): string {
  // 故意匹配 C0/C1 控制字符，供 IPC 安全传输
  // eslint-disable-next-line no-control-regex -- strip C0/C1 controls from error text
  let cleaned = sanitizeIsolatedSurrogates(msg).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  if (cleaned.length > maxLen) {
    cleaned = sanitizeIsolatedSurrogates(cleaned.slice(0, maxLen) + '...')
  }
  return cleaned
}

/** 是否像 Electron IPC invoke 失败的包装错误（不应原样展示给用户） */
export function isIpcInvokeErrorMessage(msg: string): boolean {
  return (
    msg.includes('Error invoking remote method') ||
    (msg.includes('SyntaxError') && msg.includes('is not valid JSON'))
  )
}
