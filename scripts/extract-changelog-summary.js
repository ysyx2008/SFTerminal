/**
 * 从 CHANGELOG.md 中提取指定版本的条目摘要
 * 用法：node scripts/extract-changelog-summary.js <version>
 * 输出：该版本下的条目（到下一个 ## 标题为止），纯文本
 */

const fs = require('fs')
const path = require('path')

function escapeRegExp(str) {
  // 完整转义正则特殊字符，防止正则注入
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractVersionSummary(version) {
  const changelogPath = path.join(__dirname, '..', 'CHANGELOG.md')
  const content = fs.readFileSync(changelogPath, 'utf-8')

  // 匹配 ## [version] 或 ## version 开头的标题
  const escaped = escapeRegExp(version)
  const headerRegex = new RegExp(`^##\\s+(\\[?${escaped}\\]?)(?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`, 'm')
  const match = content.match(headerRegex)
  if (!match) {
    console.error(`Version ${version} not found in CHANGELOG.md`)
    process.exit(1)
  }

  // 从匹配位置截取到下一个 ## 标题
  const startIdx = match.index + match[0].length
  const rest = content.slice(startIdx)
  const nextHeader = rest.match(/^##\s+/m)
  const section = nextHeader ? rest.slice(0, nextHeader.index) : rest

  return section.trim()
}

const version = process.argv[2]
if (!version) {
  console.error('Usage: node extract-changelog-summary.js <version>')
  process.exit(1)
}

const summary = extractVersionSummary(version)
process.stdout.write(summary)
