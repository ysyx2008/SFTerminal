/**
 * 将 electron-builder --dir 产物安装到本机常用位置。
 * 必须在打包/签名完成之后执行，不能放进 afterPack。
 *
 * macOS:   release/mac-arm64|mac|mac-universal/SailFish.app -> /Applications/SailFish.app
 * Windows: release/win-unpacked|win-arm64-unpacked -> %LOCALAPPDATA%/Programs/SailFish
 * Linux:   release/linux-unpacked|linux-arm64-unpacked -> ~/.local/share/SailFish (+ .desktop)
 *
 * 传 --launch 时安装完成后后台启动应用（不阻塞 npm）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync, spawn, spawnSync } = require('child_process')

const RELEASE = path.join(__dirname, '..', 'release')
const APP_NAME = 'SailFish'
const shouldLaunch = process.argv.includes('--launch')

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

function sleep(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // busy-wait：安装脚本短暂等待即可，避免依赖 sleep 命令 / SharedArrayBuffer
  }
}

/** 后台启动，不挂住当前 npm 进程 */
function launchDetached(command, args = [], opts = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    ...opts,
  })
  child.unref()
}

function launchMac(appPath) {
  launchDetached('open', [appPath])
}

function launchWindows(exePath) {
  launchDetached(exePath, [], { windowsHide: false })
}

function launchLinux(exePath) {
  launchDetached(exePath, [], { env: process.env })
}

function installMac() {
  const src = firstExisting([
    path.join(RELEASE, 'mac-arm64', `${APP_NAME}.app`),
    path.join(RELEASE, 'mac', `${APP_NAME}.app`),
    path.join(RELEASE, 'mac-universal', `${APP_NAME}.app`),
  ])
  if (!src) {
    throw new Error('未找到 release/mac-arm64|mac|mac-universal/SailFish.app')
  }

  const dest = `/Applications/${APP_NAME}.app`
  console.log(`[install-dir] macOS\n  源: ${src}\n  目标: ${dest}`)

  try {
    execSync(`pkill -x ${APP_NAME} || true`, { stdio: 'ignore' })
  } catch {
    // ignore
  }
  // 等进程退出后再覆盖/启动，避免签名校验失败
  sleep(500)

  rmrf(dest)
  // ditto 保留资源叉 / 代码签名属性
  execSync(`ditto "${src}" "${dest}"`, { stdio: 'inherit' })
  console.log(`[install-dir] 已安装到 ${dest} ✓`)
  return { launch: () => launchMac(dest) }
}

function installWindows() {
  const src = firstExisting([
    path.join(RELEASE, 'win-unpacked'),
    path.join(RELEASE, 'win-arm64-unpacked'),
  ])
  if (!src) {
    throw new Error('未找到 release/win-unpacked|win-arm64-unpacked/')
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const dest = path.join(localAppData, 'Programs', APP_NAME)
  console.log(`[install-dir] Windows\n  源: ${src}\n  目标: ${dest}`)

  spawnSync('taskkill', ['/F', '/IM', `${APP_NAME}.exe`], { stdio: 'ignore' })
  sleep(500)

  rmrf(dest)
  copyTree(src, dest)

  const exe = path.join(dest, `${APP_NAME}.exe`)
  if (!fs.existsSync(exe)) {
    throw new Error(`未找到可执行文件: ${exe}`)
  }
  console.log(`[install-dir] 已安装到 ${dest} ✓`)
  return { launch: () => launchWindows(exe) }
}

function installLinux() {
  const src = firstExisting([
    path.join(RELEASE, 'linux-unpacked'),
    path.join(RELEASE, 'linux-arm64-unpacked'),
    path.join(RELEASE, 'linux-armv7l-unpacked'),
  ])
  if (!src) {
    throw new Error('未找到 release/linux-unpacked|linux-arm64-unpacked/')
  }

  const dest = path.join(os.homedir(), '.local', 'share', APP_NAME)
  console.log(`[install-dir] Linux\n  源: ${src}\n  目标: ${dest}`)

  try {
    execSync(`pkill -x ${APP_NAME} || pkill -x sailfish || true`, { stdio: 'ignore' })
  } catch {
    // ignore
  }
  sleep(500)

  rmrf(dest)
  copyTree(src, dest)

  const exe = firstExisting([
    path.join(dest, APP_NAME),
    path.join(dest, APP_NAME.toLowerCase()),
  ])
  if (!exe) {
    throw new Error('未找到可执行文件')
  }

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
  console.log(`[install-dir] 已安装到 ${dest} ✓`)
  return { launch: () => launchLinux(exe) }
}

function main() {
  try {
    let result = null
    if (process.platform === 'darwin') {
      result = installMac()
    } else if (process.platform === 'win32') {
      result = installWindows()
    } else if (process.platform === 'linux') {
      result = installLinux()
    } else {
      console.log(`[install-dir] 不支持的平台: ${process.platform}，跳过`)
      return
    }

    if (shouldLaunch && result?.launch) {
      console.log('[install-dir] 正在启动...')
      result.launch()
      console.log('[install-dir] 已启动 ✓')
    }
  } catch (err) {
    console.error(`[install-dir] 失败: ${err.message}`)
    process.exitCode = 1
  }
}

main()
