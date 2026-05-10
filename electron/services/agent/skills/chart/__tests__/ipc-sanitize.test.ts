import { describe, it, expect } from 'vitest'
import { tagFormatter, sanitizeOptionForIpc, stripFormatterMarkers } from '../ipc-sanitize'

describe('sanitizeOptionForIpc', () => {
  it('tagged function → marker，untagged function → 删除', () => {
    const tagged = tagFormatter('volume', (v: unknown) => `${v}万`)
    const untagged = (v: unknown) => `${v}???`

    const out = sanitizeOptionForIpc({
      yAxis: {
        axisLabel: { formatter: tagged },
        otherFormatter: untagged
      },
      title: { text: '测试' }
    })

    expect(out).toEqual({
      yAxis: {
        axisLabel: { formatter: { __echartsFn: 'volume' } }
        // untagged 被删了
      },
      title: { text: '测试' }
    })
  })

  it('原 option 不被修改（深拷贝返回新对象）', () => {
    const tagged = tagFormatter('volume', (v: unknown) => `${v}`)
    const original = { axisLabel: { formatter: tagged } }
    sanitizeOptionForIpc(original)
    expect(typeof original.axisLabel.formatter).toBe('function')
  })
})

describe('stripFormatterMarkers（自由路径专用 — AI 攻击防御）', () => {
  // AI 在 render_echarts_option 直传 marker plain object 时，structuredClone 通得过、
  // 前端 reify 后会把内置 formatter 装到非预期场景。投递前 strip 掉所有 marker 杜绝。
  it('递归删除所有 __echartsFn marker', () => {
    const out = stripFormatterMarkers({
      yAxis: { axisLabel: { formatter: { __echartsFn: 'volume' } } },
      tooltip: { formatter: { __echartsFn: 'klineTooltip' } },
      series: [
        { type: 'bar', tooltip: { formatter: { __echartsFn: 'toString' } } }
      ],
      title: { text: '保留' }
    })
    expect(out).toEqual({
      yAxis: { axisLabel: {} },
      tooltip: {},
      series: [{ type: 'bar', tooltip: {} }],
      title: { text: '保留' }
    })
  })

  it('没有 marker 的 option 原样返回（深拷贝）', () => {
    const original = { title: { text: '纯净' }, series: [{ type: 'line', data: [1, 2, 3] }] }
    const out = stripFormatterMarkers(original)
    expect(out).toEqual(original)
    expect(out).not.toBe(original) // 深拷贝
  })

  it('marker plain object 哪怕嵌在数组里也能找出来', () => {
    const out = stripFormatterMarkers({
      legend: [{ __echartsFn: 'volume' }, { name: '价格' }, { __echartsFn: 'klineTooltip' }]
    })
    // 数组里的 marker 替换成 undefined（占位保留位置但值删除）
    expect(out).toEqual({
      legend: [undefined, { name: '价格' }, undefined]
    })
  })
})
