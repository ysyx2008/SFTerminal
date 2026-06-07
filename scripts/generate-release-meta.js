#!/usr/bin/env node
/**
 * 生成 release-meta.json，供桌面端更新弹窗展示版本摘要。
 * 用法: node scripts/generate-release-meta.js [version] [outputPath]
 */

const fs = require('fs')
const path = require('path')
const { readChangelogSummary } = require('./extract-changelog-summary')

const version = process.argv[2] || require('../package.json').version
const outPath = process.argv[3] || path.join(__dirname, '../release/release-meta.json')

const meta = {
  version,
  summary: {
    zh: readChangelogSummary(version, 'zh'),
    en: readChangelogSummary(version, 'en'),
  },
}

if (!meta.summary.zh && !meta.summary.en) {
  console.error(`[generate-release-meta] v${version}: CHANGELOG 中未找到版本摘要`)
  process.exit(1)
}

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, `${JSON.stringify(meta, null, 2)}\n`)
console.log(`[generate-release-meta] 已写入 ${outPath}`)
