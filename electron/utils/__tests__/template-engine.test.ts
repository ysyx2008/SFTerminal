/**
 * 通用模板引擎单元测试
 */
import { describe, it, expect } from 'vitest'
import {
  findPlaceholders,
  parseExprTokens,
  resolveValue,
  fillPlaceholders,
  expandTextLoops,
  renderText,
  makeLoopContext,
  stringifyValue,
  findTextLoopBlocks
} from '../template-engine'

describe('parseExprTokens', () => {
  it('parses simple key', () => {
    expect(parseExprTokens('name')).toEqual(['name'])
  })

  it('parses nested fields', () => {
    expect(parseExprTokens('user.dept.name')).toEqual(['user', 'dept', 'name'])
  })

  it('parses array indexes', () => {
    expect(parseExprTokens('items[0].title')).toEqual(['items', 0, 'title'])
  })

  it('parses mixed brackets and dots', () => {
    expect(parseExprTokens('a.b[2].c[3]')).toEqual(['a', 'b', 2, 'c', 3])
  })

  it('parses string keys in brackets', () => {
    expect(parseExprTokens('a["x"].b')).toEqual(['a', 'x', 'b'])
    expect(parseExprTokens("a['y'].b")).toEqual(['a', 'y', 'b'])
  })
})

describe('findPlaceholders', () => {
  it('finds simple placeholder', () => {
    const result = findPlaceholders('Hello {{name}}!')
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('value')
    expect(result[0].expr).toBe('name')
    expect(result[0].raw).toBe('{{name}}')
  })

  it('finds multiple placeholders', () => {
    const result = findPlaceholders('{{a}} and {{b.c}}')
    expect(result).toHaveLength(2)
    expect(result[0].expr).toBe('a')
    expect(result[1].expr).toBe('b.c')
  })

  it('classifies each markers', () => {
    const result = findPlaceholders('{{#each items}}x{{/each}}')
    expect(result).toHaveLength(2)
    expect(result[0].kind).toBe('each-start')
    expect(result[0].expr).toBe('items')
    expect(result[1].kind).toBe('each-end')
  })

  it('tolerates whitespace inside braces', () => {
    const result = findPlaceholders('{{ name }} {{ #each items }} {{ /each }}')
    expect(result).toHaveLength(3)
    expect(result[0].kind).toBe('value')
    expect(result[0].expr).toBe('name')
    expect(result[1].kind).toBe('each-start')
    expect(result[1].expr).toBe('items')
    expect(result[2].kind).toBe('each-end')
  })

  it('ignores invalid double-brace patterns', () => {
    expect(findPlaceholders('plain text')).toHaveLength(0)
    // 嵌套大括号不被识别
    expect(findPlaceholders('{{a{{b}}}}')).toHaveLength(1)
  })
})

describe('resolveValue', () => {
  it('resolves top-level key', () => {
    expect(resolveValue({ name: 'Alice' }, 'name')).toEqual({ found: true, value: 'Alice' })
  })

  it('resolves nested', () => {
    const data = { user: { dept: { name: '财务部' } } }
    expect(resolveValue(data, 'user.dept.name')).toEqual({ found: true, value: '财务部' })
  })

  it('resolves array index', () => {
    const data = { items: [{ title: 'A' }, { title: 'B' }] }
    expect(resolveValue(data, 'items[1].title')).toEqual({ found: true, value: 'B' })
  })

  it('returns not found for missing key', () => {
    expect(resolveValue({ a: 1 }, 'b')).toEqual({ found: false, value: undefined })
    expect(resolveValue({ a: { b: 1 } }, 'a.c')).toEqual({ found: false, value: undefined })
  })

  it('returns not found when traversing through null', () => {
    expect(resolveValue({ a: null }, 'a.b')).toEqual({ found: false, value: undefined })
  })

  it('handles {{this}} when ctx has __this', () => {
    expect(resolveValue({ __this: 'x' }, 'this')).toEqual({ found: true, value: 'x' })
    expect(resolveValue({ __this: 'x' }, '.')).toEqual({ found: true, value: 'x' })
  })

  it('returns data itself for {{this}} when no __this', () => {
    expect(resolveValue({ a: 1 }, 'this')).toEqual({ found: true, value: { a: 1 } })
  })

  it('resolves @index and @index1', () => {
    const ctx = { __index: 0, __index1: 1 }
    expect(resolveValue(ctx, '@index')).toEqual({ found: true, value: 0 })
    expect(resolveValue(ctx, '@index1')).toEqual({ found: true, value: 1 })
  })
})

describe('stringifyValue', () => {
  it('stringifies primitives', () => {
    expect(stringifyValue('hello')).toBe('hello')
    expect(stringifyValue(42)).toBe('42')
    expect(stringifyValue(true)).toBe('true')
    expect(stringifyValue(false)).toBe('false')
  })

  it('handles null/undefined', () => {
    expect(stringifyValue(null)).toBe('')
    expect(stringifyValue(undefined)).toBe('')
  })

  it('JSON-stringifies objects', () => {
    expect(stringifyValue({ a: 1 })).toBe('{"a":1}')
  })
})

describe('fillPlaceholders', () => {
  it('replaces simple placeholder', () => {
    const r = fillPlaceholders('Hello {{name}}!', { name: 'Alice' })
    expect(r.text).toBe('Hello Alice!')
    expect(r.replaced).toEqual(['name'])
    expect(r.missing).toEqual([])
  })

  it('replaces multiple placeholders', () => {
    const r = fillPlaceholders('{{a}}-{{b}}-{{a}}', { a: 'X', b: 'Y' })
    expect(r.text).toBe('X-Y-X')
    expect(r.replaced.sort()).toEqual(['a', 'b'])
  })

  it('replaces nested fields', () => {
    const r = fillPlaceholders('{{user.name}}', { user: { name: 'Bob' } })
    expect(r.text).toBe('Bob')
  })

  it('on_missing=error: leaves placeholder alone, reports missing', () => {
    const r = fillPlaceholders('{{name}} {{missing}}', { name: 'Alice' }, { onMissing: 'error' })
    expect(r.text).toBe('Alice {{missing}}')
    expect(r.missing).toEqual(['missing'])
  })

  it('on_missing=empty: empties missing placeholder', () => {
    const r = fillPlaceholders('{{name}} {{missing}}', { name: 'Alice' }, { onMissing: 'empty' })
    expect(r.text).toBe('Alice ')
    expect(r.missing).toEqual(['missing'])
  })

  it('on_missing=keep: keeps original', () => {
    const r = fillPlaceholders('{{missing}}', {}, { onMissing: 'keep' })
    expect(r.text).toBe('{{missing}}')
  })

  it('does not touch each markers', () => {
    const r = fillPlaceholders('{{#each x}}{{n}}{{/each}}', { n: 'N' })
    // value 占位符被替换；each markers 保留原文
    expect(r.text).toBe('{{#each x}}N{{/each}}')
  })
})

describe('findTextLoopBlocks', () => {
  it('finds single loop', () => {
    const text = 'a {{#each items}}- {{this}}\n{{/each}} b'
    const blocks = findTextLoopBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].field).toBe('items')
    expect(blocks[0].innerText).toBe('- {{this}}\n')
  })

  it('finds nested loops only at outermost level', () => {
    const text = '{{#each outer}}A{{#each inner}}B{{/each}}C{{/each}}'
    const blocks = findTextLoopBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].field).toBe('outer')
  })

  it('throws on unmatched markers', () => {
    expect(() => findTextLoopBlocks('{{#each a}} no end')).toThrow(/Unmatched/)
    expect(() => findTextLoopBlocks('{{/each}} no start')).toThrow(/Unmatched/)
  })
})

describe('expandTextLoops', () => {
  it('expands array of strings', () => {
    const r = expandTextLoops('{{#each items}}-{{this}}{{/each}}', { items: ['a', 'b', 'c'] })
    expect(r.text).toBe('-a-b-c')
  })

  it('expands array of objects', () => {
    const r = expandTextLoops(
      '{{#each rows}}{{name}}={{value}};{{/each}}',
      { rows: [{ name: 'A', value: 1 }, { name: 'B', value: 2 }] }
    )
    expect(r.text).toBe('A=1;B=2;')
  })

  it('exposes @index/@index1', () => {
    const r = expandTextLoops(
      '{{#each items}}[{{@index1}}]{{this}}{{/each}}',
      { items: ['x', 'y'] }
    )
    expect(r.text).toBe('[1]x[2]y')
  })

  it('expands nested loops', () => {
    const r = expandTextLoops(
      '{{#each rows}}<{{label}}:{{#each items}}{{this}},{{/each}}>{{/each}}',
      {
        rows: [
          { label: 'L1', items: ['a', 'b'] },
          { label: 'L2', items: ['c'] }
        ]
      }
    )
    expect(r.text).toBe('<L1:a,b,><L2:c,>')
  })

  it('inherits parent scope for nested object items', () => {
    // 内层循环里既能访问当前 item 也能访问父 row 的字段
    const r = expandTextLoops(
      '{{#each rows}}{{#each items}}{{rowLabel}}-{{this}};{{/each}}{{/each}}',
      {
        rows: [
          { rowLabel: 'R1', items: ['a', 'b'] }
        ]
      }
    )
    expect(r.text).toBe('R1-a;R1-b;')
  })

  it('reports missing field when each target is not array', () => {
    const r = expandTextLoops('{{#each missing}}x{{/each}}', {})
    expect(r.missingFields).toContain('missing')
    expect(r.text).toBe('') // 默认行为：循环展开为空
  })
})

describe('renderText', () => {
  it('combines loop expansion and simple replacement', () => {
    const r = renderText(
      'Hello {{name}}! Items:\n{{#each items}}- {{this}}\n{{/each}}',
      { name: 'Alice', items: ['x', 'y'] }
    )
    expect(r.text).toBe('Hello Alice! Items:\n- x\n- y\n')
    expect(r.missing).toEqual([])
  })
})

describe('makeLoopContext', () => {
  it('exposes object item fields directly', () => {
    const ctx = makeLoopContext({ name: 'Alice', age: 30 }, 0, {})
    expect(ctx.name).toBe('Alice')
    expect(ctx.age).toBe(30)
    expect(ctx.__index).toBe(0)
    expect(ctx.__index1).toBe(1)
  })

  it('exposes primitive items via __this', () => {
    const ctx = makeLoopContext('hello', 2, {})
    expect(ctx.__this).toBe('hello')
    expect(ctx.__index).toBe(2)
    expect(ctx.__index1).toBe(3)
  })

  it('inherits parent scope', () => {
    const parent = { rowLabel: 'R1' }
    const ctx = makeLoopContext({ name: 'item' }, 0, parent)
    expect(ctx.rowLabel).toBe('R1')
    expect(ctx.name).toBe('item')
  })

  it('item fields override parent fields with same name', () => {
    const parent = { name: 'Parent' }
    const ctx = makeLoopContext({ name: 'Child' }, 0, parent)
    expect(ctx.name).toBe('Child')
  })
})
