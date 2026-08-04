import { describe, it, expect } from 'vitest'
import {
  createCoeditEntry,
  decideExternalContent,
  entryAfterAcceptDeferred,
  entryAfterApply,
  entryAfterDefer,
  entryAfterDismissDeferred,
  entryAfterSave
} from '../domain/coedit-conflict'

describe('coedit-conflict', () => {
  describe('decideExternalContent', () => {
    it('无协同记录（首次外部内容）→ 接受', () => {
      expect(decideExternalContent(undefined, '')).toBe('applied')
    })

    it('尚无基线 → 接受', () => {
      expect(decideExternalContent(createCoeditEntry(), 'anything')).toBe('applied')
    })

    it('渲染器标记 dirty → 挂起', () => {
      const entry = { baseline: 'v1', dirty: true }
      expect(decideExternalContent(entry, 'v1')).toBe('deferred')
    })

    it('store 内容偏离基线（用户草稿已 flush）→ 挂起', () => {
      const entry = { baseline: 'v1', dirty: false }
      expect(decideExternalContent(entry, 'user draft')).toBe('deferred')
    })

    it('内容等于基线且未 dirty → 接受', () => {
      const entry = { baseline: 'v1', dirty: false }
      expect(decideExternalContent(entry, 'v1')).toBe('applied')
    })

    it('dirty=true 但基线尚未建立（用户在建档前已开始打字）→ 挂起', () => {
      const entry = { dirty: true }
      expect(decideExternalContent(entry, '')).toBe('deferred')
    })
  })

  describe('entry 状态迁移', () => {
    it('接受后：基线前进、dirty 与挂起解除', () => {
      const next = entryAfterApply({ baseline: 'v1', deferred: 'x', dirty: true }, 'v2')
      expect(next).toEqual({ baseline: 'v2', dirty: false, deferred: undefined })
    })

    it('挂起后：基线前进到磁盘真相、记录挂起版本、dirty 保持', () => {
      const next = entryAfterDefer({ baseline: 'v1', dirty: true }, 'v2')
      expect(next).toEqual({ baseline: 'v2', deferred: 'v2', dirty: true })
    })

    it('挂起后 dirty 恒为 true（store 内容偏离路径进来时 dirty 原本为 false）', () => {
      const next = entryAfterDefer({ baseline: 'v1', dirty: false }, 'v2')
      expect(next.dirty).toBe(true)
    })

    it('无协同记录时挂起：建立基线并标记 dirty', () => {
      const next = entryAfterDefer(undefined, 'v2')
      expect(next).toEqual({ baseline: 'v2', deferred: 'v2', dirty: true })
    })

    it('连续挂起：deferred 刷新为最新外部版本', () => {
      const first = entryAfterDefer({ baseline: 'v1', dirty: true }, 'v2')
      const second = entryAfterDefer(first, 'v3')
      expect(second).toEqual({ baseline: 'v3', deferred: 'v3', dirty: true })
    })

    it('保存成功：基线 = 草稿，冲突解除', () => {
      const next = entryAfterSave({ baseline: 'v2', deferred: 'v2', dirty: true }, 'my draft')
      expect(next).toEqual({ baseline: 'my draft', dirty: false, deferred: undefined })
    })

    it('载入外部版本：dirty 解除、挂起清空（基线在挂起时已前进）', () => {
      const deferred = entryAfterDefer({ baseline: 'v1', dirty: true }, 'v2')
      const next = entryAfterAcceptDeferred(deferred)
      expect(next).toEqual({ baseline: 'v2', dirty: false, deferred: undefined })
    })

    it('保留我的修改：仅关闭提示，dirty 保持', () => {
      const deferred = entryAfterDefer({ baseline: 'v1', dirty: true }, 'v2')
      const next = entryAfterDismissDeferred(deferred)
      expect(next).toEqual({ baseline: 'v2', dirty: true, deferred: undefined })
    })
  })

  describe('完整冲突剧本', () => {
    it('用户 dirty → AI 改盘挂起 → 用户保留 → 保存覆盖 AI 版本', () => {
      // 初始：磁盘 v1，干净
      let entry = entryAfterApply(undefined, 'v1')
      expect(decideExternalContent(entry, 'v1')).toBe('applied')

      // 用户编辑未保存（渲染器推送 dirty）
      entry = { ...entry, dirty: true }

      // AI 改盘 → v2 到达 → 挂起
      expect(decideExternalContent(entry, 'v1')).toBe('deferred')
      entry = entryAfterDefer(entry, 'v2')

      // 用户选择保留自己的修改 → 仅关提示
      entry = entryAfterDismissDeferred(entry)
      expect(entry.dirty).toBe(true)

      // 用户保存草稿 → 覆盖磁盘上的 v2
      entry = entryAfterSave(entry, 'user version')
      expect(entry).toEqual({ baseline: 'user version', dirty: false, deferred: undefined })
    })

    it('用户 dirty → AI 改盘挂起 → 用户载入 AI 版本', () => {
      let entry = { ...entryAfterApply(undefined, 'v1'), dirty: true }
      expect(decideExternalContent(entry, 'v1')).toBe('deferred')
      entry = entryAfterDefer(entry, 'v2')
      entry = entryAfterAcceptDeferred(entry)
      // 载入后：基线 = v2 = 正文，干净
      expect(entry).toEqual({ baseline: 'v2', dirty: false, deferred: undefined })
      expect(decideExternalContent(entry, 'v2')).toBe('applied')
    })
  })
})
