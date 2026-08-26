import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

import { askUser, normalizeAskOptions, resolveAskDefault } from '../tools/misc'

describe('normalizeAskOptions', () => {
  it('rejects missing, empty, or single options', () => {
    expect(normalizeAskOptions(undefined)).toBeNull()
    expect(normalizeAskOptions([])).toBeNull()
    expect(normalizeAskOptions(['只要一个'])).toBeNull()
    expect(normalizeAskOptions(['  ', ''])).toBeNull()
    expect(normalizeAskOptions(['好', 1, null])).toBeNull()
    expect(normalizeAskOptions(['甲', '甲', ' 甲 '])).toBeNull()
  })

  it('keeps at least two trimmed choices and caps at ten', () => {
    expect(normalizeAskOptions([' 甲 ', '乙'])).toEqual(['甲', '乙'])
    expect(normalizeAskOptions(['甲', '甲', '乙'])).toEqual(['甲', '乙'])
    const many = Array.from({ length: 12 }, (_, i) => `选项${i + 1}`)
    expect(normalizeAskOptions(many)).toHaveLength(10)
  })
})

describe('askUser 推荐选项', () => {
  const makeExecutor = () => ({
    addStep: vi.fn(() => ({ id: 'ask-1' })),
    updateStep: vi.fn(),
    isAborted: () => true,
    hasPendingUserMessage: () => false,
    consumePendingUserMessage: () => undefined
  })

  it('没有推荐选项时不真正提问', async () => {
    const executor = makeExecutor()
    const result = await askUser({ question: '选哪个？' }, executor as never)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/至少 2 个推荐选项|at least 2 recommended/i)
    expect(executor.addStep).not.toHaveBeenCalled()
  })

  it('没标明最推荐的那一个时不真正提问', async () => {
    const executor = makeExecutor()
    const result = await askUser(
      { question: '选哪个？', options: ['甲', '乙'] },
      executor as never
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/最推荐|most recommended/i)
    expect(executor.addStep).not.toHaveBeenCalled()
  })

  it('最推荐的不在选项里时不真正提问', async () => {
    const executor = makeExecutor()
    const result = await askUser(
      { question: '选哪个？', options: ['甲', '乙'], default_value: '丙' },
      executor as never
    )
    expect(result.success).toBe(false)
    expect(executor.addStep).not.toHaveBeenCalled()
  })

  it('选项够了并标明最推荐才会进入提问，最推荐排在最前', async () => {
    const executor = makeExecutor()
    const result = await askUser(
      { question: '选哪个？', options: ['甲', '乙'], default_value: '乙' },
      executor as never
    )
    expect(executor.addStep).toHaveBeenCalled()
    expect(executor.addStep.mock.calls[0][0].toolArgs.options).toEqual(['乙', '甲'])
    expect(executor.addStep.mock.calls[0][0].toolArgs.default_value).toBe('乙')
    expect(result.success).toBe(false)
  })
})

describe('resolveAskDefault', () => {
  it('only accepts a trimmed value that is already an option', () => {
    expect(resolveAskDefault(' 乙 ', ['甲', '乙'])).toBe('乙')
    expect(resolveAskDefault('丙', ['甲', '乙'])).toBeNull()
    expect(resolveAskDefault('', ['甲', '乙'])).toBeNull()
    expect(resolveAskDefault(undefined, ['甲', '乙'])).toBeNull()
  })
})
