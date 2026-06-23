import type { ChartMapId } from './manifest'

const BUILTIN_MAP_ID = /^(world|china|p\d{6}|c\d{6})$/

function collectMapId(ids: Set<ChartMapId>, mapName: unknown): void {
  if (typeof mapName !== 'string' || !BUILTIN_MAP_ID.test(mapName)) return
  ids.add(mapName as ChartMapId)
}

/** 从 ECharts option 提取内置地图 id（world / china / p{adcode} / c{adcode}） */
export function extractBuiltinMapIdsFromOption(option: unknown): ChartMapId[] {
  if (!option || typeof option !== 'object') return []
  const ids = new Set<ChartMapId>()
  const opt = option as Record<string, unknown>

  const series = opt.series
  if (Array.isArray(series)) {
    for (const s of series) {
      if (!s || typeof s !== 'object') continue
      const item = s as Record<string, unknown>
      if (item.type === 'map') collectMapId(ids, item.map)
    }
  }

  const geo = opt.geo
  if (Array.isArray(geo)) {
    for (const g of geo) {
      if (g && typeof g === 'object') collectMapId(ids, (g as Record<string, unknown>).map)
    }
  } else if (geo && typeof geo === 'object') {
    collectMapId(ids, (geo as Record<string, unknown>).map)
  }

  return [...ids]
}

/** option 是否含 map series（预览缩放应走外层 CSS，不用 echarts roam） */
export function optionHasMapSeries(option: unknown): boolean {
  if (!option || typeof option !== 'object') return false
  const series = (option as Record<string, unknown>).series
  if (!Array.isArray(series)) return false
  return series.some(s => s && typeof s === 'object' && (s as Record<string, unknown>).type === 'map')
}
