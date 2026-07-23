#!/usr/bin/env node
/**
 * 打包可选语音识别模型包（ASR + 标点 + manifest）
 * 输出: release/speech-pack-1.0.0.zip
 *
 * 上传：
 *   gh release create speech-pack-v1.0.0 ./release/speech-pack-1.0.0.zip --title "Speech pack 1.0.0" --notes "Optional ASR+punctuation models"
 *   ossutil cp ./release/speech-pack-1.0.0.zip oss://sfterm-download/optional/speech/speech-pack-1.0.0.zip
 */
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const PACK_VERSION = '1.0.0'
const ASR_NAME = 'sherpa-onnx-paraformer-zh-2024-03-09'
const PUNCT_NAME = 'sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8'

const ASR_SRC = path.join(ROOT, 'resources', 'models', 'speech', 'paraformer', ASR_NAME)
const PUNCT_SRC = path.join(ROOT, 'resources', 'models', 'speech', 'punctuation', PUNCT_NAME)
const OUT_DIR = path.join(ROOT, 'release')
const STAGING = path.join(OUT_DIR, `speech-pack-${PACK_VERSION}-staging`)
const ZIP_PATH = path.join(OUT_DIR, `speech-pack-${PACK_VERSION}.zip`)

const MANIFEST = {
  id: 'speech-asr-punct',
  format: 1,
  packVersion: PACK_VERSION,
  approxSizeBytes: 305_000_000,
  asr: {
    dir: `paraformer/${ASR_NAME}`,
    model: 'model.int8.onnx',
    tokens: 'tokens.txt',
  },
  punct: {
    dir: `punctuation/${PUNCT_NAME}`,
    model: 'model.int8.onnx',
  },
}

function mustExist(p, label) {
  if (!fs.existsSync(p)) {
    throw new Error(`Missing ${label}: ${p}\nRun: npm run download:speech-model && npm run download:punct-model (or download:models before this change)`)
  }
}

function main() {
  console.log('Building speech pack', PACK_VERSION)
  mustExist(path.join(ASR_SRC, 'model.int8.onnx'), 'ASR model')
  mustExist(path.join(ASR_SRC, 'tokens.txt'), 'ASR tokens')
  mustExist(path.join(PUNCT_SRC, 'model.int8.onnx'), 'punctuation model')

  fs.mkdirSync(OUT_DIR, { recursive: true })
  if (fs.existsSync(STAGING)) fs.rmSync(STAGING, { recursive: true, force: true })
  if (fs.existsSync(ZIP_PATH)) fs.unlinkSync(ZIP_PATH)

  const asrDest = path.join(STAGING, 'paraformer', ASR_NAME)
  const punctDest = path.join(STAGING, 'punctuation', PUNCT_NAME)
  fs.mkdirSync(asrDest, { recursive: true })
  fs.mkdirSync(punctDest, { recursive: true })
  fs.copyFileSync(path.join(ASR_SRC, 'model.int8.onnx'), path.join(asrDest, 'model.int8.onnx'))
  fs.copyFileSync(path.join(ASR_SRC, 'tokens.txt'), path.join(asrDest, 'tokens.txt'))
  fs.copyFileSync(path.join(PUNCT_SRC, 'model.int8.onnx'), path.join(punctDest, 'model.int8.onnx'))
  fs.writeFileSync(path.join(STAGING, 'manifest.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`)

  // 用系统 zip，保持相对路径
  execSync(`cd "${STAGING}" && zip -r "${ZIP_PATH}" .`, { stdio: 'inherit' })
  fs.rmSync(STAGING, { recursive: true, force: true })

  const sizeMb = (fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(1)
  console.log(`✓ Wrote ${ZIP_PATH} (${sizeMb} MB)`)
  console.log('Upload tips:')
  console.log(`  gh release create speech-pack-v${PACK_VERSION} "${ZIP_PATH}" --title "Speech pack ${PACK_VERSION}"`)
  console.log(`  ossutil cp "${ZIP_PATH}" oss://sfterm-download/optional/speech/speech-pack-${PACK_VERSION}.zip`)
}

main()
