/**
 * shell-ast Lit / wordToLit 对未加引号的反斜杠转义会保留源码形态
 *（如 Application\ Support），需解成真实路径再做工作区判定。
 *
 * POSIX：未加引号上下文中 `\X` → `X`。
 * Windows 盘符路径（C:\...）与 UNC（\\server\...）原样保留，避免拆掉分隔符。
 */
export function unescapeShellWordLiteral(s: string): string {
  if (!s.includes('\\')) return s
  // Windows 盘符 / UNC：反斜杠是路径分隔符，不解
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\')) return s

  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      out += s[i + 1]
      i++
    } else {
      out += s[i]
    }
  }
  return out
}
