#!/usr/bin/env node
/**
 * 下载所有必需的模型文件
 * 用于 CI/CD 构建前自动下载模型
 */
const { execSync } = require('child_process')
const path = require('path')

console.log('==================================================')
console.log('Downloading all required models...')
console.log('==================================================')
console.log()

const scripts = [
  'download-embedding-model.js',
  // 语音 ASR/标点已改为按需安装包，不再随应用构建下载
]

for (const script of scripts) {
  const scriptPath = path.join(__dirname, script)
  console.log(`\nRunning: ${script}`)
  console.log('-'.repeat(50))
  try {
    execSync(`node "${scriptPath}"`, { stdio: 'inherit' })
  } catch (err) {
    console.error(`Failed to run ${script}: ${err.message}`)
    process.exit(1)
  }
}

console.log()
console.log('==================================================')
console.log('✓ All models downloaded successfully!')
console.log('==================================================')
