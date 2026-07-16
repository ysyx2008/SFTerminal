#!/usr/bin/env node
/**
 * 可选脚手架：若不存在 shared/oem.config.ts，则从 oem.config.template.ts 复制一份，
 * 方便 OEM 本地开始改配置。开源构建不依赖此文件，也不会在 postinstall 里强制执行。
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const target = path.join(root, 'shared', 'oem.config.ts')
const template = path.join(root, 'shared', 'oem.config.template.ts')

if (fs.existsSync(target)) {
  console.log('[ensure-oem-config] shared/oem.config.ts already exists, skip')
  process.exit(0)
}

if (!fs.existsSync(template)) {
  console.error('[ensure-oem-config] missing template:', template)
  process.exit(1)
}

fs.copyFileSync(template, target)
console.log('[ensure-oem-config] created shared/oem.config.ts from template (optional OEM override)')
