#!/usr/bin/env node
/**
 * 从 CHANGELOG 提取指定版本的一句话摘要（blockquote 行）。
 * 供官网构建、发版 CI、release-meta.json 生成共用。
 */

const fs = require('fs')
const path = require('path')

/**
 * @param {string} content CHANGELOG 全文
 * @param {string} version  semver，不含 v 前缀
 * @returns {string}
 */
function extractVersionSummary(content, version) {
  const versionEscaped = version.replace(/\./g, '\\.')
  const blockquoteMatch = content.match(
    new RegExp(`^## v${versionEscaped}\\b[^\\n]*\\n\\n>\\s*(.+)$`, 'm')
  )
  if (blockquoteMatch) {
    return blockquoteMatch[1].trim()
  }

  const fallbackMatch = content.match(
    new RegExp(`^## v${versionEscaped}\\b[^\\n]*\\n\\n(.+)`, 'm')
  )
  if (fallbackMatch) {
    return fallbackMatch[1].replace(/^>\s*/, '').trim()
  }

  return ''
}

/**
 * @param {string} version
 * @param {'zh' | 'en'} lang
 * @param {string} [repoRoot]
 * @returns {string}
 */
function readChangelogSummary(version, lang = 'zh', repoRoot = path.join(__dirname, '..')) {
  const file = lang === 'zh' ? 'CHANGELOG_CN.md' : 'CHANGELOG.md'
  const filePath = path.join(repoRoot, file)
  const content = fs.readFileSync(filePath, 'utf-8')
  return extractVersionSummary(content, version)
}

module.exports = { extractVersionSummary, readChangelogSummary }

if (require.main === module) {
  const version = process.argv[2] || require('../package.json').version
  const lang = process.argv[3] === 'en' ? 'en' : 'zh'
  const summary = readChangelogSummary(version, lang)
  if (!summary) {
    console.error(`[extract-changelog-summary] v${version} (${lang}): 未找到摘要`)
    process.exit(1)
  }
  console.log(summary)
}
