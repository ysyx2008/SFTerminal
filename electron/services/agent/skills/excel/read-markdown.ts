/**
 * excel_read 范围结果的 Markdown 表格（首列为 Excel 行号）
 */

export function buildReadRangeMarkdownTable(
  startRow: number,
  colHeaders: string[],
  rows: string[][],
  rowColLabel: string,
  hintLine: string
): string {
  if (rows.length === 0) return ''

  let md = `> ${hintLine}\n\n`
  md += '| ' + rowColLabel + ' | ' + colHeaders.join(' | ') + ' |\n'
  md += '| --- | ' + colHeaders.map(() => '---').join(' | ') + ' |\n'
  for (let i = 0; i < rows.length; i++) {
    md += '| ' + (startRow + i) + ' | ' + rows[i].join(' | ') + ' |\n'
  }
  return md
}
