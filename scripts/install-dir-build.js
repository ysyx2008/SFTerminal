/**
 * 将 electron-builder --dir 产物安装到本机常用位置。
 * 必须在打包/签名完成之后执行，不能放进 afterPack。
 *
 * macOS:   release/mac-arm64|mac|mac-universal/SailFish.app -> /Applications/SailFish.app
 * Windows: release/win-unpacked|win-arm64-unpacked -> %LOCALAPPDATA%/Programs/SailFish
 * Linux:   release/linux-unpacked|linux-arm64-unpacked -> ~/.local/share/SailFish (+ .desktop)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync, spawnSync } = require('child_process')

const RELEASE = path.join(__dirname, '..', 'release')
const APP_NAME = 'SailFish'

function firstExisting(candidates) {
  return candidates.find((p) => fs.existsSync(p)) || null
}

function rmrf(target) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true })
  }
}

function copyTree(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true, force: true })
}

function installMac() {
  const src = firstExisting([
    path.join(RELEASE, 'mac-arm64', `${APP_NAME}.app`),
    path.join(RELEASE, 'mac', `${APP_NAME}.app`),
    path.join(RELEASE, 'mac-universal', `${APP_NAME}.app`),
  ])
  if (!src) {
    throw new Error('未找到 release/mac*/SailFish.app')
  }

  const dest = `/Applications/${APP_NAME}.app`
  console.log(`[install-dir] macOS\n  源: ${src}\n  目标: ${dest}`)

  try {
    execSync(`pkill -x ${APP_NAME} || true`, { stdio: 'ignore' })
  } catch {
    // ignore
  }

  rmrf(dest)
  // ditto 保留资源叉 / 代码签名属性
  execSync(`ditto "${src}" "${dest}"`, { stdio: 'inherit' })
  console.log(`[install-dir] 已安装到 ${dest} ✓`)
}

function installWindows() {
  const src = firstExisting([
    path.join(RELEASE, 'win-unpacked'),
    path.join(RELEASE, 'win-arm64-unpacked'),
  ])
  if (!src) {
    throw new Error('未找到 release/win*-unpacked/')
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const dest = path.join(localAppData, 'Programs', APP_NAME)
  console.log(`[install-dir] Windows\n  源: ${src}\n  目标: ${dest}`)

  spawnSync('taskkill', ['/F', '/IM', `${APP_NAME}.exe`], { stdio: 'ignore' })

  rmrf(dest)
  copyTree(src, dest)

  const exe = path.join(dest, `${APP_NAME}.exe`)
  if (!fs.existsSync(exe)) {
    console.warn(`[install-dir] 警告: 未找到 ${exe}`)
  }
  console.log(`[install-dir] 已安装到 ${dest} ✓`)
}

function installLinux() {
  const src = firstExisting([
    path.join(RELEASE, 'linux-unpacked'),
    path.join(RELEASE, 'linux-arm64-unpacked'),
    path.join(RELEASE, 'linux-armv7l-unpacked'),
  ])
  if (!src) {
    throw new Error('未找到 release/linux*-unpacked/')
  }

  const dest = path.join(os.homedir(), '.local', 'share', APP_NAME)
  console.log(`[install-dir] Linux\n  源: ${src}\n  目标: ${dest}`)

  try {
    execSync(`pkill -x ${APP_NAME} || pkill -x sailfish || true`, { stdio: 'ignore' })
  } catch {
    // ignore
  }

  rmrf(dest)
  copyTree(src, dest)

  const exeCandidates = [
    path.join(dest, APP_NAME),
    path.join(dest, APP_NAME.toLowerCase()),
  ]
  const exe = firstExisting(exeCandidates)
  if (!exe) {
    console.warn('[install-dir] 警告: 未找到可执行文件')
  } else {
    try {
      fs.chmodSync(exe, 0o755)
    } catch {
      // ignore
    }

    const appsDir = path.join(os.homedir(), '.local', 'share', 'applications')
    fs.mkdirSync(appsDir, { recursive: true })
    const desktopPath = path.join(appsDir, 'sailfish.desktop')
    const icon = firstExisting([
      path.join(dest, 'resources', 'icon.png'),
      path.join(dest, 'icon.png'),
    ])
    const desktop = [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${APP_NAME}`,
      'Comment=SailFish AI Agent',
      `Exec="${exe}"`,
      icon ? `Icon=${icon}` : 'Icon=utilities-terminal',
      'Terminal=false',
      'Categories=Development;Utility;',
      '',
    ].join('\n')
    fs.writeFileSync(desktopPath, desktop, 'utf8')
    console.log(`[install-dir] 已写入 ${desktopPath}`)
  }

  console.log(`[install-dir] 已安装到 ${dest} ✓`)
}

function main() {
  try {
    if (process.platform === 'darwin') {
      installMac()
    } else if (process.platform === 'win32') {
      installWindows()
    } else if (process.platform === 'linux') {
      installLinux()
    } else {
      console.log(`[install-dir] 不支持的平台: ${process.platform}，跳过`)
    }
  } catch (err) {
    console.error(`[install-dir] 失败: ${err.message}`)
    process.exitCode = 1
  }
}

main()
