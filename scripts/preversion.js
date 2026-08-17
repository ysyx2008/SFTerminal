#!/usr/bin/env node

/**
 * npm version 的 preversion 钩子
 * 
 * 职责：仅做发版前 git 安全检查，不切换分支。
 * 完整的代码验证（typecheck/lint/build/test）由 `npm run verify` 在发版流程前期执行，
 * 此处不再重复运行，避免浪费时间。
 * 
 * 流程:
 * 1. 检查是否在 develop / main / hotfix/* 分支
 * 2. 热修支必须从已发布的 vX.Y.Z tag 拉出（防止把 develop 上的新功能打进热修包）
 * 3. 确保工作区干净
 * 4. 拉取最新代码（无上游则跳过 pull）
 * 5. 保存当前分支状态供 postversion 使用
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const STATE_FILE = path.join(__dirname, '.release-state.json');

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function success(message) {
  log(`✓ ${message}`, 'green');
}

function error(message) {
  log(`✗ ${message}`, 'red');
}

function execSilent(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch (e) {
    return null;
  }
}

function exec(command) {
  log(`  $ ${command}`, 'blue');
  execSync(command, { stdio: 'inherit' });
}

function getCurrentBranch() {
  return execSilent('git rev-parse --abbrev-ref HEAD');
}

function isHotfixBranch(branch) {
  return typeof branch === 'string' && branch.startsWith('hotfix/');
}

function isAllowedReleaseBranch(branch) {
  return branch === 'develop' || branch === 'main' || isHotfixBranch(branch);
}

function hasUpstream() {
  return Boolean(execSilent('git rev-parse --abbrev-ref @{upstream}'));
}

function resolveRef(name) {
  return execSilent(`git rev-parse --verify ${name}`) ? name : null;
}

function isAncestor(maybeAncestor, rev) {
  try {
    execSync(`git merge-base --is-ancestor ${maybeAncestor} ${rev}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function pickNewerRef(localName, remoteName) {
  const local = resolveRef(localName);
  const remote = resolveRef(remoteName);
  if (local && remote) {
    if (isAncestor(remote, local)) return local;
    if (isAncestor(local, remote)) return remote;
    return local;
  }
  return local || remote;
}

function versionTagsAt(commit) {
  return (execSilent(`git tag --points-at ${commit}`) || '')
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
}

function assertHotfixStartsFromReleaseTag() {
  const developRef = pickNewerRef('develop', 'origin/develop');
  if (!developRef) {
    error('找不到 develop，无法校验热修起点。请先 git fetch origin develop');
    process.exit(1);
  }

  const base = execSilent(`git merge-base HEAD ${developRef}`);
  if (!base) {
    error('无法计算与 develop 的分叉点。热修必须从已发布的 tag 拉出，例如:');
    log('  git checkout -b hotfix/11.6.1 v11.6.0', 'yellow');
    process.exit(1);
  }

  const versionTags = versionTagsAt(base);
  if (versionTags.length === 0) {
    error('热修必须从已发布的版本 tag 拉出，不能从 develop 或已经超前的 main 拉。');
    log(`  当前与 develop 的分叉点 ${base.slice(0, 8)} 上没有 vX.Y.Z tag。`, 'yellow');
    log('  正确做法: git fetch --tags && git checkout -b hotfix/11.6.1 v11.6.0', 'yellow');
    process.exit(1);
  }
  success(`热修起点是已发布版本（${versionTags.join(', ')}）`);
}

function hasUncommittedChanges() {
  const status = execSilent('git status --porcelain');
  return status && status.length > 0;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function cleanupState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  } catch (e) {
    // ignore
  }
}

async function confirm(question) {
  if (process.env.npm_config_yes === 'true' || process.env.npm_config_y === 'true') {
    return true;
  }
  if (process.env.CI) {
    return true;
  }

  // 非交互式 stdin（AI 工具调用、管道、后台进程）下 readline.question 会挂死。
  // 此处快速失败，明确告诉调用方该怎么解，不要等用户去猜。
  if (!process.stdin.isTTY) {
    error('检测到非交互式 stdin（无 TTY），无法读取确认。');
    log('  常见场景：AI 工具调用 / 管道 / 后台脚本 / 部分 CI runner。', 'yellow');
    log('  请改用：  npm_config_yes=true npm version <patch|minor|major>', 'yellow');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${colors.yellow}${question} (y/N): ${colors.reset}`, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function main() {
  log('\n========================================', 'cyan');
  log('     [preversion] 发布准备', 'cyan');
  log('========================================\n', 'cyan');

  const currentBranch = getCurrentBranch();
  const currentVersion = require('../package.json').version;
  
  log(`当前分支: ${currentBranch}`);
  log(`当前版本: ${currentVersion}`);

  if (!isAllowedReleaseBranch(currentBranch)) {
    error(`必须在 develop、main 或 hotfix/* 分支执行 npm version (当前: ${currentBranch})`);
    process.exit(1);
  }

  if (hasUncommittedChanges()) {
    error('工作区有未提交的更改，请先提交或暂存');
    process.exit(1);
  }
  success('工作区干净');

  log('\n即将执行以下操作:', 'cyan');
  log('  1. 拉取最新代码');
  log('  2. 更新版本号并创建 tag');
  if (currentBranch === 'develop') {
    log('  3. 合并 develop 到 main');
    log('  4. 推送 main 和 tag');
    log('  5. 推送 develop');
  } else if (isHotfixBranch(currentBranch)) {
    log('  3. 推送热修分支和 tag');
    log('  4. 将热修合回 develop（修复和版本号一起带走）');
    log('  5. 若 main 仍停在旧版点则快进，否则跳过');
  } else {
    log('  3. 推送 main 和 tag');
  }

  const shouldContinue = await confirm('\n确认继续?');
  if (!shouldContinue) {
    log('已取消', 'yellow');
    process.exit(1);
  }

  cleanupState();

  try {
    log('\n拉取最新代码...', 'cyan');
    exec('git fetch origin --tags');
    if (hasUpstream()) {
      exec('git pull --ff-only');
    } else {
      log('当前分支无上游，跳过 pull（新建热修支常见）', 'yellow');
    }
    success('代码已更新');

    if (isHotfixBranch(currentBranch)) {
      assertHotfixStartsFromReleaseTag();
    }

    saveState({ originalBranch: currentBranch });

    log('\n✓ preversion 完成，继续执行版本更新...\n', 'green');

  } catch (e) {
    error('preversion 执行失败!');
    process.exit(1);
  }
}

main();
