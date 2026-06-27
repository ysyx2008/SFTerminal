import { describe, it, expect } from 'vitest'
import { inferConversationKind } from '@shared/types'
import { CONVERSATION_POLICY, conversationPolicy } from '../policy'

describe('CONVERSATION_POLICY 策略表', () => {
  it('三类 kind 全部有策略', () => {
    expect(Object.keys(CONVERSATION_POLICY).sort()).toEqual(['companion', 'task', 'watch'])
  })

  it('task：累积、不回种、进列表、主树', () => {
    const p = conversationPolicy('task')
    expect(p).toEqual({
      accumulates: true,
      seedFromHistoryOnColdStart: false,
      visibleInList: true,
      historyTree: 'main',
      perWatchContinuity: false
    })
  })

  it('companion：累积、冷启动回种（长期关系线）、进列表、主树', () => {
    const p = conversationPolicy('companion')
    expect(p.accumulates).toBe(true)
    expect(p.seedFromHistoryOnColdStart).toBe(true) // 联络跨重启续上同一条
    expect(p.visibleInList).toBe(true)
    expect(p.historyTree).toBe('main')
  })

  it('watch：不累积、不进列表、独立 watch 树；seedFromHistoryOnColdStart=true（保真旧 _persistentNamedAgent）', () => {
    const p = conversationPolicy('watch')
    expect(p.accumulates).toBe(false)
    expect(p.visibleInList).toBe(false)
    expect(p.historyTree).toBe('watch')
    // watch 也是持久命名 Agent（桌面 watch 经 createAssistantAgent('__watch__') 标记），
    // 冷启动回种这一轴与 companion 同为 true——重构刻意保真当前行为。
    expect(p.seedFromHistoryOnColdStart).toBe(true)
  })

  it('perWatchContinuity 预留钩子：当前所有 kind 一律 false（维持现状逐次失忆）', () => {
    expect(conversationPolicy('task').perWatchContinuity).toBe(false)
    expect(conversationPolicy('companion').perWatchContinuity).toBe(false)
    expect(conversationPolicy('watch').perWatchContinuity).toBe(false)
  })

  it('策略表与 inferConversationKind 口径一致：持久命名 Agent（companion+watch）冷启动回种，task 不回种', () => {
    // 这条锁定旧 `_persistentNamedAgent` 的等价口径：companion + watch = true，task = false。
    const seed = (k?: string) => conversationPolicy(inferConversationKind(k)).seedFromHistoryOnColdStart
    expect(seed('__companion__')).toBe(true)
    expect(seed('__watch__')).toBe(true)
    expect(seed('tab-123')).toBe(false)
    expect(seed(undefined)).toBe(false)
  })
})
