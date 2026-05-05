/**
 * 视觉样张生成器（不参与 CI 断言，只本地确认效果用）。
 * 默认跳过；运行时设 GENERATE_KLINE_SAMPLE=1 可生成样张到 /tmp/。
 */
import { describe, it } from 'vitest'
import * as fs from 'fs'
import { buildOption } from '../render'
import { renderToSvg } from '../ssr'

const ENABLED = process.env.GENERATE_KLINE_SAMPLE === '1'

function buildSample(n: number) {
  const cats: string[] = []
  const vals: number[][] = []
  const vols: number[] = []
  let p = 4500
  // 用确定性伪随机（基于 i 的 sin/cos 噪声），避免每次生成的样张不一样
  const rng = (i: number, salt: number) => {
    const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453
    return x - Math.floor(x)   // [0,1)
  }
  const start = new Date('2025-06-01')
  for (let i = 0; i < n; i++) {
    const d = new Date(start.getTime() + i * 86400e3)
    cats.push(`${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    // 让蜡烛实体足够明显（A 股日内 1-2% 波动 = 50-100 元）
    const trend = Math.sin(i / 10) * 35
    const noise = (rng(i, 1) - 0.5) * 80   // 较大噪声让单日波动明显
    const change = trend + noise
    const open = +p.toFixed(2)
    const close = +(open + change).toFixed(2)
    const low = +(Math.min(open, close) - rng(i, 2) * 25).toFixed(2)
    const high = +(Math.max(open, close) + rng(i, 3) * 25).toFixed(2)
    vals.push([open, close, low, high])
    vols.push(Math.round(8e8 + rng(i, 4) * 6e8))
    p = close
  }
  return { categories: cats, values: vals, volumes: vols }
}

describe.skipIf(!ENABLED)('K 线视觉样张生成', () => {
  const data = buildSample(60)

  it('cn light（同花顺白底）', async () => {
    const svg = await renderToSvg(
      buildOption({
        type: 'candlestick',
        title: '沪深 300 日 K 线（示例）',
        subtitle: '通达信/同花顺风格 · MA5/10/20/60 · 60 个交易日',
        kline_style: 'cn',
        theme: 'light',
        data
      }),
      { width: 2400, height: 1200 }
    )
    fs.writeFileSync('/tmp/kline-cn-light.svg', svg)
    console.log(`cn-light: /tmp/kline-cn-light.svg (${(svg.length / 1024).toFixed(1)}kb)`)
  })

  it('cn dark（通达信黑底）', async () => {
    const svg = await renderToSvg(
      buildOption({
        type: 'candlestick',
        title: '沪深 300 日 K 线（示例）',
        subtitle: '通达信黑底专业风格 · MA5/10/20/60',
        kline_style: 'cn',
        theme: 'dark',
        data
      }),
      { width: 2400, height: 1200 }
    )
    fs.writeFileSync('/tmp/kline-cn-dark.svg', svg)
    console.log(`cn-dark:  /tmp/kline-cn-dark.svg (${(svg.length / 1024).toFixed(1)}kb)`)

    // 同时生成一份小尺寸（贴近实际聊天气泡）
    const small = await renderToSvg(
      buildOption({
        type: 'candlestick',
        title: 'K 线（小尺寸）',
        kline_style: 'cn',
        theme: 'dark',
        data: { categories: data.categories.slice(0, 30), values: data.values.slice(0, 30), volumes: data.volumes.slice(0, 30) }
      }),
      { width: 1280, height: 720 }
    )
    fs.writeFileSync('/tmp/kline-cn-dark-small.svg', small)
  })

  it('us dark（海外软件双实心）', async () => {
    const svg = await renderToSvg(
      buildOption({
        type: 'candlestick',
        title: 'AAPL Daily Candles (sample)',
        subtitle: 'US style · MA5/10/20/60 · 60 sessions',
        kline_style: 'us',
        theme: 'dark',
        data
      }),
      { width: 2400, height: 1200 }
    )
    fs.writeFileSync('/tmp/kline-us-dark.svg', svg)
    console.log(`us-dark:  /tmp/kline-us-dark.svg (${(svg.length / 1024).toFixed(1)}kb)`)
  })
})
