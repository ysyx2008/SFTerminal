#!/usr/bin/env node
/**
 * 下载 Microsoft Visual C++ 2015-2022 Redistributable (x64)
 * ONNX Runtime 依赖 vcruntime140_1.dll 等，Windows 上必须安装
 * 打包时由 NSIS 安装脚本在应用安装阶段静默安装
 */

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')

const OUTPUT_PATH = path.join(__dirname, '..', 'resources', 'vc_redist.x64.exe')
const DOWNLOAD_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'

if (fs.existsSync(OUTPUT_PATH)) {
  const stat = fs.statSync(OUTPUT_PATH)
  if (stat.size > 1_000_000) {
    console.log(`[download-vcredist] Already exists (${(stat.size / 1024 / 1024).toFixed(1)} MB), skipping.`)
    process.exit(0)
  }
  fs.unlinkSync(OUTPUT_PATH)
}

function download(url, dest, maxRedirects = 5) {
  if (maxRedirects <= 0) {
    console.error('[download-vcredist] Too many redirects')
    process.exit(1)
  }

  const client = url.startsWith('https') ? https : http

  console.log(`[download-vcredist] Downloading from ${url}`)

  client.get(url, { headers: { 'User-Agent': 'SailFish-Build' } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      console.log(`[download-vcredist] Redirect -> ${res.headers.location}`)
      res.resume()
      download(res.headers.location, dest, maxRedirects - 1)
      return
    }

    if (res.statusCode !== 200) {
      console.error(`[download-vcredist] HTTP ${res.statusCode}`)
      process.exit(1)
    }

    const totalBytes = parseInt(res.headers['content-length'] || '0', 10)
    let downloaded = 0

    const file = fs.createWriteStream(dest)
    res.on('data', (chunk) => {
      downloaded += chunk.length
      if (totalBytes > 0) {
        const pct = ((downloaded / totalBytes) * 100).toFixed(1)
        process.stdout.write(`\r[download-vcredist] ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`)
      }
    })

    res.pipe(file)

    file.on('finish', () => {
      file.close()
      console.log(`\n[download-vcredist] Saved to ${dest} (${(downloaded / 1024 / 1024).toFixed(1)} MB)`)
    })
  }).on('error', (err) => {
    console.error('[download-vcredist] Download failed:', err.message)
    if (fs.existsSync(dest)) fs.unlinkSync(dest)
    process.exit(1)
  })
}

download(DOWNLOAD_URL, OUTPUT_PATH)
