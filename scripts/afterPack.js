/**
 * electron-builder afterPack 钩子
 * 用于修复 macOS 本地化应用名称问题
 * 
 * 问题：electron-builder 自动将 productName 设置为 CFBundleDisplayName，
 * 导致 macOS 忽略 InfoPlist.strings 中的本地化名称。
 * 
 * 解决：在打包后删除 Info.plist 中的 CFBundleDisplayName 字段，
 * 让 macOS 从 .lproj/InfoPlist.strings 读取本地化名称。
 */

const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

module.exports = async function(context) {
  // 只处理 macOS
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

