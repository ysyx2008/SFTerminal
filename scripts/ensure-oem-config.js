#!/usr/bin/env node
/**
 * 若 shared/oem.config.ts 不存在，则从 oem.config.template.ts 复制。
 * 该文件不进开源主线 Git（见 .gitignore）；由 postinstall / ensure:oem-config /
 * vite 启动 / build* / verify 自动生成，避免 clone 后直接构建缺文件。
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const target = path.join(root, 'shared', 'oem.config.ts')
const template = path.join(root, 'shared', 'oem.config.template.ts')

if (fs.existsSync(target)) {
  process.exit(0)
}

if (!fs.existsSync(template)) {
  console.error('[ensure-oem-config] missing template:', template)
  process.exit(1)
}

fs.copyFileSync(template, target)
console.log('[ensure-oem-config] created shared/oem.config.ts from template')
