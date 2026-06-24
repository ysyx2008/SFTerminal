/**
 * 从 CHANGELOG 中提取指定版本的条目摘要
 *
 * CLI：node scripts/extract-changelog-summary.js <version>
 * 库：extractVersionSummary(content, version) / readChangelogSummary(version, lang)
 */

const fs = require('fs')
const path = require('path')

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeVersion(version) {
  return String(version || '').replace(/^v/i, '').trim()
}

/**
 * 从已读取的 CHANGELOG 正文中提取版本摘要（首条 blockquote，否则首段非空行）
 * 未找到时返回空字符串，不抛错、不 exit。
 */
function extractVersionSummary(content, version) {
  const normalized = normalizeVersion(version)
  if (!normalized || !content) return ''

  const escaped = escapeRegExp(normalized)
  const headerRegex = new RegExp(`^##\\s+.*v?${escaped}(?:\\b|\\]).*$`, 'm')
  const match = content.match(headerRegex)
  if (!match) return ''

  const startIdx = match.index + match[0].length
  const rest = content.slice(startIdx)
  const nextHeader = rest.match(/^##\s+/m)
  const section = (nextHeader ? rest.slice(0, nextHeader.index) : rest).trim()
  if (!section) return ''

  const blockquote = section.match(/^>\s*(.+)$/m)
  if (blockquote?.[1]) {
    return blockquote[1].trim()
  }

  const firstLine = section.split('\n').find((line) => line.trim() && !line.startsWith('#'))
  return firstLine?.trim() || ''
}

/** 按语言读取 CHANGELOG 并提取摘要 */
function readChangelogSummary(version, lang = 'en') {
  const file = lang === 'zh' ? 'CHANGELOG_CN.md' : 'CHANGELOG.md'
  const changelogPath = path.join(__dirname, '..', file)
  try {
    const content = fs.readFileSync(changelogPath, 'utf-8')
    return extractVersionSummary(content, version)
  } catch {
    return ''
  }
}

module.exports = {
  extractVersionSummary,
  readChangelogSummary,
}

if (require.main === module) {
  const version = process.argv[2]
  if (!version) {
    console.error('Usage: node extract-changelog-summary.js <version>')
    process.exit(1)
  }

  const summary = readChangelogSummary(version, 'en')
  if (!summary) {
    console.error(`Version ${version} not found in CHANGELOG.md`)
    process.exit(1)
  }

  process.stdout.write(summary)
}
