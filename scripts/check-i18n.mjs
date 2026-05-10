#!/usr/bin/env node
/**
 * 检查 src/i18n/locales/{zh-CN,en-US} 的所有嵌套 key 是否完全对齐。
 *
 * 触发场景：CI、pre-commit、或人工 `node scripts/check-i18n.mjs`。
 * 退出码：对齐返回 0，有差异返回 1 并列出缺失/多余的完整路径。
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(__filename), '..')
const LOCALES_DIR = 'src/i18n/locales'

function loadAsJson(tsRelPath) {
  const abs = path.join(ROOT, tsRelPath)
  const helper = `
import obj from ${JSON.stringify(abs)}
process.stdout.write(JSON.stringify(obj))
`
  const tmp = path.join(ROOT, `.i18n-check-${process.pid}.mts`)
  fs.writeFileSync(tmp, helper, 'utf8')
  try {
    const out = execSync(`npx tsx ${JSON.stringify(tmp)}`, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit']
    })
    return JSON.parse(out)
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
}

/** 把嵌套对象拍平成 ['a.b.c', ...] 形式的路径集合 */
function collectLeafPaths(obj, prefix = '', out = []) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    out.push(prefix)
    return out
  }
  const keys = Object.keys(obj)
  if (keys.length === 0) {
    out.push(prefix)
    return out
  }
  for (const k of keys) {
    collectLeafPaths(obj[k], prefix ? `${prefix}.${k}` : k, out)
  }
  return out
}

function main() {
  const zh = loadAsJson(`${LOCALES_DIR}/zh-CN/index.ts`)
  const en = loadAsJson(`${LOCALES_DIR}/en-US/index.ts`)

  const zhPaths = new Set(collectLeafPaths(zh))
  const enPaths = new Set(collectLeafPaths(en))

  const onlyInZh = [...zhPaths].filter((p) => !enPaths.has(p)).sort()
  const onlyInEn = [...enPaths].filter((p) => !zhPaths.has(p)).sort()

  console.log(`zh-CN: ${zhPaths.size} 条 key`)
  console.log(`en-US: ${enPaths.size} 条 key`)

  if (onlyInZh.length === 0 && onlyInEn.length === 0) {
    console.log('\n✅ 中英文 i18n key 完全对齐')
    return
  }

  console.error('\n❌ 中英文 i18n key 不对齐：\n')
  if (onlyInZh.length > 0) {
    console.error(`仅 zh-CN 有 (${onlyInZh.length} 条)，请在 en-US 对应文件补翻译：`)
    for (const p of onlyInZh) console.error('  - ' + p)
  }
  if (onlyInEn.length > 0) {
    console.error(`\n仅 en-US 有 (${onlyInEn.length} 条)，请在 zh-CN 对应文件补翻译：`)
    for (const p of onlyInEn) console.error('  - ' + p)
  }
  process.exit(1)
}

main()
