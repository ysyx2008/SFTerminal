/**
 * 本地文件路径形态检测与裸路径扫描（Unix / ~/ / Windows 盘符 / UNC）。
 * 供 Markdown 自动链接化使用；纯函数，无 UI 依赖。
 */

/**
 * 路径段字符（不含分隔符 / \）。
 * 含空格与 shell 转义 `\\`；不含 `()`——括号常是中文列举/句子尾巴，不是路径名。
 */
const SEG = String.raw`[\w\u4e00-\u9fff\u3000-\u303f\u00C0-\u024F.\-+@#$[\]%\\ ]`

/**
 * 裸路径正则（每次调用新建，避免 /g 共用 lastIndex）。
 *
 * Unix / ~/ 均按「段 + 分隔符」拼接，避免把后面的 ` 2>/dev/null` 等 shell 语法吃进路径。
 * - 多级（≥2 段）：扩展名可选，允许末尾 /
 * - 单级：必须带扩展名（避免误伤 /etc、/tmp）
 * - 盘符 / UNC：同样分段
 */
export function createBareFilePathPattern(): RegExp {
  // 多级：/a/b、/a/b/c/、/opt/homebrew/bin/python3（不要求扩展名）
  const unixMulti = String.raw`\/(?:${SEG}+\/)+${SEG}+\/?`
  // 单级带扩展名：/readme.md
  const unixSingleExt = String.raw`\/${SEG}+\.[\w]{1,10}`
  // ~/a/b/c/ —— 与 unix 同构，禁止用「任意字符+斜杠」贪婪吞掉重定向
  const home = String.raw`~\/(?:${SEG}+\/)*${SEG}+\/?`
  // C:\a\b 或 C:/a/b
  const windows = String.raw`[A-Za-z]:[\\/](?:${SEG}+[\\/])*${SEG}+\\?`
  // UNC：\\server\share… 或 Markdown 转义后残留的 \server\share…
  const unc = String.raw`\\\\${SEG}+(?:[\\/]${SEG}+)+\\?|\\${SEG}+(?:[\\/]${SEG}+)+`
  return new RegExp(
    `(?:${unixMulti}|${unixSingleExt}|${home}|${windows}|${unc})`,
    'g'
  )
}

/**
 * 绝对路径 `/…` 的首段须为 ASCII 文件系统名。
 * 排除「序号/分类/问题/选项」这类以 `/` 分隔的中文列举（首段是 CJK）。
 * 真实绝对路径首段几乎总是 Users/home/var/opt/tmp/Applications…；
 * `~/中文目录` 不受影响（走 ~ 分支）。
 */
function hasAsciiAbsoluteRoot(path: string): boolean {
  if (!path.startsWith('/')) return true
  return /^\/[A-Za-z0-9._-]+(?:\/|$)/.test(path)
}

/**
 * 检测文本是否为本地文件路径
 * 支持：
 * - Unix/macOS/Linux 绝对路径：/path/to/file
 * - 用户主目录路径：~/path/to/file
 * - Windows 盘符路径：C:\path\to\file 或 C:/path/to/file
 * - Windows UNC：\\server\share\path（至少 server + share 两段）
 * - Markdown 吞掉一个 \ 后的 \server\share\path（≥2 段）
 */
export function isLocalFilePath(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false
  // 排除 HTTP(S) URL（例如 "p://localhost" 误匹配 Windows 盘符模式）
  if (/^https?:\/\//i.test(trimmed)) return false
  // shell 重定向目标，不是用户要打开的文件
  if (trimmed === '/dev/null' || trimmed === '/dev/null/') return false
  // 路径中不允许的字符：HTML 标签符号、shell 通配符、双引号、控制字符
  const illegal = /[<>*?"\n\r\t]/
  if (illegal.test(trimmed)) return false
  if (!hasAsciiAbsoluteRoot(trimmed)) return false
  // Unix/macOS/Linux 绝对路径
  if (/^\//.test(trimmed)) return true
  // 用户主目录路径
  if (/^~\//.test(trimmed)) return true
  // Windows 盘符路径 (C:\ 或 C:/)
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true
  // Windows UNC：\\server\share…
  if (/^\\\\[^\\\/]+[\\/][^\\\/]/.test(trimmed)) return true
  // Markdown 将 \\ 收成 \ 后的 UNC 形态：\server\share…
  if (/^\\[^\\\/]+(?:[\\/][^\\\/]+)+/.test(trimmed)) return true
  return false
}

/**
 * 匹配结果后处理：去掉误吞的尾巴。
 * - 尾随空格
 * - 空格 + CJK：中文正文
 * - 空格 + 数字：shell fd（`2>`）
 * - 空格 + `-…`：CLI 选项（`Desktop -maxdepth`）
 * - 尾部中英文标点
 */
export function trimPathOvermatch(path: string): string {
  let result = path.replace(/ +$/, '')

  const cjkCut = result.search(/ [\u4e00-\u9fff\u3000-\u303f]/)
  if (cjkCut !== -1) {
    const head = result.slice(0, cjkCut)
    if (isLocalFilePath(head)) result = head
  }

  const fdCut = result.search(/ \d+$/)
  if (fdCut !== -1) {
    const head = result.slice(0, fdCut)
    if (isLocalFilePath(head)) result = head
  }

  // `/Users/foo/Desktop -maxdepth 2` —— 空格后接 CLI flag
  const flagCut = result.search(/ -/)
  if (flagCut !== -1) {
    const head = result.slice(0, flagCut)
    if (isLocalFilePath(head)) result = head
  }

  // 尾部标点（中文列举常带 ））等）
  result = result.replace(/[),.;:!?）】』」>]+$/u, '')
  return result
}

/** @deprecated 使用 trimPathOvermatch */
export function trimTrailingCjkProse(path: string): string {
  return trimPathOvermatch(path)
}

/**
 * Markdown 常把 `\\server` 收成 `\server`。打开时补回 UNC 所需的双反斜杠前缀。
 * 展示文本可保持原文；data-file-path / openPath 用规范化结果。
 */
export function normalizeUncForOpen(path: string): string {
  if (/^\\[^\\\/]/.test(path)) return `\\${path}`
  return path
}

/**
 * 将一次正则命中收成最终可链接路径；不可链接时返回 null。
 * 后继若是 shell glob（* ? [）则整段不链接——通配路径不试图「猜父目录」。
 */
export function finalizeBarePathMatch(
  rawMatch: string,
  text: string,
  index: number
): string | null {
  const path = trimPathOvermatch(rawMatch)
  if (!isLocalFilePath(path)) return null
  const next = text[index + path.length]
  if (next === '*' || next === '?' || next === '[') return null
  return path
}

/**
 * 从纯文本中提取会作为裸路径链接的片段（测试 / 调试用）。
 */
export function matchBareFilePaths(text: string): string[] {
  const pattern = createBareFilePathPattern()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text)) !== null) {
    const path = finalizeBarePathMatch(m[0], text, m.index)
    if (!path) continue
    out.push(path)
    pattern.lastIndex = m.index + Math.max(path.length, 1)
  }
  return out
}
