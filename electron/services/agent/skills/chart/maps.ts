/**
 * Chart 技能地图 GeoJSON 加载与 echarts.registerMap（Node / Electron 主进程 SSR 用）。
 */

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import type { ChartMapId, ResolvedChartMap } from '../../../../../shared/chart-maps'
import { resolveChartMapRegion } from '../../../../../shared/chart-maps'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('ChartMaps')

/** GeoJSON 最小结构 */
export type GeoJsonMap = Record<string, unknown>

const loaded = new Map<ChartMapId, GeoJsonMap>()
let mapsDir: string | null = null

/** 解析 chart-maps 目录（dev / 打包 / CLI 一致） */
export function getChartMapsDir(): string {
  if (mapsDir) return mapsDir
  try {
    if (app.isPackaged) {
      mapsDir = path.join(process.resourcesPath, 'chart-maps')
    } else {
      mapsDir = path.join(app.getAppPath(), 'resources', 'chart-maps')
    }
  } catch {
    // CLI shim 或单元测试：相对项目根
    mapsDir = path.join(process.cwd(), 'resources', 'chart-maps')
  }
  return mapsDir
}

/** 测试 / CLI 注入自定义目录 */
export function setChartMapsDirForTest(dir: string | null): void {
  mapsDir = dir
  loaded.clear()
}

function readMapFile(relativeFile: string): GeoJsonMap {
  const abs = path.join(getChartMapsDir(), relativeFile)
  if (!fs.existsSync(abs)) {
    throw new Error(
      `Map file not found: ${relativeFile}. Run "node scripts/download-chart-maps.js" to download built-in GeoJSON.`
    )
  }
  const raw = fs.readFileSync(abs, 'utf8')
  return JSON.parse(raw) as GeoJsonMap
}

/** 按 mapId 加载 GeoJSON（带内存缓存） */
export function loadMapGeoJson(mapId: ChartMapId, relativeFile: string): GeoJsonMap {
  const cached = loaded.get(mapId)
  if (cached) return cached
  const geo = readMapFile(relativeFile)
  loaded.set(mapId, geo)
  return geo
}

/** 从 region 字符串解析并加载 */
export function loadMapForRegion(region: string): { resolved: ResolvedChartMap; geoJson: GeoJsonMap } {
  const resolved = resolveChartMapRegion(region)
  const geoJson = loadMapGeoJson(resolved.mapId, resolved.file)
  return { resolved, geoJson }
}

interface EChartsRegisterable {
  registerMap(mapName: string, geoJson: GeoJsonMap, specialAreas?: Record<string, unknown>): void
  getMap?(mapName: string): unknown
}

/**
 * 在 setOption 前注册所需地图。已注册则跳过。
 * @param mapIds 来自 resolveChartMapRegion / buildMap 的 mapId 列表
 */
export async function ensureMapsRegistered(
  echarts: EChartsRegisterable,
  mapIds: ChartMapId[]
): Promise<void> {
  const unique = [...new Set(mapIds)]
  for (const mapId of unique) {
    if (echarts.getMap?.(mapId)) continue
    const relativeFile = mapIdToFile(mapId)
    const geoJson = loadMapGeoJson(mapId, relativeFile)
    if (mapId === 'china') {
      // DataV 中国地图：南海诸岛小窗（与业界惯例一致）
      echarts.registerMap(mapId, geoJson, {
        南海诸岛: { left: 124, top: 28, width: 10 }
      })
    } else {
      echarts.registerMap(mapId, geoJson)
    }
    log.debug(`Registered map: ${mapId}`)
  }
}

function mapIdToFile(mapId: ChartMapId): string {
  if (mapId === 'world') return 'world.json'
  if (mapId === 'china') return 'china.json'
  if (mapId.startsWith('p') && mapId.length === 7) {
    return `provinces/${mapId.slice(1)}.json`
  }
  throw new Error(`Unknown mapId: ${mapId}`)
}

/** 从 ChartInput map 类型提取需注册的 mapId */
export function resolveMapIdsFromRegion(region: unknown): ChartMapId[] {
  const resolved = resolveChartMapRegion(region)
  return [resolved.mapId]
}
