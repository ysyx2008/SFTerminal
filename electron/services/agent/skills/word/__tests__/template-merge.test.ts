/**
 * Word 模板填充：mergeDocumentXml 字符串级测试
 *
 * 直接在 documentXml 字符串上验证，不依赖磁盘 IO；
 * 集成测试（含真实 docx 文件）由 CLI 回归脚本覆盖。
 */
import { describe, it, expect } from 'vitest'
import { mergeDocumentXml } from '../template-merge'

// ============ 测试用 XML 构造 helper ============

function paragraph(text: string, runProps = ''): string {
  return `<w:p><w:r>${runProps}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

function paragraphMultiRuns(parts: string[]): string {
  // 每段不同 run，模拟跨 run 占位符
  const runs = parts.map(p => `<w:r><w:t xml:space="preserve">${p}</w:t></w:r>`).join('')
  return `<w:p>${runs}</w:p>`
}

function table(rows: string[][]): string {
  // rows: 二维数组 [[cellText, cellText], ...]
  const trXml = rows.map(cells => {
    const tcXml = cells.map(text =>
      `<w:tc>${paragraph(text)}</w:tc>`
    ).join('')
    return `<w:tr>${tcXml}</w:tr>`
  }).join('')
  return `<w:tbl>${trXml}</w:tbl>`
}

function wrapBody(content: string): string {
  return `<w:document><w:body>${content}</w:body></w:document>`
}

// 提取段落纯文本，忽略 XML 结构
function extractTexts(xml: string): string[] {
  const out: string[] = []
  const pRegex = /<w:p[\s>][\s\S]*?<\/w:p>/g
  let m: RegExpExecArray | null
  while ((m = pRegex.exec(xml)) !== null) {
    const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g
    let tm: RegExpExecArray | null
    let text = ''
    while ((tm = tRegex.exec(m[0])) !== null) text += tm[1]
    out.push(text)
  }
  return out
}

// 把 XML 拍平成 [trIdx][cellIdx] = text
function extractTableCells(xml: string): string[][] {
  const out: string[][] = []
  const trRegex = /<w:tr[\s>][\s\S]*?<\/w:tr>/g
  let mt: RegExpExecArray | null
  while ((mt = trRegex.exec(xml)) !== null) {
    const row: string[] = []
    const tcRegex = /<w:tc[\s>]([\s\S]*?)<\/w:tc>/g
    let mc: RegExpExecArray | null
    while ((mc = tcRegex.exec(mt[0])) !== null) {
      const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g
      let tm: RegExpExecArray | null
      let txt = ''
      while ((tm = tRegex.exec(mc[1])) !== null) txt += tm[1]
      row.push(txt)
    }
    out.push(row)
  }
  return out
}

// ============ 简单占位符 ============

describe('mergeDocumentXml: simple placeholders', () => {
  it('replaces single placeholder in one run', () => {
    const xml = wrapBody(paragraph('Hello {{name}}!'))
    const { xml: newXml, result } = mergeDocumentXml(xml, { name: 'Alice' })
    expect(extractTexts(newXml)).toEqual(['Hello Alice!'])
    expect(result.replaced).toEqual(['name'])
    expect(result.missing).toEqual([])
  })

  it('replaces nested fields', () => {
    const xml = wrapBody(paragraph('{{user.dept.name}}'))
    const { xml: newXml } = mergeDocumentXml(xml, { user: { dept: { name: '财务部' } } })
    expect(extractTexts(newXml)).toEqual(['财务部'])
  })

  it('replaces array index', () => {
    const xml = wrapBody(paragraph('First: {{items[0]}}'))
    const { xml: newXml } = mergeDocumentXml(xml, { items: ['A', 'B'] })
    expect(extractTexts(newXml)).toEqual(['First: A'])
  })

  it('handles cross-run placeholder ({{na + me}})', () => {
    // 占位符跨两个 run：{{ + name + }}
    const xml = wrapBody(paragraphMultiRuns(['Hello {{na', 'me}}!']))
    const { xml: newXml, result } = mergeDocumentXml(xml, { name: 'Alice' })
    expect(extractTexts(newXml)).toEqual(['Hello Alice!'])
    expect(result.replaced).toEqual(['name'])
  })

  it('on_missing=error: leaves placeholder, returns missing', () => {
    const xml = wrapBody(paragraph('Hello {{missing}}!'))
    const { xml: newXml, result } = mergeDocumentXml(xml, {}, { onMissing: 'error' })
    expect(extractTexts(newXml)).toEqual(['Hello {{missing}}!'])
    expect(result.missing).toEqual(['missing'])
  })

  it('on_missing=empty: replaces with empty string', () => {
    const xml = wrapBody(paragraph('Hello {{missing}}!'))
    const { xml: newXml, result } = mergeDocumentXml(xml, {}, { onMissing: 'empty' })
    expect(extractTexts(newXml)).toEqual(['Hello !'])
    expect(result.missing).toEqual(['missing'])
  })

  it('on_missing=keep: leaves placeholder unchanged', () => {
    const xml = wrapBody(paragraph('Hello {{missing}}!'))
    const { xml: newXml } = mergeDocumentXml(xml, {}, { onMissing: 'keep' })
    expect(extractTexts(newXml)).toEqual(['Hello {{missing}}!'])
  })

  it('preserves run-level format (rPr) after replacement', () => {
    // bold run: <w:r><w:rPr><w:b/></w:rPr><w:t>...</w:t></w:r>
    const boldRun = '<w:rPr><w:b/></w:rPr>'
    const xml = wrapBody(paragraph('{{name}}', boldRun))
    const { xml: newXml } = mergeDocumentXml(xml, { name: 'Bold!' })
    // bold 标记应保留
    expect(newXml).toContain('<w:b/>')
    expect(extractTexts(newXml)).toEqual(['Bold!'])
  })
})

// ============ 段落级循环 ============

describe('mergeDocumentXml: paragraph loops', () => {
  it('expands paragraph-level loop', () => {
    const xml = wrapBody(
      paragraph('Items:') +
      paragraph('{{#each items}}') +
      paragraph('- {{this}}') +
      paragraph('{{/each}}') +
      paragraph('End.')
    )
    const { xml: newXml, result } = mergeDocumentXml(xml, { items: ['A', 'B', 'C'] })
    expect(extractTexts(newXml)).toEqual(['Items:', '- A', '- B', '- C', 'End.'])
    expect(result.loopExpansions).toHaveLength(1)
    expect(result.loopExpansions[0]).toMatchObject({
      kind: 'paragraph',
      field: 'items',
      count: 3
    })
  })

  it('expands paragraph loop with object items and @index1', () => {
    const xml = wrapBody(
      paragraph('{{#each rows}}') +
      paragraph('{{@index1}}. {{name}} - {{value}}') +
      paragraph('{{/each}}')
    )
    const data = {
      rows: [
        { name: 'A', value: 1 },
        { name: 'B', value: 2 }
      ]
    }
    const { xml: newXml } = mergeDocumentXml(xml, data)
    expect(extractTexts(newXml)).toEqual(['1. A - 1', '2. B - 2'])
  })

  it('expands paragraph loop with multi-paragraph template', () => {
    const xml = wrapBody(
      paragraph('{{#each items}}') +
      paragraph('Title: {{title}}') +
      paragraph('Desc: {{desc}}') +
      paragraph('{{/each}}')
    )
    const { xml: newXml } = mergeDocumentXml(xml, {
      items: [
        { title: 'T1', desc: 'D1' },
        { title: 'T2', desc: 'D2' }
      ]
    })
    expect(extractTexts(newXml)).toEqual(['Title: T1', 'Desc: D1', 'Title: T2', 'Desc: D2'])
  })

  it('handles empty array (removes both markers)', () => {
    const xml = wrapBody(
      paragraph('Before') +
      paragraph('{{#each items}}') +
      paragraph('- {{this}}') +
      paragraph('{{/each}}') +
      paragraph('After')
    )
    const { xml: newXml } = mergeDocumentXml(xml, { items: [] })
    expect(extractTexts(newXml)).toEqual(['Before', 'After'])
  })

  it('reports missing field when each target absent', () => {
    const xml = wrapBody(
      paragraph('{{#each missing}}') +
      paragraph('- {{this}}') +
      paragraph('{{/each}}')
    )
    const { result } = mergeDocumentXml(xml, {}, { onMissing: 'error' })
    expect(result.missing).toContain('missing')
  })
})

// ============ 表格行级循环 ============

describe('mergeDocumentXml: table row loops', () => {
  it('expands single row loop', () => {
    const xml = wrapBody(
      table([
        ['Name', 'Value'],
        ['{{#each rows}}{{name}}', '{{value}}{{/each}}']
      ])
    )
    const { xml: newXml, result } = mergeDocumentXml(xml, {
      rows: [
        { name: 'A', value: '1' },
        { name: 'B', value: '2' },
        { name: 'C', value: '3' }
      ]
    })
    const cells = extractTableCells(newXml)
    expect(cells).toEqual([
      ['Name', 'Value'],
      ['A', '1'],
      ['B', '2'],
      ['C', '3']
    ])
    expect(result.loopExpansions).toHaveLength(1)
    expect(result.loopExpansions[0]).toMatchObject({
      kind: 'row',
      field: 'rows',
      count: 3
    })
  })

  it('handles row loop with empty array', () => {
    const xml = wrapBody(
      table([
        ['Header'],
        ['{{#each rows}}{{name}}{{/each}}']
      ])
    )
    const { xml: newXml } = mergeDocumentXml(xml, { rows: [] })
    // 模板行被删除，仅留 Header
    const cells = extractTableCells(newXml)
    expect(cells).toEqual([['Header']])
  })
})

// ============ 综合场景 ============

describe('mergeDocumentXml: combined scenarios', () => {
  it('handles paragraph and row loops together', () => {
    const xml = wrapBody(
      paragraph('Report: {{title}}') +
      paragraph('{{#each sections}}') +
      paragraph('Section: {{name}}') +
      paragraph('{{/each}}') +
      table([
        ['Item', 'Qty'],
        ['{{#each items}}{{name}}', '{{qty}}{{/each}}']
      ])
    )
    const { xml: newXml } = mergeDocumentXml(xml, {
      title: 'Q1',
      sections: [{ name: 'Intro' }, { name: 'Body' }],
      items: [{ name: 'a', qty: '1' }]
    })
    expect(extractTexts(newXml)).toContain('Report: Q1')
    expect(extractTexts(newXml)).toContain('Section: Intro')
    expect(extractTexts(newXml)).toContain('Section: Body')
    expect(extractTableCells(newXml)).toEqual([
      ['Item', 'Qty'],
      ['a', '1']
    ])
  })

  it('reports all missing placeholders', () => {
    const xml = wrapBody(
      paragraph('{{exists}} {{missing1}} {{missing2}}')
    )
    const { result } = mergeDocumentXml(xml, { exists: 'OK' }, { onMissing: 'error' })
    expect(result.replaced).toEqual(['exists'])
    expect(result.missing.sort()).toEqual(['missing1', 'missing2'])
  })
})
