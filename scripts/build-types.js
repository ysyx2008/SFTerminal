/**
 * 在 vue-tsc 之前生成 tsconfig.node.json 的声明文件（dist-electron-types/）。
 * tsconfig.node.json 设了 noEmitOnError:false，有预存类型错误时也能正常出文件。
 * 本脚本固定 exit 0，不让 tsc 的预存错误阻断 build 链路。
 */
const { spawnSync } = require('child_process');

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsc', '-b', 'tsconfig.node.json'],
  { stdio: 'inherit', shell: false }
);

if (result.error) {
  console.error('[build-types] 无法启动 tsc:', result.error.message);
}

// 始终以 0 退出——文件已写出（noEmitOnError:false），预存错误由 typecheck:electron 单独治理
process.exit(0);
