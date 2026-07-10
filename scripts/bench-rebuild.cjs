#!/usr/bin/env node
/* eslint-env node */
/**
 * 端到端重建基准测试
 *
 * 流程：
 *   1. 重定向 userData 到临时目录
 *   2. 准备 N 个测试文档（写入 documents.json）
 *   3. CLI 调 knowledge:rebuild --force
 *   4. 输出耗时
 *
 * 用法:
 *   node scripts/bench-rebuild.cjs [count]    # count 默认 200
 */
'use strict'

const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawnSync } = require('child_process')

const N = Number(process.argv[2] || 200)

// 临时 userData 目录
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-rebuild-bench-'))
console.log(`[bench] tmp userData: ${tmpUserData}`)

// 软链已下载的 embedding 模型，避免重新下载
const realUserData = path.join(os.homedir(), 'Library', 'Application Support', 'SailFish')
const realModels = path.join(realUserData, 'models')
if (fs.existsSync(realModels)) {
  fs.symlinkSync(realModels, path.join(tmpUserData, 'models'), 'dir')
  console.log(`[bench] symlinked models: ${realModels}`)
}

// 准备测试文档
const docsDir = path.join(tmpUserData, 'knowledge')
fs.mkdirSync(docsDir, { recursive: true })

const docs = []
const now = Date.now()
for (let i = 0; i < N; i++) {
  docs.push({
    id: `bench_doc_${i}`,
    filename: `bench_${i}`,
    content:
      `测试 #${i}：用户询问了关于 Kubernetes 在生产环境的部署方案，` +
      `特别是 helm chart 的版本管理与 ConfigMap 注入实践。` +
      `回答中提到了 helm secrets / sops 加密、values.yaml 分层结构、` +
      `以及 GitOps（ArgoCD/Flux）下的同步策略。`,
    fileSize: 120,
    fileType: 'text',
    contentHash: `hash_${i}`,
    hostId: '',
    tags: [],
    createdAt: now - i * 1000,
    updatedAt: now - i * 1000,
    chunkCount: 1,
  })
}

fs.writeFileSync(
  path.join(docsDir, 'documents.json'),
  JSON.stringify({ version: 1, lastUpdated: now, documents: docs })
)
console.log(`[bench] wrote ${N} test documents`)

// 调 CLI 命令
const env = {
  ...process.env,
  SFT_DATA_DIR: tmpUserData,
  SFT_CLI_MODE: '1',
}

const cliEntry = path.join(__dirname, '..', 'electron', 'cli', 'main.js')
console.log(`[bench] running: node ${path.relative(process.cwd(), cliEntry)} knowledge:rebuild --force\n`)

const result = spawnSync('node', [cliEntry, 'knowledge:rebuild', '--force'], {
  env,
  stdio: 'inherit',
})

if (result.status !== 0) {
  console.error('\n[bench] CLI exited with code', result.status)
  process.exit(result.status || 1)
}

console.log('\n[bench] done')
