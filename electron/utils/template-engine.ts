/**
 * 通用模板引擎
 *
 * 提供 Mustache 风格的占位符语法，被 Word/Excel 等模板填充工具复用。
 *
 * 支持的语法：
 * - {{key}}                  简单替换
 * - {{a.b.c}}                嵌套字段
 * - {{a[0].b}}               数组索引
 * - {{this}} / {{.}}         循环内当前项
 * - {{@index}}               循环内序号（从 0 开始）
 * - {{@index1}}              循环内序号（从 1 开始）
 * - {{#each items}}...{{/each}}  循环块
 *
 * 不支持（YAGNI）：条件块、helper、过滤器、HTML 转义
 */

/** 占位符在文本中的位置和类型 */
export interface Placeholder {
  /** 完整的 {{...}} 原文 */
  raw: string
  /** 表达式（去掉 {{ }} 和首尾空白后的内容） */
  expr: string
  /** 在原文本中的起始位置 */
  start: number
  /** 在原文本中的结束位置（exclusive） */
  end: number
  /** 占位符类型 */
  kind: 'value' | 'each-start' | 'each-end'
}

/** 缺失字段的处理策略 */
export type MissingStrategy = 'error' | 'keep' | 'empty'

/** 求值结果 */
export interface ResolveResult {
  found: boolean
  value: unknown
}

/** 简单替换的结果 */
export interface FillResult {
  /** 替换后的文本 */
  text: string
  /** 实际替换的占位符表达式列表（去重） */
  replaced: string[]
  /** 缺失的占位符表达式列表（去重） */
  missing: string[]
}

/** 循环内的特殊变量 key（注入到循环 context 中） */
export const LOOP_INDEX_KEY = '__index'
export const LOOP_INDEX1_KEY = '__index1'
export const LOOP_THIS_KEY = '__this'

const PLACEHOLDER_RE = /\{\{\s*([^{}]+?)\s*\}\}/g

/**
 * 扫描文本中所有 `{{...}}` 占位符，返回位置和类型信息。
 *
 * 注意：占位符必须不跨行写法不影响，但 `{{` 和 `}}` 之间不能再嵌套 `{` 或 `}`。
 */
export function findPlaceholders(text: string): Placeholder[] {
  const result: Placeholder[] = []
  PLACEHOLDER_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
    const inner = m[1].trim()
    let kind: Placeholder['kind'] = 'value'
    let expr = inner
    if (inner.startsWith('#each ')) {
      kind = 'each-start'
      expr = inner.slice(6).trim()
    } else if (inner === '#each') {
      // 缺少字段，标为非法 each-start，后续校验
      kind = 'each-start'
      expr = ''
    } else if (inner === '/each') {
      kind = 'each-end'
      expr = ''
    }
    result.push({
      raw: m[0],
      expr,
      start: m.index,
      end: m.index + m[0].length,
      kind
    })
  }
  return result
}

/**
 * 拆解表达式为路径 token 列表。
 *
 * 支持：`a.b.c`、`a[0].b`、`a["key"].b`。
 */
export function parseExprTokens(expr: string): Array<string | number> {
  const tokens: Array<string | number> = []
  let buf = ''
  let i = 0
  while (i < expr.length) {
    const c = expr[i]
    if (c === '.') {
      if (buf) {
        tokens.push(buf)
        buf = ''
      }
      i++
      continue
    }
    if (c === '[') {
      if (buf) {
        tokens.push(buf)
        buf = ''
      }
      const close = expr.indexOf(']', i)
      if (close === -1) {
        throw new Error(`Invalid expression "${expr}": missing ']'`)
      }
      let key = expr.slice(i + 1, close).trim()
      // 去除字符串引号
      if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
        key = key.slice(1, -1)
        tokens.push(key)
      } else if (/^-?\d+$/.test(key)) {
        tokens.push(parseInt(key, 10))
      } else if (key) {
        tokens.push(key)
      }
      i = close + 1
      continue
    }
    buf += c
    i++
  }
  if (buf) tokens.push(buf)
  return tokens
}

/**
 * 在数据对象中按表达式取值。
 *
 * 特殊表达式：
 * - `this` / `.` → 返回 data 本身（用于循环内基本类型项）
 * - `@index` → 取 data[__index]
 * - `@index1` → 取 data[__index1]
 */
export function resolveValue(data: unknown, expr: string): ResolveResult {
  if (expr === 'this' || expr === '.') {
    if (data && typeof data === 'object' && LOOP_THIS_KEY in (data as Record<string, unknown>)) {
      return { found: true, value: (data as Record<string, unknown>)[LOOP_THIS_KEY] }
    }
    return { found: true, value: data }
  }
  if (expr === '@index') {
    const v = (data as Record<string, unknown> | null)?.[LOOP_INDEX_KEY]
    return v !== undefined ? { found: true, value: v } : { found: false, value: undefined }
  }
  if (expr === '@index1') {
    const v = (data as Record<string, unknown> | null)?.[LOOP_INDEX1_KEY]
    return v !== undefined ? { found: true, value: v } : { found: false, value: undefined }
  }
  if (!expr) return { found: false, value: undefined }

  let tokens: Array<string | number>
  try {
    tokens = parseExprTokens(expr)
  } catch {
    return { found: false, value: undefined }
  }

  let cur: unknown = data
  for (const tok of tokens) {
    if (cur == null) return { found: false, value: undefined }
    if (typeof cur !== 'object') return { found: false, value: undefined }
    cur = (cur as Record<string | number, unknown>)[tok]
    if (cur === undefined) return { found: false, value: undefined }
  }
  return { found: true, value: cur }
}

/**
 * 把任意值序列化成可放入文本的字符串。
 *
 * - null/undefined → ''
 * - 对象/数组 → JSON.stringify
 * - 其他 → String(value)
 */
export function stringifyValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * 在文本中替换所有简单 `{{...}}` 占位符（不处理 each 循环）。
 *
 * 调用方负责先用 `expandLoops` 展开循环，再用本函数做最后一轮替换。
 */
export function fillPlaceholders(
  text: string,
  data: unknown,
  options: { onMissing?: MissingStrategy } = {}
): FillResult {
  const onMissing = options.onMissing ?? 'error'
  const placeholders = findPlaceholders(text)
  const replaced = new Set<string>()
  const missing = new Set<string>()

  // 从后往前替换，避免位置偏移
  let result = text
  for (let i = placeholders.length - 1; i >= 0; i--) {
    const p = placeholders[i]
    if (p.kind !== 'value') continue
    const r = resolveValue(data, p.expr)
    if (r.found) {
      replaced.add(p.expr)
      result = result.slice(0, p.start) + stringifyValue(r.value) + result.slice(p.end)
    } else {
      missing.add(p.expr)
      if (onMissing === 'empty') {
        result = result.slice(0, p.start) + '' + result.slice(p.end)
      }
      // 'keep' 不动；'error' 由调用方在收到 missing 列表后决定如何报错
    }
  }

  return {
    text: result,
    replaced: Array.from(replaced),
    missing: Array.from(missing)
  }
}

/**
 * 将循环 context 注入特殊变量（@index, @index1）。
 *
 * 用于循环展开时，给每次迭代的数据加上 __index / __index1 / __this。
 */
export function makeLoopContext(item: unknown, index: number, parent: unknown): Record<string, unknown> {
  const ctx: Record<string, unknown> = {}
  // 父作用域提升：item 不是对象时，也允许引用父作用域字段
  if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
    Object.assign(ctx, parent as Record<string, unknown>)
  }
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    Object.assign(ctx, item as Record<string, unknown>)
  } else {
    // 基本类型/数组：用 __this 暴露给 {{this}}
    ctx[LOOP_THIS_KEY] = item
  }
  ctx[LOOP_INDEX_KEY] = index
  ctx[LOOP_INDEX1_KEY] = index + 1
  return ctx
}

/**
 * 在一段文本中查找最外层的 `{{#each xxx}}...{{/each}}` 块。
 *
 * 返回值包含：
 * - 起始 each 占位符位置
 * - 结束 /each 占位符位置
 * - 块内"模板"内容（each 和 /each 之间）
 *
 * 支持嵌套：内层 each/each 会被跳过，只匹配最外层。
 *
 * 用于处理纯文本场景（如 Excel 单元格、单段 Word 段落内嵌循环）。
 * Word 段落级 / 表格行级循环是结构化的，不通过本函数。
 */
export interface TextLoopBlock {
  field: string
  /** {{#each}} 占位符的起始位置 */
  startTagBegin: number
  /** {{#each}} 占位符的结束位置 */
  startTagEnd: number
  /** {{/each}} 占位符的起始位置 */
  endTagBegin: number
  /** {{/each}} 占位符的结束位置 */
  endTagEnd: number
  /** 模板内容（不含 each/each 标签） */
  innerText: string
}

export function findTextLoopBlocks(text: string): TextLoopBlock[] {
  const placeholders = findPlaceholders(text)
  const blocks: TextLoopBlock[] = []
  const stack: Placeholder[] = []

  for (const p of placeholders) {
    if (p.kind === 'each-start') {
      stack.push(p)
    } else if (p.kind === 'each-end') {
      const start = stack.pop()
      if (!start) {
        throw new Error('Unmatched {{/each}}: no matching {{#each}}')
      }
      // 只收集最外层
      if (stack.length === 0) {
        blocks.push({
          field: start.expr,
          startTagBegin: start.start,
          startTagEnd: start.end,
          endTagBegin: p.start,
          endTagEnd: p.end,
          innerText: text.slice(start.end, p.start)
        })
      }
    }
  }

  if (stack.length > 0) {
    throw new Error(`Unmatched {{#each ${stack[0].expr}}}: no matching {{/each}}`)
  }

  return blocks
}

/**
 * 展开纯文本中的所有 each 循环。
 *
 * 工作流程：
 * 1. 找最外层 each 块
 * 2. 求值 each 字段，必须是数组
 * 3. 对数组每一项，递归展开块内的循环（支持嵌套）
 * 4. 把块替换为展开后的内容
 *
 * 注意：本函数只处理循环展开，不处理简单 `{{xxx}}` 替换；
 * 调用方在循环展开后再用 `fillPlaceholders` 做最终替换。
 */
export function expandTextLoops(
  text: string,
  data: unknown,
  options: { onMissing?: MissingStrategy } = {}
): { text: string; missingFields: string[] } {
  const missingFields = new Set<string>()
  const result = expandTextLoopsInner(text, data, options, missingFields)
  return { text: result, missingFields: Array.from(missingFields) }
}

function expandTextLoopsInner(
  text: string,
  data: unknown,
  options: { onMissing?: MissingStrategy },
  missingFields: Set<string>
): string {
  const blocks = findTextLoopBlocks(text)
  if (blocks.length === 0) return text

  // 从后往前替换避免偏移
  let result = text
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    const r = resolveValue(data, block.field)
    let expanded = ''
    if (!r.found || !Array.isArray(r.value)) {
      missingFields.add(block.field)
      if (options.onMissing === 'keep') {
        // 保留原文（含 each/each 标签）
        continue
      }
      // empty / error：循环展开为空，error 由调用方根据 missingFields 决定如何报错
    } else {
      const arr = r.value as unknown[]
      const parts: string[] = []
      for (let idx = 0; idx < arr.length; idx++) {
        const ctx = makeLoopContext(arr[idx], idx, data)
        // 1. 先递归展开内层循环（使用本层 context）
        const innerExpanded = expandTextLoopsInner(block.innerText, ctx, options, missingFields)
        // 2. 用本层 context 替换内层的简单占位符（{{this}}/{{@index}}/字段引用）
        const filled = fillPlaceholders(innerExpanded, ctx, options)
        for (const m of filled.missing) missingFields.add(m)
        parts.push(filled.text)
      }
      expanded = parts.join('')
    }
    result = result.slice(0, block.startTagBegin) + expanded + result.slice(block.endTagEnd)
  }
  return result
}

/**
 * 一次性渲染纯文本模板：先展开循环，再替换简单占位符。
 */
export function renderText(
  text: string,
  data: unknown,
  options: { onMissing?: MissingStrategy } = {}
): FillResult {
  const expanded = expandTextLoops(text, data, options)
  const filled = fillPlaceholders(expanded.text, data, options)
  return {
    text: filled.text,
    replaced: filled.replaced,
    missing: Array.from(new Set([...expanded.missingFields, ...filled.missing]))
  }
}
