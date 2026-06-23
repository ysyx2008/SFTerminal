/**
 * Chart 技能内置地图元数据与 region 解析。
 * 纯逻辑，不含 GeoJSON 文件 I/O——前后端共用。
 */

import { CHINA_CITIES } from './cities-index'

/** 内置地图注册名（传给 echarts.registerMap / series.map） */
export type ChartMapId = 'world' | 'china' | `p${string}` | `c${string}`

export type ChartMapLevel = 'world' | 'china_provinces' | 'province_cities' | 'city_districts'

export interface ResolvedChartMap {
  /** echarts.registerMap 使用的名称 */
  mapId: ChartMapId
  /** 相对 chart-maps 目录的文件路径 */
  file: string
  level: ChartMapLevel
  /** 人类可读区域名（错误提示 / 标题兜底） */
  label: string
}

/** 省级行政区 adcode + 常见别名（AI 可能传简称） */
export const CHINA_PROVINCES: ReadonlyArray<{ adcode: string; names: readonly string[] }> = [
  { adcode: '110000', names: ['北京', '北京市'] },
  { adcode: '120000', names: ['天津', '天津市'] },
  { adcode: '130000', names: ['河北', '河北省'] },
  { adcode: '140000', names: ['山西', '山西省'] },
  { adcode: '150000', names: ['内蒙古', '内蒙古自治区', '内蒙'] },
  { adcode: '210000', names: ['辽宁', '辽宁省'] },
  { adcode: '220000', names: ['吉林', '吉林省'] },
  { adcode: '230000', names: ['黑龙江', '黑龙江省'] },
  { adcode: '310000', names: ['上海', '上海市'] },
  { adcode: '320000', names: ['江苏', '江苏省'] },
  { adcode: '330000', names: ['浙江', '浙江省'] },
  { adcode: '340000', names: ['安徽', '安徽省'] },
  { adcode: '350000', names: ['福建', '福建省'] },
  { adcode: '360000', names: ['江西', '江西省'] },
  { adcode: '370000', names: ['山东', '山东省'] },
  { adcode: '410000', names: ['河南', '河南省'] },
  { adcode: '420000', names: ['湖北', '湖北省'] },
  { adcode: '430000', names: ['湖南', '湖南省'] },
  { adcode: '440000', names: ['广东', '广东省'] },
  { adcode: '450000', names: ['广西', '广西壮族自治区', '广西省'] },
  { adcode: '460000', names: ['海南', '海南省'] },
  { adcode: '500000', names: ['重庆', '重庆市'] },
  { adcode: '510000', names: ['四川', '四川省'] },
  { adcode: '520000', names: ['贵州', '贵州省'] },
  { adcode: '530000', names: ['云南', '云南省'] },
  { adcode: '540000', names: ['西藏', '西藏自治区'] },
  { adcode: '610000', names: ['陕西', '陕西省', '陕'] },
  { adcode: '620000', names: ['甘肃', '甘肃省', '甘'] },
  { adcode: '630000', names: ['青海', '青海省'] },
  { adcode: '640000', names: ['宁夏', '宁夏回族自治区'] },
  { adcode: '650000', names: ['新疆', '新疆维吾尔自治区'] },
  { adcode: '710000', names: ['台湾', '台湾省'] },
  { adcode: '810000', names: ['香港', '香港特别行政区'] },
  { adcode: '820000', names: ['澳门', '澳门特别行政区'] }
]

const WORLD_ALIASES = new Set(['world', '全球', '世界', 'world map', 'global'])

const CHINA_ALIASES = new Set(['china', '中国', '全国', 'china map'])

function normalizeToken(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '')
}

/**
 * 把 AI / 用户传入的 region 解析为内置地图文件。
 * @throws 无法识别或 adcode 不在内置列表时抛错（由 chart render 捕获返回给 AI）
 */
export function resolveChartMapRegion(region: unknown): ResolvedChartMap {
  if (typeof region !== 'string' || !region.trim()) {
    throw new Error('map data.region must be a non-empty string (e.g. "china", "world", "安徽", "340000")')
  }
  const raw = region.trim()
  const token = normalizeToken(raw)

  if (WORLD_ALIASES.has(token) || token === 'world') {
    return { mapId: 'world', file: 'world.json', level: 'world', label: '世界' }
  }
  if (CHINA_ALIASES.has(token) || token === 'china') {
    return { mapId: 'china', file: 'china.json', level: 'china_provinces', label: '中国' }
  }

  if (/^\d{6}$/.test(raw)) {
    const prov = CHINA_PROVINCES.find(p => p.adcode === raw)
    if (prov) {
      if (raw === '710000') {
        throw new Error(
          'City-level map for Taiwan (710000) is not available in built-in data; use region "china" for provincial view'
        )
      }
      return {
        mapId: `p${raw}` as ChartMapId,
        file: `provinces/${raw}.json`,
        level: 'province_cities',
        label: prov.names[1] ?? prov.names[0]
      }
    }

    const city = resolveCityByAdcode(raw)
    if (city) return city

    throw new Error(
      `Unsupported adcode "${raw}"; use province adcode (e.g. "340000"), city adcode (e.g. "340100"), or a region name`
    )
  }

  const matched = CHINA_PROVINCES.find(p =>
    p.names.some(n => n === raw || normalizeToken(n) === token)
  )
  if (matched) {
    if (matched.adcode === '710000') {
      throw new Error(
        'City-level map for Taiwan is not available in built-in data; use region "china" for provincial view'
      )
    }
    return {
      mapId: `p${matched.adcode}` as ChartMapId,
      file: `provinces/${matched.adcode}.json`,
      level: 'province_cities',
      label: matched.names[1] ?? matched.names[0]
    }
  }

  const matchedCity = CHINA_CITIES.find(c =>
    c.names.some(n => n === raw || normalizeToken(n) === token)
  )
  if (matchedCity) {
    return resolveCityByAdcode(matchedCity.adcode)!
  }

  throw new Error(
    `Unknown map region "${raw}". Use "world", "china", province/city name (e.g. "安徽", "合肥"), or adcode (e.g. "340000", "340100")`
  )
}

function resolveCityByAdcode(adcode: string): ResolvedChartMap | undefined {
  const city = CHINA_CITIES.find(c => c.adcode === adcode)
  if (!city) return undefined
  const label = city.names[city.names.length - 1] ?? city.names[0]
  return {
    mapId: `c${adcode}` as ChartMapId,
    file: `cities/${adcode}.json`,
    level: 'city_districts',
    label
  }
}

/** GeoJSON Feature 常见属性字段 */
export function featureLabel(props: Record<string, unknown> | undefined): string | undefined {
  if (!props) return undefined
  for (const key of ['name', 'NAME', 'Name']) {
    const v = props[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

/**
 * 把用户 data.values[].name 对齐到 GeoJSON feature 名称。
 * DataV 省级用「广东省」、市级用「合肥市」；AI 常传简称「广东」「合肥」。
 */
export function matchFeatureName(inputName: string, featureNames: string[]): string | undefined {
  const trimmed = inputName.trim()
  if (!trimmed) return undefined
  if (featureNames.includes(trimmed)) return trimmed

  const lower = trimmed.toLowerCase()
  const byLower = featureNames.find(f => f.toLowerCase() === lower)
  if (byLower) return byLower

  // 简称 → 全称：依次尝试常见行政后缀
  const suffixes = [
    '特别行政区',
    '维吾尔自治区',
    '壮族自治区',
    '回族自治区',
    '自治区',
    '自治州',
    '地区',
    '盟',
    '省',
    '市',
    '区',
    '县'
  ]
  for (const suf of suffixes) {
    const candidate = trimmed + suf
    if (featureNames.includes(candidate)) return candidate
  }

  // 全称 → 简称：用户传「广东省」但 feature 只有「广东」（少见，兜底）
  for (const fn of featureNames) {
    if (fn.startsWith(trimmed) || trimmed.startsWith(fn.replace(/(特别行政区|自治区|省|市)$/, ''))) {
      return fn
    }
  }

  return undefined
}

/** 从 GeoJSON 提取全部 feature 名称 */
export function extractFeatureNames(geoJson: { features?: Array<{ properties?: Record<string, unknown> }> }): string[] {
  const names: string[] = []
  for (const f of geoJson.features ?? []) {
    const n = featureLabel(f.properties)
    if (n) names.push(n)
  }
  return names
}
