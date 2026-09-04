import { describe, expect, it } from 'vitest'
import { formatProcessFoldCaption, type ProcessFoldSay } from './process-fold-label'

const say: ProcessFoldSay = {
  working: '在忙',
  thinking: '在想',
  thought: '想了想',
  colleagues: n => `${n} 个人在并行`,
  doing: kind => ({ read: '在读文件', write: '在写文件', edit: '在改文件', command: '在跑命令', search: '在搜', browse: '在看网页', other: '在忙' }[kind]),
  counted: (kind, n) => ({ read: `读了 ${n} 个文件`, write: `写了 ${n} 个文件`, edit: `改了 ${n} 个文件`, command: `跑了 ${n} 条命令`, search: `搜了 ${n} 次`, browse: `打开了 ${n} 个网页`, other: `做了 ${n} 步` }[kind]),
  sep: '，',
}

describe('formatProcessFoldCaption', () => {
  it('prefers the thinking line and appends what it already did', () => {
    expect(formatProcessFoldCaption({
      liveText: '在改第三章',
      thinkingOnly: false,
      counts: { read: 2, edit: 1 },
    }, say)).toBe('在改第三章，读了 2 个文件，改了 1 个文件')
  })

  it('says the current action when thinking has not landed yet', () => {
    expect(formatProcessFoldCaption({
      liveAction: 'read',
      thinkingOnly: false,
      counts: { read: 1 },
    }, say)).toBe('在读文件，读了 1 个文件')
  })

  it('says it is thinking when nothing else is available', () => {
    expect(formatProcessFoldCaption({
      thinkingOnly: true,
      counts: {},
    }, say)).toBe('在想')
  })
})
