/**
 * Word 模板填充
 *
 * 把 .docx 模板里的 {{占位符}} 用 JSON 数据填充，输出新文档。
 *
 * 支持三种循环形态：
 *  1. 段落级循环：`{{#each items}}` 与 `{{/each}}` 各自独占一段（段落 trim 后纯文本就是 marker）
 *  2. 表格行级循环：`{{#each items}}` 与 `{{/each}}` 出现在同一个 <w:tr> 内的某些段落里
 *  3. 段内/行内简单占位符：`{{key}}` —— 复用 docx-xml 的 replaceTextInParagraphXml，跨 run 安全
 *
 * 不支持（v1）：
 *  - 嵌套循环（each 内含 each）
 *  - 段内 each（同一段内既有 #each 又有 /each）
 *  - 页眉/页脚/文本框（仅扫描主 document.xml）
 */

import * as fs from 'fs'
import JSZip from 'jszip'
import {
  readDocx,
  writeDocx,
  getParagraphs,
  extractTextFromParagraphXml,
  replaceTextInParagraphXml,
  type ParagraphInfo
} from './docx-xml'
import {
  findPlaceholders,
  resolveValue,
  makeLoopContext,
  stringifyValue,
  type MissingStrategy,
  type Placeholder
} from '../../../../utils/template-engine'

export interface MergeOptions {
  onMissing?: MissingStrategy
}

export interface LoopExpansion {
  kind: 'paragraph' | 'row'
  field: string
  count: number
}

export interface MergeResult {
  /** 实际替换的占位符表达式（去重） */
  replaced: string[]
  /** 缺失的占位符表达式（去重） */
  missing: string[]
  /** 循环展开统计 */
  loopExpansions: LoopExpansion[]
}

/**
 * 对 .docx 模板执行 merge，写入到目标路径。
 */
export async function mergeDocxFile(
  templatePath: string,
  outputPath: string,
  data: Record<string, unknown>,
  options: MergeOptions = {}
): Promise<MergeResult> {
  const { zip, documentXml } = await readDocx(templatePath)
  const { xml: newDocumentXml, result } = mergeDocumentXml(documentXml, data, options)
  await writeDocx(outputPath, zip, newDocumentXml)
  return result
}

/**
 * 在 documentXml 字符串上执行 merge（不读写文件，便于单元测试）。
 *
 * 处理顺序：
 *   1. 表格行级循环展开（先展开行级，避免段落级误吃 <w:tr> 内的 each）
 *   2. 段落级循环展开
 *   3. 段内简单占位符替换
 *
 * 调用方根据返回的 missing 列表决定如何报错。
 */
export function mergeDocumentXml(
  documentXml: string,
  data: Record<string, unknown>,
  options: MergeOptions = {}
): { xml: string; result: MergeResult } {
  const onMissing = options.onMissing ?? 'error'
  const replacedSet = new Set<string>()
  const missingSet = new Set<string>()
  const loopExpansions: LoopExpansion[] = []

  let xml = documentXml

  // 1. 行级循环展开
  xml = expandRowLoops(xml, data, replacedSet, missingSet, loopExpansions, onMissing)

  // 2. 段落级循环展开
  xml = expandParagraphLoops(xml, data, replacedSet, missingSet, loopExpansions, onMissing)

  // 3. 简单占位符替换（剩余的 {{xxx}}，含 {{this}} 等）
  xml = replaceSimplePlaceholders(xml, data, replacedSet, missingSet, onMissing)

  return {
    xml,
    result: {
      replaced: Array.from(replacedSet),
      missing: Array.from(missingSet),
      loopExpansions
    }
  }
}

// ============ 行级循环 ============

/**
 * 找包含 `pos` 位置的最外层 <w:tr>...</w:tr> 范围。
 *
 * 用栈匹配处理嵌套表格。如果 pos 不在任何 <w:tr> 内，返回 null。
 */
function findContainingTableRow(xml: string, pos: number): { start: number; end: number } | null {
  // 从开头扫到 pos，记录最深一层未闭合的 <w:tr>
  const openStack: number[] = []
  const trOpenRe = /<w:tr(?:\s|>)/g
  const trCloseRe = /<\/w:tr>/g

  // 先收集 pos 之前所有的 <w:tr> open / close
  const events: Array<{ type: 'open' | 'close'; pos: number }> = []
  let m: RegExpExecArray | null

  trOpenRe.lastIndex = 0
  while ((m = trOpenRe.exec(xml)) !== null && m.index < pos) {
    events.push({ type: 'open', pos: m.index })
  }
  trCloseRe.lastIndex = 0
  while ((m = trCloseRe.exec(xml)) !== null && m.index < pos) {
    events.push({ type: 'close', pos: m.index })
  }
  events.sort((a, b) => a.pos - b.pos)

  for (const e of events) {
    if (e.type === 'open') openStack.push(e.pos)
    else openStack.pop()
  }

  if (openStack.length === 0) return null
  const trStart = openStack[openStack.length - 1]

  // 找对应的 </w:tr>
  let depth = 1
  trOpenRe.lastIndex = trStart + 4
  trCloseRe.lastIndex = trStart + 4
  let nextOpen = trOpenRe.exec(xml)
  let nextClose = trCloseRe.exec(xml)
  while (depth > 0) {
    if (!nextClose) return null
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++
      trOpenRe.lastIndex = nextOpen.index + 4
      nextOpen = trOpenRe.exec(xml)
    } else {
      depth--
      const closeEnd = nextClose.index + '</w:tr>'.length
      if (depth === 0) {
        return { start: trStart, end: closeEnd }
      }
      trCloseRe.lastIndex = closeEnd
      nextClose = trCloseRe.exec(xml)
    }
  }
  return null
}

/**
 * 展开所有行级循环。
 *
 * 检测策略：扫所有段落，找含 `{{#each xxx}}` 占位符的段落，
 * 若其所在 <w:tr> 内同时存在对应的 `{{/each}}`，且 each-start 不独占该段（即 marker 段落同时含其他内容或同段含 /each），
 * 则视为行级循环。
 *
 * 简化：marker 必须出现在某个段落的纯文本里（不跨 run）。
 */
function expandRowLoops(
  xml: string,
  data: Record<string, unknown>,
  replacedSet: Set<string>,
  missingSet: Set<string>,
  loopExpansions: LoopExpansion[],
  onMissing: MissingStrategy
): string {
  // 反复扫描，直到没有行级循环为止
  for (let safety = 0; safety < 50; safety++) {
    const paragraphs = getParagraphs(xml)
    let foundLoop: {
      field: string
      tr: { start: number; end: number }
    } | null = null

    for (const para of paragraphs) {
      const placeholders = findPlaceholders(para.text)
      const eachStart = placeholders.find(p => p.kind === 'each-start')
      if (!eachStart) continue

      const tr = findContainingTableRow(xml, para.start)
      if (!tr) continue // 不在表格行内，跳过

      // 检查同一个 <w:tr> 内是否有对应的 /each
      const trText = extractAllTextFromRange(xml, tr.start, tr.end)
      const trPlaceholders = findPlaceholders(trText)
      const eachEnd = trPlaceholders.find(p => p.kind === 'each-end')
      if (!eachEnd) continue

      foundLoop = { field: eachStart.expr, tr }
      break
    }

    if (!foundLoop) break

    // 求值
    const r = resolveValue(data, foundLoop.field)
    const trXml = xml.slice(foundLoop.tr.start, foundLoop.tr.end)

    if (!r.found || !Array.isArray(r.value)) {
      missingSet.add(foundLoop.field)
      // 处理策略：keep 保留原行；其他策略移除模板行
      const replacement = onMissing === 'keep' ? trXml : ''
      // 不论是否移除，先把 each/each 标签去掉避免后续重复扫描
      const cleaned = onMissing === 'keep'
        ? removeEachMarkersInRow(trXml)
        : ''
      xml = xml.slice(0, foundLoop.tr.start) + cleaned + xml.slice(foundLoop.tr.end)
      // 避免无限循环：cleaned 已不含 each marker，下一轮扫不到
      continue
    }

    const arr = r.value as unknown[]
    const cleanedTemplate = removeEachMarkersInRow(trXml)
    const parts: string[] = []
    for (let idx = 0; idx < arr.length; idx++) {
      const ctx = makeLoopContext(arr[idx], idx, data)
      const filled = applyDataToRowXml(cleanedTemplate, ctx, replacedSet, missingSet, onMissing)
      parts.push(filled)
    }
    xml = xml.slice(0, foundLoop.tr.start) + parts.join('') + xml.slice(foundLoop.tr.end)
    loopExpansions.push({ kind: 'row', field: foundLoop.field, count: arr.length })
  }
  return xml
}

/**
 * 从一段 XML 中按段落顺序提取所有纯文本（用于行内占位符识别）。
 */
function extractAllTextFromRange(xml: string, start: number, end: number): string {
  const slice = xml.slice(start, end)
  const paragraphs = getParagraphs(slice)
  return paragraphs.map(p => p.text).join('\n')
}

/**
 * 从一行 <w:tr> 的 XML 中清除所有 {{#each xxx}} 和 {{/each}} 占位符（保留其他内容）。
 *
 * 由于 marker 段落可能整段就是 each 标签（让该段为空看起来怪），
 * 但这种情况下这个段落本身就只是占位用，不输出额外内容是合理的。
 */
function removeEachMarkersInRow(rowXml: string): string {
  const paragraphs = getParagraphs(rowXml)
  let result = rowXml
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const para = paragraphs[i]
    const placeholders = findPlaceholders(para.text)
    if (placeholders.some(p => p.kind !== 'value')) {
      // 段落内有 each marker，把所有 each marker 用空字符串替换（用 word_replace 算法）
      let newParaXml = para.xml
      for (const p of placeholders) {
        if (p.kind === 'value') continue
        const { xml: replaced } = replaceTextInParagraphXml(newParaXml, p.raw, '', true)
        newParaXml = replaced
      }
      result = result.slice(0, para.start) + newParaXml + result.slice(para.end)
    }
  }
  return result
}

/**
 * 对一行 <w:tr> XML 应用循环 context 数据，做简单占位符替换。
 *
 * 复用 replaceTextInParagraphXml 保证跨 run 格式安全。
 */
function applyDataToRowXml(
  rowXml: string,
  data: Record<string, unknown>,
  replacedSet: Set<string>,
  missingSet: Set<string>,
  onMissing: MissingStrategy
): string {
  return replaceSimplePlaceholders(rowXml, data, replacedSet, missingSet, onMissing)
}

// ============ 段落级循环 ============

/**
 * 展开所有段落级循环。
 *
 * 段落级 marker 必须独占段落（trim 后纯文本等于 `{{#each xxx}}` 或 `{{/each}}`）。
 * 配对采用栈算法，支持顺序多个循环（不支持嵌套）。
 */
function expandParagraphLoops(
  xml: string,
  data: Record<string, unknown>,
  replacedSet: Set<string>,
  missingSet: Set<string>,
  loopExpansions: LoopExpansion[],
  onMissing: MissingStrategy
): string {
  for (let safety = 0; safety < 50; safety++) {
    const paragraphs = getParagraphs(xml)

    // 找最外层 each-start / each-end 段落对
    let firstEachStartIdx = -1
    let matchingEndIdx = -1
    let depth = 0
    let field = ''

    for (let i = 0; i < paragraphs.length; i++) {
      const text = paragraphs[i].text.trim()
      if (text.startsWith('{{#each ') && text.endsWith('}}') && !text.slice(8).includes('{{')) {
        if (depth === 0) {
          firstEachStartIdx = i
          field = text.slice(8, -2).trim()
        }
        depth++
      } else if (text === '{{/each}}') {
        depth--
        if (depth === 0 && firstEachStartIdx >= 0) {
          matchingEndIdx = i
          break
        } else if (depth < 0) {
          throw new Error('Unmatched {{/each}} in paragraph')
        }
      }
    }

    if (firstEachStartIdx === -1 || matchingEndIdx === -1) {
      if (depth !== 0) throw new Error('Unmatched {{#each}}: missing {{/each}}')
      break
    }

    if (matchingEndIdx - firstEachStartIdx < 2) {
      // 标签之间没有内容段落，循环为空
      // 直接删除两个 marker 段落
      const startPara = paragraphs[firstEachStartIdx]
      const endPara = paragraphs[matchingEndIdx]
      xml = xml.slice(0, startPara.start) + xml.slice(endPara.end)
      continue
    }

    const startPara = paragraphs[firstEachStartIdx]
    const endPara = paragraphs[matchingEndIdx]
    const templateXml = xml.slice(startPara.end, endPara.start)

    const r = resolveValue(data, field)
    if (!r.found || !Array.isArray(r.value)) {
      missingSet.add(field)
      let replacement = ''
      if (onMissing === 'keep') {
        // 保留：把 marker 段落删除，但保留模板内容（与 word_replace 行为对齐）
        replacement = templateXml
      }
      xml = xml.slice(0, startPara.start) + replacement + xml.slice(endPara.end)
      continue
    }

    const arr = r.value as unknown[]
    const parts: string[] = []
    for (let idx = 0; idx < arr.length; idx++) {
      const ctx = makeLoopContext(arr[idx], idx, data)
      const filled = replaceSimplePlaceholders(templateXml, ctx, replacedSet, missingSet, onMissing)
      parts.push(filled)
    }
    xml = xml.slice(0, startPara.start) + parts.join('') + xml.slice(endPara.end)
    loopExpansions.push({ kind: 'paragraph', field, count: arr.length })
  }
  return xml
}

// ============ 简单占位符替换 ============

/**
 * 在一段 XML 中对所有段落应用简单占位符替换（不处理 each marker）。
 *
 * 复用 replaceTextInParagraphXml 的跨 run 算法，保证字体/字号/颜色等格式继承。
 */
function replaceSimplePlaceholders(
  xml: string,
  data: Record<string, unknown>,
  replacedSet: Set<string>,
  missingSet: Set<string>,
  onMissing: MissingStrategy
): string {
  const paragraphs = getParagraphs(xml)
  let result = xml

  // 从后往前替换
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const para = paragraphs[i]
    const placeholders = findPlaceholders(para.text)
    const valuePlaceholders = placeholders.filter(p => p.kind === 'value')
    if (valuePlaceholders.length === 0) continue

    let newParaXml = para.xml
    for (const p of valuePlaceholders) {
      const r = resolveValue(data, p.expr)
      if (r.found) {
        replacedSet.add(p.expr)
        const { xml: replaced } = replaceTextInParagraphXml(
          newParaXml,
          p.raw,
          stringifyValue(r.value),
          true
        )
        newParaXml = replaced
      } else {
        missingSet.add(p.expr)
        if (onMissing === 'empty') {
          const { xml: replaced } = replaceTextInParagraphXml(newParaXml, p.raw, '', true)
          newParaXml = replaced
        }
        // 'keep' 不动；'error' 由调用方根据 missingSet 决定如何报错
      }
    }

    if (newParaXml !== para.xml) {
      result = result.slice(0, para.start) + newParaXml + result.slice(para.end)
    }
  }

  return result
}
