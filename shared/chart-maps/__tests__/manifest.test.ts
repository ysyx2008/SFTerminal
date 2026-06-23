import { describe, it, expect } from 'vitest'
import {
  resolveChartMapRegion,
  matchFeatureName,
  CHINA_PROVINCES
} from '../manifest'

describe('chart-maps manifest', () => {
  it('resolves world and china', () => {
    expect(resolveChartMapRegion('world').mapId).toBe('world')
    expect(resolveChartMapRegion('中国').mapId).toBe('china')
    expect(resolveChartMapRegion('china').file).toBe('china.json')
  })

  it('resolves province by name and adcode', () => {
    expect(resolveChartMapRegion('安徽').mapId).toBe('p340000')
    expect(resolveChartMapRegion('340000').file).toBe('provinces/340000.json')
  })

  it('rejects taiwan city-level drill-down', () => {
    expect(() => resolveChartMapRegion('台湾')).toThrow(/Taiwan/)
    expect(() => resolveChartMapRegion('710000')).toThrow(/Taiwan/)
  })

  it('matchFeatureName handles province suffixes', () => {
    const features = ['广东省', '北京市', '内蒙古自治区']
    expect(matchFeatureName('广东', features)).toBe('广东省')
    expect(matchFeatureName('北京', features)).toBe('北京市')
    expect(matchFeatureName('内蒙古', features)).toBe('内蒙古自治区')
  })

  it('has 34 provincial entries', () => {
    expect(CHINA_PROVINCES.length).toBe(34)
  })
})
