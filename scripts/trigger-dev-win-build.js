#!/usr/bin/env node

/**
 * 远程触发 GitHub Actions 构建 Windows 开发版安装包
 *
 * 用法：npm run build:win:remote
 *
 * 流程：
 * 1. 检查当前分支
 * 2. 检查本地是否有未 push 的 commit（CI 跑的是远端 ref，未 push 会拿到旧代码）
 * 3. 用 gh CLI 触发 .github/workflows/build-dev-win.yml
 * 4. 输出查看进度命令和最终下载链接
 */

const { execSync } = require('child_process')

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
}

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`)
}

function tryExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    return null
  }
}

function main() {
  const branch = tryExec('git branch --show-current')
  if (!branch) {
    log('✗ 无法获取当前分支（detached HEAD？）', 'red')
    process.exit(1)
  }

  if (!tryExec('gh --version')) {
    log('✗ 未安装 GitHub CLI (gh): https://cli.github.com/', 'red')
    process.exit(1)
  }

  // 检查 origin/branch 是否存在 + 本地是否领先
  const remoteRef = tryExec(`git rev-parse --verify origin/${branch} 2>/dev/null`)
  if (!remoteRef) {
    log(`✗ 远端不存在 origin/${branch}，请先 git push 上传分支`, 'red')
    process.exit(1)
  }

  const ahead = parseInt(tryExec(`git rev-list --count origin/${branch}..HEAD`) || '0', 10)
  if (ahead > 0) {
    log(`✗ 本地领先 origin/${branch} ${ahead} 个 commit`, 'red')
    log(`  CI 跑的是远端 HEAD，会拿到旧代码`, 'yellow')
    log(`  请先执行: git push`, 'yellow')
    process.exit(1)
  }

  log(`→ 触发 build-dev-win.yml on ${branch}...`, 'cyan')
  try {
    execSync(`gh workflow run build-dev-win.yml --ref ${branch}`, { stdio: 'inherit' })
  } catch {
    log('✗ 触发失败', 'red')
    process.exit(1)
  }

  log('')
  log('✓ CI 已触发', 'green')
  log('  查看进度: gh run list --workflow=build-dev-win.yml --limit 3', 'cyan')
  log('  约 8-10 分钟后下载:', 'cyan')
  log('  https://sfterm-download.oss-cn-wuhan-lr.aliyuncs.com/dev/SailFish-Setup-dev.exe', 'cyan')
}

main()
