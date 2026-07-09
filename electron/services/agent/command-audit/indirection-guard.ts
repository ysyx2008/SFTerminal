/**
 * 间接执行守卫（indirection guard）
 *
 * 设计定位：命令拦截是"安全性补充"，主防线是 executionMode（strict/relaxed/free）。
 * - 真正高风险场景 → 用户切 strict（全确认）
 * - 日常使用 → relaxed（危险命令确认）
 * - 信任 AI 自主 → free（自担风险）
 *
 * 本守卫把"确实危险的间接执行模式"鉴别出来标记为 dangerous，让 strict/relaxed 弹确认时
 * 理由清楚。free 模式照常放行——用户既然选了信任，不该由 guard 越俎代庖硬拦。
 *
 * 通道无关：assessAuditedCall 调用，shell 通道 AST 解析后归一化为 AuditedCall。
 *
 * 两层检测（AND 关系）：
 *   1. 角色分类：解释器内联 / 包装器 / 调度器 → dangerous
 *   2. 结构性 flag 规则（cmd 感知）：find -exec / -delete，解释器 + -e/-c 等 → dangerous
 *
 * blocked 级别留给路径守卫（写 /etc、/、/System 等系统路径），那是真正的硬墙。
 *
 * 反例驱动设计：
 *   - node -e "代码" —— 第 1 层 Interpreter-inline 命中 → dangerous
 *   - sudo env bash -c "..." —— wrapper 链命中（shell 通道已 unwrap，wrapper.name 暴露）→ dangerous
 *   - find . -exec rm -rf {} \; —— 第 2 层结构性 flag 命中 → dangerous
 *   - git -c core.x=y status —— 不命中（git -c 是配置项，合法）
 *   - busybox sh -c "..." —— busybox 不在白名单 → moderate + hasUnknown（relaxed 弹确认）
 */
import type { AuditedCall, CallRiskAssessment } from './types'
import { basenameCommand } from './whitelist'

/** 解释器 + 内联执行 flag：内联代码不可静态审计 */
const INTERPRETER_INLINE_FLAGS: Record<string, ReadonlySet<string>> = {
  // shell 解释器
  bash: new Set(['-c']),
  sh: new Set(['-c']),
  zsh: new Set(['-c']),
  dash: new Set(['-c']),
  ksh: new Set(['-c']),
  mksh: new Set(['-c']),
  fish: new Set(['-c']),
  // 脚本解释器
  node: new Set(['-e', '--eval']),
  python: new Set(['-c']),
  python3: new Set(['-c']),
  perl: new Set(['-e', '-E']),
  ruby: new Set(['-e']),
  php: new Set(['-r']),
  lua: new Set(['-e']),
  osascript: new Set(['-e']),
  // Windows
  powershell: new Set(['-Command', '-c', '--command']),
  pwsh: new Set(['-Command', '-c', '--command']),
}

/** 包装器 cmd：本身不干活，转手执行别的命令 */
const WRAPPER_CMDS = new Set([
  'sudo', 'env', 'xargs', 'nice', 'nohup', 'time', 'command',
  'builtin', 'exec', 'stdbuf', 'ionice', 'flock', 'chroot',
])

/** 调度器 cmd：调度外部执行，不可静态审计 */
const ORCHESTRATOR_CMDS = new Set([
  'docker', 'kubectl', 'ssh', 'make', 'nix-shell', 'bubblewrap',
  'podman', 'buildah', 'toolbox', 'npx',
])

/**
 * 带条件性执行语义的 flag 规则（cmd 感知，避免误伤合法用途）
 */
const STRUCTURAL_FLAG_RULES: Record<string, (call: AuditedCall) => string | null> = {
  // find 的 -exec / -delete / -ok 在运行时执行任意命令或批量删除
  find: (call) => {
    for (const f of call.flags) {
      if (f === '-exec' || f === '-execdir' || f === '-ok' || f === '-okdir') {
        const name = f === '-exec' ? 'exec' : f === '-execdir' ? 'execdir' : f === '-ok' ? 'ok' : 'okdir'
        return `find -${name} 会执行任意命令，存在不可静态审计的执行语义`
      }
      if (f === '-delete') {
        return 'find -delete 会批量删除，存在不可静态审计的执行语义'
      }
    }
    return null
  },
  // tar --to-command=CMD 在解压时执行任意命令
  tar: (call) => {
    for (const f of call.flags) {
      if (f === '--to-command') return 'tar --to-command 会执行任意命令，存在不可静态审计的执行语义'
    }
    return null
  },
  // git rebase --exec=CMD 会执行任意命令（git -c 是配置项，合法）
  git: (call) => {
    for (const f of call.flags) {
      if (f === '--exec') return 'git rebase --exec 会执行任意命令，存在不可静态审计的执行语义'
    }
    return null
  },
}

/** 判断 cmd 是否为已知解释器（用于角色分类层） */
function isInterpreterInline(call: AuditedCall): string | null {
  const flagSet = INTERPRETER_INLINE_FLAGS[call.cmd]
  if (!flagSet || flagSet.size === 0) return null
  for (const f of call.flags) {
    if (flagSet.has(f)) {
      return `${call.cmd} ${f} 会执行内联代码，无法静态审计`
    }
  }
  return null
}

/** 判断是否经过包装器/调度器（shell 通道已 unwrap，wrapper.name 会暴露） */
function isWrappedOrOrchestrated(call: AuditedCall): string | null {
  const wrapperName = call.wrapper?.name
  if (wrapperName) {
    if (WRAPPER_CMDS.has(wrapperName)) {
      return `${wrapperName} 是包装器，会转手执行别的命令`
    }
    if (ORCHESTRATOR_CMDS.has(wrapperName)) {
      return `${wrapperName} 是调度器，会调度外部执行`
    }
  }
  // cmd 本身是 wrapper / orchestrator 的情况
  if (WRAPPER_CMDS.has(call.cmd)) {
    return `${call.cmd} 是包装器，会转手执行别的命令`
  }
  if (ORCHESTRATOR_CMDS.has(call.cmd)) {
    return `${call.cmd} 是调度器，会调度外部执行`
  }
  return null
}

/**
 * 检查是否命中间接执行守卫
 *
 * 命中返回 reason 字符串；不命中返回 null，由调用方继续走原审计流程。
 */
export function checkIndirectionGuard(call: AuditedCall): string | null {
  // basename 化 cmd（/bin/zsh → zsh, C:\...\node.exe → node）
  // assessAuditedCall 里 getArgvCommandRule 才做 basename。
  // guard 在 rule 查找之前跑，所以这里自己 normalize 一次。
  const baseCmd = basenameCommand(call.cmd).toLowerCase()
  const normalizedCall = { ...call, cmd: baseCmd }

  // 第 1 层：角色分类（解释器内联 / 包装器 / 调度器）
  const inlineReason = isInterpreterInline(normalizedCall)
  if (inlineReason) return inlineReason

  const wrapperReason = isWrappedOrOrchestrated(normalizedCall)
  if (wrapperReason) return wrapperReason

  // 第 2 层：结构性 flag 规则（cmd 感知）
  const flagRule = STRUCTURAL_FLAG_RULES[baseCmd]
  if (flagRule) {
    const flagReason = flagRule(normalizedCall)
    if (flagReason) return flagReason
  }

  return null
}

/**
 * 构造命中守卫时的 dangerous 评估结果。
 *
 * dangerous 在 strict/relaxed 模式下弹确认（理由清楚），free 模式放行
 * （用户选 free 即自担风险，guard 不越俎代庖硬拦）。
 * blocked 级别留给路径守卫（写系统路径等绝对禁止场景）。
 */
export function dangerousByGuard(reason: string): CallRiskAssessment {
  return {
    level: 'dangerous',
    commandLevel: 'dangerous',
    reasons: [reason],
  }
}
