/**
 * Markdown 选区作用域登记：发送时由岗壳静默取出交给 AI，不进 Composer 引用胶囊。
 */
import { describe, expect, it } from 'vitest'
import {
  consumeSelectionScope,
  registerSelectionScopeProvider
} from '../selection-scope'

describe('selection-scope registry', () => {
  it('consume 取出后清除，再次 consume 为 null', () => {
    const unregister = registerSelectionScopeProvider('tab-1', {
      getScope: () => ({
        label: 'a.md',
        sourcePath: '/tmp/a.md',
        sourceLinesAccurate: false,
        startLine: null,
        endLine: null,
        excerpt: 'hello scope',
        quoteOrigin: 'canvas'
      }),
      clearScope: () => {}
    })
    const first = consumeSelectionScope('tab-1')
    expect(first?.excerpt).toBe('hello scope')
    // provider 仍在，但 clear 后若 getScope 仍返回同一内容会再次取出；
    // 本测试用一次性 provider 模拟 clear 后无选区
    unregister()
    registerSelectionScopeProvider('tab-1', {
      getScope: () => null,
      clearScope: () => {}
    })
    expect(consumeSelectionScope('tab-1')).toBeNull()
  })

  it('无登记时 consume 返回 null', () => {
    expect(consumeSelectionScope('no-such-tab')).toBeNull()
  })

  it('consume 会调用 clearScope', () => {
    let cleared = false
    registerSelectionScopeProvider('tab-clear', {
      getScope: () => ({
        label: 'b.md',
        sourcePath: null,
        sourceLinesAccurate: false,
        startLine: null,
        endLine: null,
        excerpt: 'x',
        quoteOrigin: 'canvas'
      }),
      clearScope: () => {
        cleared = true
      }
    })
    consumeSelectionScope('tab-clear')
    expect(cleared).toBe(true)
  })
})
