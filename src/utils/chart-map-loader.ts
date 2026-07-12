/**
 * 前端加载内置 chart-maps GeoJSON（fetch public/chart-maps/）。
 * 与后端 maps.ts 使用相同的 mapId / 文件布局。
 */

import type { ChartMapId } from '@shared/chart-maps'
import { extractBuiltinMapIdsFromOption } from '@shared/chart-maps'
import { createLogger } from '@/utils/logger'

const log = createLogger('ChartMapLoader')

type GeoJsonMap = Record<string, unknown>

const cache = new Map<ChartMapId, GeoJsonMap>()
const inflight = new Map<ChartMapId, Promise<GeoJsonMap>>()

/**
 * 解析 chart-maps 资源 URL。
 * 不能用 `new URL(rel, import.meta.env.BASE_URL)`——Electron 打包后 BASE_URL 常为 `./`，
 * 不是合法 absolute base，会抛 "Invalid base URL"。始终相对当前页面 URL 解析。
 */
function mapIdToUrl(mapId: ChartMapId): string {
  let rel: string
  if (mapId === 'world') rel = 'world.json'
  else if (mapId === 'china') rel = 'china.json'
  else if (mapId.startsWith('p') && mapId.length === 7) rel = `provinces/${mapId.slice(1)}.json`
  else if (mapId.startsWith('c') && mapId.length === 7) rel = `cities/${mapId.slice(1)}.json`
  else throw new Error(`Unknown mapId: ${mapId}`)

  const basePath = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/')
  const docHref = typeof window !== 'undefined' ? window.location.href : 'http://localhost/'
  return new URL(`${basePath}chart-maps/${rel}`.replace(/\/+/g, '/'), docHref).href
}

async function fetchMap(mapId: ChartMapId): Promise<GeoJsonMap> {
  const cached = cache.get(mapId)
  if (cached) return cached

  let pending = inflight.get(mapId)
  if (!pending) {
    pending = (async () => {
      try {
        const url = mapIdToUrl(mapId)
        const res = await fetch(url)
        if (!res.ok) {
          throw new Error(`Failed to load map ${mapId}: HTTP ${res.status}`)
        }
        const geo = (await res.json()) as GeoJsonMap
        cache.set(mapId, geo)
        return geo
      } finally {
        inflight.delete(mapId)
      }
    })()
    inflight.set(mapId, pending)
  }
  return pending
}

interface EChartsRegisterable {
  registerMap(mapName: string, geoJson: unknown, specialAreas?: Record<string, unknown>): void
  getMap?(mapName: string): unknown
}

/** 从 payload 推断需注册的地图（兼容历史记录无 registeredMaps 字段） */
export function resolveMapIdsForPayload(payload: {
  registeredMaps?: string[]
  option: Record<string, unknown>
}): ChartMapId[] {
  if (payload.registeredMaps?.length) {
    return payload.registeredMaps as ChartMapId[]
  }
  return extractBuiltinMapIdsFromOption(payload.option)
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
