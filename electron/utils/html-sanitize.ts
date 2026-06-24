/**
 * HTML 安全清洗工具
 *
 * 用于将 HTML 内容转换为纯文本/Markdown，供 AI 上下文使用。
 * 不使用正则单次替换（容易被嵌套/变体绕过），采用循环剥离直到稳定，
 * 并且正确处理：
 *   - script/style/noscript 等危险标签（含属性、空格变体）
 *   - HTML 注释
 *   - HTML 实体解码
 *   - 多余空白压缩
 */

// 需要完全移除内容的标签（含其内部文本）
const DANGEROUS_TAGS = ['script', 'style', 'noscript', 'iframe', 'svg', 'object', 'embed', 'canvas', 'template']

// 匹配 <!-- ... --> HTML 注释（含换行）
const COMMENT_RE = /<!--[\s\S]*?-->/g

// 匹配 <tagname ...> 开标签或 </tagname> 闭标签（不区分大小写，标签名后允许任意空白和属性）
function tagOpenRe(tag: string): RegExp {
  return new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi')
}
function tagCloseRe(tag: string): RegExp {
  // </script > 或 </script  > 等带空格变体
  return new RegExp(`<\\/${tag}\\s*>`, 'gi')
}
// 匹配整个 <tag>...</tag> 块（非贪婪，但会被循环兜底）
function tagBlockRe(tag: string): RegExp {
  return new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi')
}

// 普通 HTML 标签（开/闭/自闭合）
const ANY_TAG_RE = /<\/?[a-zA-Z][^>]*>/g

// 常见 HTML 实体
const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ndash;': '–',
  '&mdash;': '—',
  '&hellip;': '…',
  '&copy;': '©',
  '&reg;': '®',
  '&trade;': '™',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (HTML_ENTITIES[match]) return HTML_ENTITIES[match]
    if (entity.startsWith('#x')) {
      const code = parseInt(entity.slice(2), 16)
      if (!isNaN(code) && code > 0) return String.fromCharCode(code)
    } else if (entity.startsWith('#')) {
      const code = parseInt(entity.slice(1), 10)
      if (!isNaN(code) && code > 0) return String.fromCharCode(code)
    }
    return match
  })
}

/**
 * 将 HTML 安全地剥离为纯文本。
 * 循环移除危险标签直到稳定（防止嵌套绕过，如 <<script>script>）。
 */
export function stripHtmlToText(html: string): string {
  if (!html) return ''
  let text = String(html)

  // 1. 移除 HTML 注释
  text = text.replace(COMMENT_RE, '')

  // 2. 循环移除危险标签块（script/style 等），直到不再变化
  //    单次正则可能被嵌套绕过：<<script>script>alert(1)</script>
  //    第一次替换后残留 <script>alert(1)</script>，需要再跑一次
  for (let safety = 0; safety < 10; safety++) {
    const before = text
    for (const tag of DANGEROUS_TAGS) {
      text = text.replace(tagBlockRe(tag), ' ')
    }
    // 同时移除残留的孤立开/闭标签（防御性）
    for (const tag of DANGEROUS_TAGS) {
      text = text.replace(tagOpenRe(tag), ' ').replace(tagCloseRe(tag), ' ')
    }
    if (text === before) break
  }

  // 3. 把 <br>、<p>、<div>、<li> 等块级标签转为换行，方便阅读
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|aside)>/gi, '\n')
  text = text.replace(/<li[^>]*>/gi, '• ')

  // 4. 移除所有剩余标签
  text = text.replace(ANY_TAG_RE, '')

  // 5. 解码 HTML 实体
  text = decodeEntities(text)

  // 6. 压缩多余空白和空行
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.replace(/[ \t]+\n/g, '\n')

  return text.trim()
}

/**
 * 简化版 HTML→Markdown 转换，用于邮件正文等场景。
 * 保留链接、标题、列表、粗体/斜体等基本结构，同时安全剥离危险标签。
 */
export function htmlToSimpleMarkdown(html: string): string {
  if (!html) return ''
  let md = String(html)

  // 1. 移除 HTML 注释
  md = md.replace(COMMENT_RE, '')

  // 2. 循环移除危险标签块
  for (let safety = 0; safety < 10; safety++) {
    const before = md
    for (const tag of DANGEROUS_TAGS) {
      md = md.replace(tagBlockRe(tag), ' ')
    }
    for (const tag of DANGEROUS_TAGS) {
      md = md.replace(tagOpenRe(tag), ' ').replace(tagCloseRe(tag), ' ')
    }
    if (md === before) break
  }

  // 3. 转换常见结构为 Markdown
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
  md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
  md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
  md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
  md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
  md = md.replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
  md = md.replace(/<br\s*\/?>/gi, '\n')
  md = md.replace(/<\/p>/gi, '\n\n')
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
  md = md.replace(/<\/(div|tr|section)>/gi, '\n')
  md = md.replace(/<hr\s*\/?>/gi, '\n---\n')

  // 4. 移除所有剩余标签
  md = md.replace(ANY_TAG_RE, '')

  // 5. 解码实体
  md = decodeEntities(md)

  // 6. 压缩空白
  md = md.replace(/[ \t]+/g, ' ')
  md = md.replace(/\n{3,}/g, '\n\n')
  md = md.replace(/[ \t]+\n/g, '\n')

  return md.trim()
}
