#!/usr/bin/env node
/**
 * 下载知识库 lite 嵌入模型（onnx-community/bge-small-zh-v1.5-ONNX）
 * 供 Transformers.js v4 + CoreML/CUDA 加速使用。
 */
const https = require('https')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')

const MODEL_ID = 'onnx-community/bge-small-zh-v1.5-ONNX'
const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`
const DEST_DIR = path.join(__dirname, '..', 'resources', 'models', 'embedding', 'bge-small-zh-v1.5')

const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
  'onnx/model_quantized.onnx_data',
]

function download(url, destPath, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'))
      return
    }

    const urlObj = new URL(url)
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'SailFish-download-embedding-model/1.0',
        Accept: '*/*',
      },
      timeout: 600000,
    }

    const req = https.request(options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        let redirectUrl = res.headers.location
        if (!redirectUrl) {
          reject(new Error(`Redirect without location: HTTP ${res.statusCode}`))
          return
        }
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, url).href
        }
        download(redirectUrl, destPath, maxRedirects - 1).then(resolve).catch(reject)
        return
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage} (${url})`))
        return
      }

      const totalSize = parseInt(res.headers['content-length'], 10) || 0
      let downloadedSize = 0
      let lastProgress = -1

      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      const file = fs.createWriteStream(destPath)
      res.pipe(file)

      res.on('data', (chunk) => {
        downloadedSize += chunk.length
        if (totalSize > 0) {
          const pct = Math.floor((downloadedSize / totalSize) * 100)
          if (pct >= lastProgress + 10) {
            lastProgress = pct
            process.stdout.write(`\r  ${pct}% (${(downloadedSize / 1024 / 1024).toFixed(1)} MB)`)
          }
        }
      })

      file.on('finish', () => {
        file.close(() => {
          if (totalSize > 0) process.stdout.write('\n')
          resolve(destPath)
        })
      })

      file.on('error', (err) => {
        fs.unlink(destPath, () => reject(err))
      })
    })

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`Timeout: ${url}`))
    })
    req.end()
  })
}

async function main() {
  console.log(`Downloading ${MODEL_ID}`)
  console.log(`Destination: ${DEST_DIR}`)
  console.log()

  // 检查所有文件是否已存在，全部存在则跳过下载
  const allExist = FILES.every((rel) => fs.existsSync(path.join(DEST_DIR, rel)))
  if (allExist) {
    console.log('Embedding model already exists, skipping download')
    console.log(`Model path: ${DEST_DIR}`)
    return
  }

  fs.mkdirSync(DEST_DIR, { recursive: true })

  for (const rel of FILES) {
    const url = `${HF_BASE}/${rel}`
    const dest = path.join(DEST_DIR, rel)
    if (fs.existsSync(dest)) {
      const stat = fs.statSync(dest)
      console.log(`→ ${rel} (already exists, ${(stat.size / 1024 / 1024).toFixed(2)} MB, skipping)`)
      continue
    }
    console.log(`→ ${rel}`)
    await download(url, dest)
    const stat = fs.statSync(dest)
    console.log(`  ✓ ${(stat.size / 1024 / 1024).toFixed(2)} MB`)
  }

  console.log()
  console.log('✓ Embedding lite model ready')
}

main().catch((err) => {
  console.error('Download failed:', err.message)
  process.exit(1)
})
