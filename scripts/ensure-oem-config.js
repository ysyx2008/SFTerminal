#!/usr/bin/env node
/**
 * 若 shared/oem.config.ts 不存在，则从 oem.config.template.ts 复制。
 * 避免开源主线提交可改 OEM 文件导致 Fork 合上游冲突。
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
