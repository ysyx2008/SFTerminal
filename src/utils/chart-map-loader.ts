/**
 * 前端加载内置 chart-maps GeoJSON（fetch public/chart-maps/）。
 * 与后端 maps.ts 使用相同的 mapId / 文件布局。
 */

import type { ChartMapId } from '@shared/chart-maps'
import { createLogger } from '@/utils/logger'

const log = createLogger('ChartMapLoader')

type GeoJsonMap = Record<string, unknown>

const cache = new Map<ChartMapId, GeoJsonMap>()
const inflight = new Map<ChartMapId, Promise<GeoJsonMap>>()

function mapIdToUrl(mapId: ChartMapId): string {
  if (mapId === 'world') return '/chart-maps/world.json'
  if (mapId === 'china') return '/chart-maps/china.json'
  if (mapId.startsWith('p') && mapId.length === 7) {
    return `/chart-maps/provinces/${mapId.slice(1)}.json`
  }
  throw new Error(`Unknown mapId: ${mapId}`)
}

async function fetchMap(mapId: ChartMapId): Promise<GeoJsonMap> {
  const cached = cache.get(mapId)
  if (cached) return cached

  let pending = inflight.get(mapId)
  if (!pending) {
    pending = (async () => {
      const url = mapIdToUrl(mapId)
      const res = await fetch(url)
      if (!res.ok) {
        throw new Error(`Failed to load map ${mapId}: HTTP ${res.status}`)
      }
      const geo = (await res.json()) as GeoJsonMap
      cache.set(mapId, geo)
      inflight.delete(mapId)
      return geo
    })()
    inflight.set(mapId, pending)
  }
  return pending
}

interface EChartsRegisterable {
  registerMap(mapName: string, geoJson: GeoJsonMap, specialAreas?: Record<string, unknown>): void
  getMap?(mapName: string): unknown
}

/** 活图渲染前注册地图（与后端 SSR 对齐） */
export async function registerChartMaps(
  echarts: EChartsRegisterable,
  mapIds: ChartMapId[]
): Promise<void> {
  const unique = [...new Set(mapIds)]
  await Promise.all(unique.map(async mapId => {
    if (echarts.getMap?.(mapId)) return
    const geoJson = await fetchMap(mapId)
    if (mapId === 'china') {
      echarts.registerMap(mapId, geoJson, {
        南海诸岛: { left: 124, top: 28, width: 10 }
      })
    } else {
      echarts.registerMap(mapId, geoJson)
    }
    log.debug(`Registered map: ${mapId}`)
  }))
}

/** 测试清理 */
export function clearChartMapCache(): void {
  cache.clear()
  inflight.clear()
}
