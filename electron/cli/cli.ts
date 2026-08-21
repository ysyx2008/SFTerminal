/**
 * 打包态 CLI 入口（由 Electron 以 ELECTRON_RUN_AS_NODE=1 加载）
 *
 * 与开发态 `electron/cli/main.js`（Node + electron-shim + tsx）对应：
 * 这里使用真实 `electron` 模块，vite 输出为 `dist-electron/cli.js`。
 */
process.env.SFT_CLI_MODE = '1'

const rawArgv = process.argv.slice(2)
const filtered: string[] = []
for (let i = 0; i < rawArgv.length; i++) {
  const a = rawArgv[i]
  if (a === '--sandbox') {
    process.env.SFT_CLI_SANDBOX = '1'
    continue
  }
  if (a === '--share-desktop') {
    process.env.SFT_CLI_SHARE_DESKTOP = '1'
    continue
  }
  if (a === '--free') {
    filtered.push('--mode', 'free')
    continue
  }
  filtered.push(a)
}
process.argv = [process.argv[0], process.argv[1], ...filtered]

// CJS 助手；vite 会打进 cli.js
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setupCliDataDir } = require('./cli-data.js') as {
  setupCliDataDir: (opts?: { defaultSandbox?: boolean }) => {
    desktopDir: string
    sandboxDir: string
    shared: boolean
  }
}
setupCliDataDir()

import { runCli } from './index'

runCli()
  .then(() => {
    // 显式退出：AI keep-alive / 定时器等可能让事件循环空转十几秒
    process.exit(0)
  })
  .catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
