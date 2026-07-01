/**
 * resolveWorkbenchKind —— tab → WorkbenchKind 映射
 *
 * 注：registry.ts 会 import 各 workbench 的 descriptor（引用 .vue 组件）和 TerminalTabView.vue，
 * vitest 配置未启用 @vitejs/plugin-vue，无法在测试里直接 import .vue。
 * 因此这里 mock 掉所有 .vue 相关模块，只测纯函数 resolveWorkbenchKind 的映射逻辑。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../local/descriptor', () => ({ descriptor: { kind: 'local' } }))
vi.mock('../ssh/descriptor', () => ({ descriptor: { kind: 'ssh' } }))
vi.mock('../assistant/descriptor', () => ({ descriptor: { kind: 'assistant' } }))
vi.mock('../companion/descriptor', () => ({ descriptor: { kind: 'companion' } }))
vi.mock('../skill/descriptor', () => ({ descriptor: { kind: 'skill' } }))
vi.mock('../../components/TerminalTabView.vue', () => ({ default: {} }))

const { resolveWorkbenchKind } = await import('../registry')

describe('resolveWorkbenchKind', () => {
  it('普通 assistant tab 映射到 assistant', () => {
    expect(resolveWorkbenchKind({ type: 'assistant', agentId: 'assistant-abc' })).toBe('assistant')
  })

  it('agentId 为 __companion__ 的 assistant tab 映射到 companion', () => {
    expect(resolveWorkbenchKind({ type: 'assistant', agentId: '__companion__' })).toBe('companion')
  })

  it('agentId 为 __skill__ 的 assistant tab 映射到 skill', () => {
    expect(resolveWorkbenchKind({ type: 'assistant', agentId: '__skill__' })).toBe('skill')
  })

  it('local / ssh tab 直接复用 tab.type', () => {
    expect(resolveWorkbenchKind({ type: 'local' })).toBe('local')
    expect(resolveWorkbenchKind({ type: 'ssh' })).toBe('ssh')
  })

  it('agentId 缺失的 assistant tab 退化为 assistant', () => {
    expect(resolveWorkbenchKind({ type: 'assistant' })).toBe('assistant')
  })
})
