#!/usr/bin/env node
/**
 * 把单文件 i18n（zh-CN.ts / en-US.ts）按业务域拆分成多个子文件。
 *
 * 思路：
 *  1. 用 ts-morph 解析源文件，定位每个顶层 PropertyAssignment 的精确文本范围
 *     （含前置注释和尾随逗号），从而保证「100% 字符级保留原内容」。
 *  2. 按预定义的分组配置把 key 分发到不同文件，每个文件就是一段
 *     `export default { ...原始片段拼接... }`。
 *  3. 顺便检查中英文的顶层 key 是否一致，不一致就报错（避免漏翻）。
 *
 * 用法：node scripts/split-i18n.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Project, SyntaxKind } from 'ts-morph'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')
const LOCALES_DIR = path.join(ROOT, 'src/i18n/locales')

// 业务分组：每个目标文件包含哪些顶层 key
// 顺序决定 key 在文件里的排列顺序，也决定运行时合并的覆盖顺序（后写覆盖前写，
// 不过我们保证 key 不重复，所以无所谓）
const GROUPS = [
  {
    file: 'common.ts',
    desc: '通用 UI 词汇：应用基础、欢迎页、巡检、按钮文案、头部、关于、赞助、语言、连接状态',
    keys: [
      'app',
      'welcome',
      'patrol',
      'common',
      'header',
      'windowControls',
      'about',
      'sponsor',
      'languageSettings',
      'conn'
    ]
  },
  {
    file: 'settings.ts',
    desc: '控制面板：主设置入口与各 *Settings 子面板',
    keys: [
      'settings',
      'aiSettings',
      'aiRulesSettings',
      'pluginSettings',
      'mcpSettings',
      'skillSettings',
      'knowledgeSettings',
      'shortcutSettings',
      'terminalSettings',
      'themeSettings',
      'dataSettings',
      'emailSettings',
      'calendarSettings'
    ]
  },
  {
    file: 'ai.ts',
    desc: 'AI 助手面板：对话/工具/Welcome/历史/场景示例等',
    keys: ['ai', 'mentions', 'knowledge', 'knowledgeManager']
  },
  {
    file: 'watch.ts',
    desc: '关切系统：定时任务、关切配置、觉醒模式、心跳',
    keys: ['scheduler', 'watch', 'awaken', 'heartbeat']
  },
  {
    file: 'terminal.ts',
    desc: '终端与会话：会话管理、Tab、终端窗格、MCP 状态、批量命令',
    keys: ['session', 'tabs', 'terminal', 'mcp', 'batch']
  },
  {
    file: 'file.ts',
    desc: '文件管理：SFTP 文件浏览器、双窗格文件管理器',
    keys: ['fileExplorer', 'fileManager']
  },
  {
    file: 'setup.ts',
    desc: '首次设置向导',
    keys: ['setup']
  },
  {
    file: 'integration.ts',
    desc: '外部集成：邮箱技能、Gateway 通知、IM 通知',
    keys: ['email', 'gateway', 'im']
  }
]

/**
 * 提取一个顶层对象表达式中所有 PropertyAssignment 的「连续文本片段」
 * 包括前置注释、属性名、值、尾随逗号、行末空白
 */
function extractPropertyChunks(sourceFile) {
  const exportAssignment = sourceFile.getFirstChildByKindOrThrow(
    SyntaxKind.ExportAssignment
  )
  const objectLiteral = exportAssignment.getExpressionIfKindOrThrow(
    SyntaxKind.ObjectLiteralExpression
  )
  const fullText = sourceFile.getFullText()

  const props = objectLiteral.getProperties()
  if (props.length === 0) {
    throw new Error('源对象为空，无法拆分')
  }

  // 对每个 property 计算「片段起止」
  // 起：包括前置注释和空白（leading trivia）
  // 止：包括尾随逗号（如果有），但不吃下一个 property 的前置注释/空白
  const chunks = []
  for (let i = 0; i < props.length; i++) {
    const prop = props[i]
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) {
      throw new Error(
        `不支持的顶层节点：${prop.getKindName()}（位于 ${prop.getStartLineNumber()} 行）`
      )
    }
    const nameNode = prop.getNameNode()
    const key = nameNode.getText()

    // 起点：本节点的「含 leading trivia 的起始位置」
    // 但要回退到上一个 property 的「含尾随逗号的结束位置」之后
    let start
    if (i === 0) {
      // 第一个 property，起点取「{ 之后的位置」
      const openBrace = objectLiteral.getFirstChildByKindOrThrow(
        SyntaxKind.OpenBraceToken
      )
      start = openBrace.getEnd()
    } else {
      start = chunks[i - 1].end
    }

    // 终点：本节点结束 + 紧跟的逗号（如果有）+ 该行剩余空白/换行
    let end = prop.getEnd()
    // 找紧跟的逗号
    while (end < fullText.length && /\s/.test(fullText[end]) && fullText[end] !== ',') {
      // 跳过空白但不跨行
      if (fullText[end] === '\n') break
      end++
    }
    if (fullText[end] === ',') {
      end++
    }
    // 吃掉本行尾的空白与换行
    while (end < fullText.length && fullText[end] !== '\n' && /\s/.test(fullText[end])) {
      end++
    }
    if (fullText[end] === '\n') {
      end++
    }

    chunks.push({ key, start, end, text: fullText.slice(start, end) })
  }
  return chunks
}

/**
 * 把片段按 GROUPS 分发到目标文件文本
 */
function buildGroupedFiles(chunks, lang) {
  const chunkMap = new Map(chunks.map((c) => [c.key, c]))
  const knownKeys = new Set()
  for (const g of GROUPS) for (const k of g.keys) knownKeys.add(k)

  // 检查是否有遗漏的 key
  const missingFromConfig = chunks
    .map((c) => c.key)
    .filter((k) => !knownKeys.has(k))
  if (missingFromConfig.length > 0) {
    throw new Error(
      `[${lang}] 以下 key 未分配到任何 group，请更新 GROUPS：\n  ${missingFromConfig.join(', ')}`
    )
  }
  const missingFromSource = []
  for (const g of GROUPS) {
    for (const k of g.keys) {
      if (!chunkMap.has(k)) missingFromSource.push(`${g.file} 期望 ${k}`)
    }
  }
  if (missingFromSource.length > 0) {
    throw new Error(
      `[${lang}] 以下配置中的 key 在源文件中找不到：\n  ${missingFromSource.join('\n  ')}`
    )
  }

  const files = []
  for (const g of GROUPS) {
    const parts = g.keys.map((k) => chunkMap.get(k).text.trimEnd())
    // 去掉最后一个 chunk 末尾可能的逗号——可有可无（TS 允许尾逗号）
    const body = parts.join('\n\n')
    const content = `// ${g.desc}\nexport default {\n${body}\n}\n`
    files.push({ file: g.file, content })
  }
  return files
}

function buildIndex(groups) {
  const lines = []
  for (let i = 0; i < groups.length; i++) {
    const name = groups[i].file.replace(/\.ts$/, '')
    const ident = name.replace(/[^a-zA-Z0-9_]/g, '_')
    lines.push(`import ${ident} from './${name}'`)
  }
  lines.push('')
  lines.push('export default {')
  for (const g of GROUPS) {
    const ident = g.file.replace(/\.ts$/, '').replace(/[^a-zA-Z0-9_]/g, '_')
    lines.push(`  ...${ident},`)
  }
  lines.push('}')
  return lines.join('\n') + '\n'
}

function processLang(lang) {
  const sourcePath = path.join(LOCALES_DIR, `${lang}.ts`)
  const targetDir = path.join(LOCALES_DIR, lang)
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`找不到源文件 ${sourcePath}`)
  }

  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false }
  })
  const sourceFile = project.addSourceFileAtPath(sourcePath)
  const chunks = extractPropertyChunks(sourceFile)
  console.log(`[${lang}] 找到 ${chunks.length} 个顶层 key`)

  const files = buildGroupedFiles(chunks, lang)
  fs.mkdirSync(targetDir, { recursive: true })
  for (const f of files) {
    const filePath = path.join(targetDir, f.file)
    fs.writeFileSync(filePath, f.content, 'utf8')
    console.log(`  写入 ${path.relative(ROOT, filePath)} (${f.content.length} 字节)`)
  }
  const indexPath = path.join(targetDir, 'index.ts')
  fs.writeFileSync(indexPath, buildIndex(GROUPS), 'utf8')
  console.log(`  写入 ${path.relative(ROOT, indexPath)}`)

  return chunks.map((c) => c.key)
}

function main() {
  const zhKeys = processLang('zh-CN')
  const enKeys = processLang('en-US')

  const zhSet = new Set(zhKeys)
  const enSet = new Set(enKeys)
  const onlyInZh = zhKeys.filter((k) => !enSet.has(k))
  const onlyInEn = enKeys.filter((k) => !zhSet.has(k))
  if (onlyInZh.length > 0 || onlyInEn.length > 0) {
    console.error('\n⚠️  顶层 key 不对齐：')
    if (onlyInZh.length > 0) console.error('  仅 zh-CN:', onlyInZh.join(', '))
    if (onlyInEn.length > 0) console.error('  仅 en-US:', onlyInEn.join(', '))
    process.exit(1)
  }

  console.log('\n✅ 拆分完成，中英 key 顶层对齐')
}

main()
