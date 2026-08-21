import { describe, it, expect } from 'vitest'
import { resolveCliDataMode } from '../cli-data.js'

describe('resolveCliDataMode', () => {
  it('显式目录优先，视为沙箱', () => {
    expect(resolveCliDataMode({
      explicitDir: '/tmp/sft-test',
      sandboxFlag: true,
      shareDesktopFlag: true,
      defaultSandbox: true,
    })).toEqual({ mode: 'sandbox', explicitDir: '/tmp/sft-test' })
  })

  it('显式沙箱优先于共用桌面', () => {
    expect(resolveCliDataMode({
      sandboxFlag: true,
      shareDesktopFlag: true,
      defaultSandbox: false,
    })).toEqual({ mode: 'sandbox' })
  })

  it('开发默认沙箱可被 --share-desktop 覆盖', () => {
    expect(resolveCliDataMode({
      shareDesktopFlag: true,
      defaultSandbox: true,
    })).toEqual({ mode: 'shared' })
  })

  it('开发入口默认进沙箱', () => {
    expect(resolveCliDataMode({ defaultSandbox: true })).toEqual({ mode: 'sandbox' })
  })

  it('装机入口默认与桌面共用', () => {
    expect(resolveCliDataMode({})).toEqual({ mode: 'shared' })
  })
})
