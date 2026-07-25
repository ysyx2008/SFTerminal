/**
 * electron-builder afterPack 钩子
 *
 * 1. 校验 app.asar.unpacked 内 knowledge/speech/pdf worker 传递依赖可解析
 *    （缺包则硬失败，避免再发「知识库静默不可用」的假丝滑版）
 * 2. macOS：删除 CFBundleDisplayName，让本地化 InfoPlist.strings 生效
 */

const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { checkAsarUnpackDeps } = require('./check-asar-unpack-deps')

function resolveUnpackedNodeModules(context) {
  const appOutDir = context.appOutDir
  const appName = context.packager.appInfo.productFilename
  if (context.electronPlatformName === 'darwin') {
    return path.join(
      appOutDir,
      `${appName}.app`,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
    )
  }
  // win32 / linux：resources 与可执行文件同级
  return path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules')
}

module.exports = async function(context) {
  // ── utilityProcess worker 传递依赖：打包后硬失败 ──
  const unpackedNm = resolveUnpackedNodeModules(context)
  if (unpackedNm && fs.existsSync(unpackedNm)) {
    console.log('[afterPack] 检查 asarUnpack worker 传递依赖:', unpackedNm)
    const result = checkAsarUnpackDeps({ mode: 'unpacked', nmRoot: unpackedNm })
    if (!result.ok) {
      const lines = result.gaps.map((g) => `  - ${g.from} → ${g.dep}: ${g.detail}`)
      throw new Error(
        `[afterPack] asarUnpack 缺口（utilityProcess 将 Cannot find module）:\n${lines.join('\n')}\n` +
          `请在 electron-builder.yml asarUnpack 中补齐后重新打包。`,
      )
    }
    console.log(`[afterPack] asarUnpack worker 依赖检查通过（${result.packageCount} packages）`)
  } else {
    console.warn('[afterPack] 未找到 app.asar.unpacked/node_modules，跳过依赖检查')
  }

  // 只处理 macOS 本地化
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  const appPath = context.appOutDir
  const appName = context.packager.appInfo.productFilename
  const infoPlistPath = path.join(appPath, `${appName}.app`, 'Contents', 'Info.plist')

  console.log('[afterPack] 修复 macOS 本地化应用名称...')
  console.log('[afterPack] Info.plist 路径:', infoPlistPath)

  if (!fs.existsSync(infoPlistPath)) {
    console.warn('[afterPack] Info.plist 不存在，跳过')
    return
  }

  try {
    // 删除 CFBundleDisplayName 字段，让系统使用本地化字符串
    execSync(`/usr/libexec/PlistBuddy -c "Delete :CFBundleDisplayName" "${infoPlistPath}"`, {
      stdio: 'pipe'
    })
    console.log('[afterPack] 已删除 CFBundleDisplayName，本地化名称将生效')
  } catch (error) {
    // 如果字段不存在，PlistBuddy 会报错，忽略即可
    if (!error.message?.includes('Does Not Exist')) {
      console.warn('[afterPack] 警告:', error.message)
    }
  }

  // 验证修改结果
  try {
    const result = execSync(`/usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName" "${infoPlistPath}" 2>&1`, {
      encoding: 'utf8',
      stdio: 'pipe'
    })
    console.log('[afterPack] CFBundleDisplayName 仍存在:', result.trim())
  } catch {
    console.log('[afterPack] 确认：CFBundleDisplayName 已删除 ✓')
  }

  // 确认打包态 CLI 入口存在（vite 第三入口 → dist-electron/cli.js）
  const cliJs = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources', 'app.asar')
  // asar 内文件此处不解开校验；构建日志提示用户
  console.log('[afterPack] CLI: 用户可在「设置 → 数据管理」安装 sailfish 命令（~/.local/bin）')
  console.log('[afterPack] CLI 入口预期: app.asar/dist-electron/cli.js（需 vite 已产出）')
  void cliJs
}

