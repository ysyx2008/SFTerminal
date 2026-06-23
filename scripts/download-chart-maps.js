#!/usr/bin/env node
/**
 * 下载 Chart 技能内置地图 GeoJSON（构建前 / 首次 clone 后执行）。
 *
 * 数据源：
 *   - 中国省级 + 各省市级：阿里云 DataV GeoAtlas (areas_v3/bound)
 *   - 世界：Apache ECharts 官方示例 geo 资源（英文国名）
 *
 * 输出：resources/chart-maps/{world.json, china.json, provinces/*.json}
 */
const fs = require('fs')
const path = require('path')
const https = require('https')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'resources/chart-maps')
const PROV_DIR = path.join(OUT_DIR, 'provinces')

const DATAV_BASE = 'https://geo.datav.aliyun.com/areas_v3/bound'
const WORLD_URL = 'https://echarts.apache.org/examples/data/asset/geo/world.json'

const PROVINCE_ADCODES = [
  '110000', '120000', '130000', '140000', '150000',
  '210000', '220000', '230000', '310000', '320000',
  '330000', '340000', '350000', '360000', '370000',
  '410000', '420000', '430000', '440000', '450000',
  '460000', '500000', '510000', '520000', '530000',
  '540000', '610000', '620000', '630000', '640000',
  '650000', '710000', '810000', '820000'
]

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        res.resume()
        return
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (e) {
          reject(new Error(`Invalid JSON from ${url}: ${e.message}`))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(120_000, () => {
      req.destroy(new Error(`Timeout: ${url}`))
    })
  })
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data))
}

async function main() {
  console.log('Downloading chart map GeoJSON...')
  fs.mkdirSync(PROV_DIR, { recursive: true })

  console.log('  world.json ...')
  const world = await fetchJson(WORLD_URL)
  writeJson(path.join(OUT_DIR, 'world.json'), world)

  console.log('  china.json (100000_full) ...')
  const china = await fetchJson(`${DATAV_BASE}/100000_full.json`)
  writeJson(path.join(OUT_DIR, 'china.json'), china)

  let ok = 0
  let fail = 0
  for (const adcode of PROVINCE_ADCODES) {
    const dest = path.join(PROV_DIR, `${adcode}.json`)
    process.stdout.write(`  provinces/${adcode}.json ... `)
    try {
      const geo = await fetchJson(`${DATAV_BASE}/${adcode}_full.json`)
      writeJson(dest, geo)
      ok++
      console.log('ok')
    } catch (err) {
      fail++
      console.log(`FAIL (${err.message})`)
    }
  }

  const manifest = {
    version: 1,
    sources: {
      china: 'Aliyun DataV GeoAtlas areas_v3/bound/100000_full.json',
      provinces: 'Aliyun DataV GeoAtlas areas_v3/bound/{adcode}_full.json',
      world: 'Apache ECharts examples/data/asset/geo/world.json'
    },
    provinceAdcodes: PROVINCE_ADCODES,
    downloadedAt: new Date().toISOString()
  }
  writeJson(path.join(OUT_DIR, 'manifest.json'), manifest)

  console.log('')
  console.log(`Done: world + china + ${ok} provinces (${fail} failed)`)
  // 710000（台湾市级）DataV 无 _full 数据；国家级 china.json 仍含台湾省轮廓
  if (fail > 0) {
    console.warn('Some province maps failed; national china.json still includes all provinces.')
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
