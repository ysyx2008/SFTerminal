/**
 * 单元格值的展示格式与写前校验（expected_originals）
 */

export interface CellExpectationMismatch {
  ref: string
  expected: string
  actual: string
}

/**
 * 将单元格值格式化为与 excel_read 输出一致的字符串
 */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>

    if ('formula' in obj) {
      if ('result' in obj && obj.result !== undefined && obj.result !== null) {
        return formatCellValue(obj.result)
      }
      return `=${obj.formula}`
    }

    if ('result' in obj) {
      return String(obj.result)
    }

    if ('text' in obj) {
      return String(obj.text)
    }

    if ('richText' in obj) {
      return ((obj.richText as { text: string }[]) || [])
        .map(rt => rt.text)
        .join('')
    }

    return JSON.stringify(value)
  }
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function formatExpectedValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if ('formula' in obj) {
      if ('result' in obj && obj.result !== undefined && obj.result !== null) {
        return formatCellValue(obj.result)
      }
      const f = String(obj.formula)
      return f.startsWith('=') ? f : `=${f}`
    }
    if ('text' in obj) {
      return String(obj.text)
    }
  }
  return formatCellValue(value)
}

export function cellValuesMatch(expected: unknown, actual: unknown): boolean {
  return formatExpectedValue(expected) === formatCellValue(actual)
}

/**
 * 校验 expected_originals；全部通过返回空数组
 */
export function validateExpectedOriginals(
  worksheet: import('exceljs').Worksheet | undefined,
  expectedOriginals: Record<string, unknown>
): CellExpectationMismatch[] {
  const mismatches: CellExpectationMismatch[] = []

  for (const [ref, expected] of Object.entries(expectedOriginals)) {
    const actual = worksheet ? worksheet.getCell(ref).value : null
    if (!cellValuesMatch(expected, actual)) {
      mismatches.push({
        ref,
        expected: formatExpectedValue(expected),
        actual: formatCellValue(actual)
      })
    }
  }

  return mismatches
}
