/**
 * 一个概念只能有一处定义。
 *
 * 同名同值的字面量联合类型出现在多个文件里，几乎只可能是复制粘贴。这种重复不会有任何
 * 编译信号——改对了一处，另一处照旧通过，只能等运行时撞出来，项目越大越难查。
 * 对应 collaboration.mdc 禁止事项「给一个概念造第二个真相源」的第一种手法（抄一遍）。
 *
 * 抓不到的：换个词重新发明（值集合对不上，机器认不出）。那部分只能靠规则与 review。
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../..')
// 桌面端主体。website 与 server 各自独立发布、不与这里共享类型，扯进来只会制造假重复；
// 哪天它们开始共用枚举，再把目录加进来。
const SCAN_DIRS = ['electron', 'src', 'packages', 'shared']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', 'release', '.git', 'coverage'])
const SCAN_EXTS = new Set(['.ts', '.vue'])

/**
 * 已知豁免。往这里加条目必须写清为什么，且只有两种正当理由：
 * 值集合撞车但概念无关，或者真正的重复在别处、并不是靠合并类型能解决的。
 */
const ALLOWED: ReadonlySet<string> = new Set<string>([
  // 被复制的其实是整个 useHoverTip（含 HoverTipOverlay.vue），跨 src 与 workbench-assistant 两侧。
  // 合并它要先有一个双方都能依赖的前端共用位置，属于分包重构；只把类型挪走会让这处复制
  // 看起来"解决了"，反而更难被发现。
  'HoverTipPlacement = bottom|left|top',
])

interface Definition {
  name: string
  values: string
  file: string
}

const LITERAL_UNION = /^\|?\s*(?:'[^']*'|"[^"]*"|\d+)(?:\s*\|\s*(?:'[^']*'|"[^"]*"|\d+))*$/
const LITERAL = /'[^']*'|"[^"]*"|\d+/g

/**
 * 逐行收集 `type X = ...`，直到分号或联合结束。
 *
 * 用行扫描而非一条大正则：跨行联合（每行一个 `| 'x'`）在本仓很常见，
 * 一条正则要同时管住跨行与终止条件，出错时是静默漏报，反而不如状态机看得清。
 */
function collectLiteralUnions(source: string, file: string): Definition[] {
  const found: Definition[] = []
  const lines = source.split('\n')
  let name: string | null = null
  let buffer = ''

  const flush = () => {
    if (name && LITERAL_UNION.test(buffer.trim().replace(/;+$/, ''))) {
      const values = (buffer.match(LITERAL) ?? [])
        .map(v => v.replace(/^["']|["']$/g, ''))
        .sort()
        .join('|')
      if (values) found.push({ name, values, file })
    }
    name = null
    buffer = ''
  }

  for (const line of lines) {
    if (name !== null) {
      // 续行只认以 | 开头的；其它任何内容都说明这条定义已经结束
      if (/^\s*\|/.test(line)) {
        buffer += ' ' + line.split('//')[0]
        if (line.includes(';')) flush()
        continue
      }
      flush()
    }
    const match = /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=(.*)$/.exec(line)
    if (!match) continue
    name = match[1]
    buffer = match[2].split('//')[0]
    if (buffer.includes(';') || buffer.trim() !== '') {
      // 单行写完（有无分号都算）；空的则等续行
      if (buffer.includes(';') || !buffer.trim().endsWith('|')) flush()
    }
  }
  flush()

  return found
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (SCAN_EXTS.has(path.extname(entry.name))) out.push(full)
  }
}

function findDuplicates(): Map<string, string[]> {
  const files: string[] = []
  for (const dir of SCAN_DIRS) walk(path.join(ROOT, dir), files)

  const byKey = new Map<string, Set<string>>()
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf-8')
    for (const def of collectLiteralUnions(source, path.relative(ROOT, file))) {
      const key = `${def.name} = ${def.values}`
      if (ALLOWED.has(key)) continue
      const slot = byKey.get(key) ?? new Set<string>()
      slot.add(def.file)
      byKey.set(key, slot)
    }
  }

  const duplicates = new Map<string, string[]>()
  for (const [key, fileSet] of byKey) {
    if (fileSet.size > 1) duplicates.set(key, [...fileSet].sort())
  }
  return duplicates
}

describe('字面量联合类型只能有一处定义', () => {
  it('同名同值的类型不得出现在多个文件', () => {
    const duplicates = findDuplicates()
    const report = [...duplicates.entries()]
      .map(([key, files]) => `  ${key}\n${files.map(f => `      ${f}`).join('\n')}`)
      .join('\n')
    expect(report, `以下类型在多处重复定义，请留一处真相源：\n${report}`).toBe('')
  })
})
