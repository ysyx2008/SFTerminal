import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as path from 'path'
import { buildOption, getRequiredMapIds } from '../render'
import { renderToSvg } from '../ssr'
import { setChartMapsDirForTest } from '../maps'

const MAPS_DIR = path.join(process.cwd(), 'resources/chart-maps')
const SIZE = { width: 800, height: 600 }

describe('chart map rendering', () => {
  beforeAll(() => {
    setChartMapsDirForTest(MAPS_DIR)
  })

  afterAll(() => {
    setChartMapsDirForTest(null)
  })

  it('builds china provincial map option', () => {
    const input = {
      type: 'map' as const,
      title: '各省示例',
      data: {
        region: 'china',
        values: [
          { name: '广东', value: 100 },
          { name: '浙江', value: 80 },
          { name: '江苏', value: 60 }
        ]
      }
    }
    const mapIds = getRequiredMapIds(input)
    expect(mapIds).toEqual(['china'])
    const opt = buildOption(input, SIZE)
    expect((opt.series as Array<{ type: string; map: string }>)[0].map).toBe('china')
  })

  it('renders china map to SVG', async () => {
    const input = {
      type: 'map' as const,
      data: {
        region: 'china',
        values: [{ name: '广东省', value: 1 }, { name: '浙江省', value: 2 }]
      }
    }
    const opt = buildOption(input, SIZE)
    const mapIds = getRequiredMapIds(input)
    const svg = await renderToSvg(opt, SIZE, { mapIds })
    expect(svg).toMatch(/^<svg/)
    expect(svg.length).toBeGreaterThan(1000)
  })

  it('renders province city map', async () => {
    const input = {
      type: 'map' as const,
      data: {
        region: '安徽',
        values: [{ name: '合肥', value: 10 }, { name: '芜湖', value: 8 }]
      }
    }
    const mapIds = getRequiredMapIds(input)
    expect(mapIds).toEqual(['p340000'])
    const opt = buildOption(input, SIZE)
    const svg = await renderToSvg(opt, SIZE, { mapIds })
    expect(svg).toMatch(/^<svg/)
  })

  it('renders city district map', async () => {
    const input = {
      type: 'map' as const,
      data: {
        region: '合肥',
        values: [{ name: '瑶海区', value: 10 }, { name: '蜀山区', value: 8 }]
      }
    }
    const mapIds = getRequiredMapIds(input)
    expect(mapIds).toEqual(['c340100'])
    const opt = buildOption(input, SIZE)
    const svg = await renderToSvg(opt, SIZE, { mapIds })
    expect(svg).toMatch(/^<svg/)
  })

  it('renders world map', async () => {
    const input = {
      type: 'map' as const,
      data: {
        region: 'world',
        values: [{ name: 'China', value: 100 }, { name: 'United States', value: 90 }]
      }
    }
    const opt = buildOption(input, SIZE)
    const svg = await renderToSvg(opt, SIZE, { mapIds: ['world'] })
    expect(svg).toMatch(/^<svg/)
  })
})
