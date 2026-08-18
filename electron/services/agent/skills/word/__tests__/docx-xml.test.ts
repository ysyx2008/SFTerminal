/**
 * word_replace 段内替换：跨 run 时必须保住原格式边界
 * （例如开头两字加粗，不能把整段新文字塞进第一个加粗 run）
 */
import { describe, it, expect } from 'vitest'
import { replaceTextInParagraphXml, extractTextFromParagraphXml } from '../docx-xml'

function run(text: string, bold = false): string {
  const rPr = bold ? '<w:rPr><w:b/></w:rPr>' : ''
  return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`
}

function paragraph(...runs: string[]): string {
  return `<w:p>${runs.join('')}</w:p>`
}

function extractRuns(xml: string): { text: string; bold: boolean }[] {
  const out: { text: string; bold: boolean }[] = []
  const rRegex = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g
  let m: RegExpExecArray | null
  while ((m = rRegex.exec(xml)) !== null) {
    const block = m[0]
    const tMatch = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/.exec(block)
    out.push({
      text: tMatch ? tMatch[1] : '',
      bold: /<w:b\b/.test(block)
    })
  }
  return out
}

describe('replaceTextInParagraphXml: preserve run formatting', () => {
  it('keeps prefix-bold when replacing the whole paragraph with longer text', () => {
    const xml = paragraph(run('一、', true), run('这是一段很长的正文内容。'))
    const { xml: next, count } = replaceTextInParagraphXml(
      xml,
      '一、这是一段很长的正文内容。',
      '一、这是改过的正文，比原来更长一些。'
    )
    expect(count).toBe(1)
    expect(extractTextFromParagraphXml(next)).toBe('一、这是改过的正文，比原来更长一些。')
    expect(extractRuns(next)).toEqual([
      { text: '一、', bold: true },
      { text: '这是改过的正文，比原来更长一些。', bold: false }
    ])
  })

  it('keeps prefix-bold when replacing only the body', () => {
    const xml = paragraph(run('备注', true), run('：原先的说明文字'))
    const { xml: next, count } = replaceTextInParagraphXml(
      xml,
      '原先的说明文字',
      '更新后的说明，内容更长'
    )
    expect(count).toBe(1)
    expect(extractRuns(next)).toEqual([
      { text: '备注', bold: true },
      { text: '：更新后的说明，内容更长', bold: false }
    ])
  })

  it('keeps replacement inside the bold run when only the prefix is replaced', () => {
    const xml = paragraph(run('一、', true), run('正文保持不动'))
    const { xml: next, count } = replaceTextInParagraphXml(xml, '一、', '（一）')
    expect(count).toBe(1)
    expect(extractRuns(next)).toEqual([
      { text: '（一）', bold: true },
      { text: '正文保持不动', bold: false }
    ])
  })

  it('puts a single-run replacement entirely into that run', () => {
    const xml = paragraph(run('全部都是普通文字'))
    const { xml: next, count } = replaceTextInParagraphXml(xml, '普通', '一般')
    expect(count).toBe(1)
    expect(extractRuns(next)).toEqual([{ text: '全部都是一般文字', bold: false }])
  })

  it('splits a mid-paragraph match across the two spanned runs', () => {
    const xml = paragraph(run('开头', true), run('后面是正文'))
    const { xml: next, count } = replaceTextInParagraphXml(xml, '头后', '头以及后')
    expect(count).toBe(1)
    expect(extractTextFromParagraphXml(next)).toBe('开头以及后面是正文')
    expect(extractRuns(next)).toEqual([
      { text: '开头', bold: true },
      { text: '以及后面是正文', bold: false }
    ])
  })

  it('can delete a cross-run span without leaking leftover bold text', () => {
    const xml = paragraph(run('一、', true), run('待删除的正文'))
    const { xml: next, count } = replaceTextInParagraphXml(xml, '一、待删除的正文', '')
    expect(count).toBe(1)
    expect(extractTextFromParagraphXml(next)).toBe('')
    expect(extractRuns(next)).toEqual([
      { text: '', bold: true },
      { text: '', bold: false }
    ])
  })

  it('escapes XML in replacement text', () => {
    const xml = paragraph(run('A', true), run(' and B'))
    const { xml: next, count } = replaceTextInParagraphXml(xml, 'A and B', 'A <B> & C')
    expect(count).toBe(1)
    expect(extractTextFromParagraphXml(next)).toBe('A &lt;B&gt; &amp; C')
    expect(extractRuns(next)).toEqual([
      { text: 'A', bold: true },
      { text: ' &lt;B&gt; &amp; C', bold: false }
    ])
  })
})
