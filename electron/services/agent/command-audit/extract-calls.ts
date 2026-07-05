/**
 * 从 shell-ast 解析结果提取 AuditedCall 列表
 */
import type { CallExprNode, Redirect, ShellFile } from '@questi0nm4rk/shell-ast'
import type { UnwrappedCall } from '@questi0nm4rk/shell-ast'
import { parseShellCommand, getShellAstModule } from './parser'
import type { AuditedCall, AuditedRedirect, AuditContext } from './types'
import { basenameCommand } from './whitelist'

function shellDialect(ctx: AuditContext): 'bash' | 'posix' | 'mksh' {
  if (ctx.shell === 'sh') return 'posix'
  return 'bash'
}

function mapRedirectOp(op: string): AuditedRedirect['op'] {
  switch (op) {
    case '>':
    case '>>':
    case '<':
    case '2>':
    case '2>>':
    case '&>':
    case '2>&1':
      return op
    case '>|':
      return '>'
    case '&>>':
      return '>>'
    default:
      return '>'
  }
}

function isWriteRedirectOp(op: string): boolean {
  return ['>', '>>', '>|', '&>', '&>>', '<>'].includes(op)
}

async function extractWriteRedirects(ast: ShellFile): Promise<AuditedRedirect[]> {
  const { findRedirects, wordToLit } = await getShellAstModule()
  const redirects = findRedirects(ast, { depth: 'top', ops: 'write' })
  return redirects
    .map(r => redirectNodeToAudited(r, wordToLit))
    .filter((r): r is AuditedRedirect => r !== null)
}

function redirectNodeToAudited(
  r: Redirect,
  wordToLit: (word: import('@questi0nm4rk/shell-ast').Word) => string | null,
): AuditedRedirect | null {
  const target = wordToLit(r.word)
  if (!target) return null
  return {
    op: mapRedirectOp(r.op),
    target,
    isWrite: isWriteRedirectOp(r.op),
  }
}

async function resolvedArgs(args: UnwrappedCall['args']): Promise<{ strings: string[]; hasDynamic: boolean }> {
  const { isDynamic, isResolved } = await getShellAstModule()
  const strings: string[] = []
  let hasDynamic = false
  for (const a of args) {
    if (isDynamic(a)) hasDynamic = true
    else if (isResolved(a)) strings.push(a)
  }
  return { strings, hasDynamic }
}

/** 可执行 -c 内联脚本的解释器（bash -c / sudo bash -c 等） */
const SCRIPT_SHELL_CMDS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'fish',
])

function isScriptShellCmd(name: string): boolean {
  return SCRIPT_SHELL_CMDS.has(basenameCommand(name))
}

/** 从 flags 含 -c 的 wrapped 调用中提取内联脚本 */
async function scriptFromCFlag(flags: string[], args: UnwrappedCall['args']): Promise<string | null> {
  if (!flags.includes('-c')) return null
  const { strings, hasDynamic } = await resolvedArgs(args)
  if (hasDynamic || strings.length === 0) return null
  return strings[0]
}

/** sudo/env 等外层 wrapper 下的 bash -c "script" */
async function tryExtractWrappedInlineScript(
  u: Extract<UnwrappedCall, { kind: 'wrapped' }>,
  source: AuditedCall['source'],
  ctx: AuditContext,
  out: AuditedCall[],
): Promise<boolean> {
  if (!u.cmd || !isScriptShellCmd(u.cmd)) return false
  const script = await scriptFromCFlag(u.flags, u.args)
  if (!script?.trim()) return false

  const inner = await extractAuditedCalls(script, { ...ctx, shell: source })
  if (inner.calls.length === 0) return false
  out.push(...inner.calls)
  return true
}

function unwrappedToAuditedCall(
  u: UnwrappedCall,
  raw: string,
  source: AuditedCall['source'],
  redirects: AuditedRedirect[],
  resolved: { strings: string[]; hasDynamic: boolean },
): AuditedCall {
  if (u.kind === 'wrapped-opaque') {
    return {
      cmd: u.wrapper,
      flags: u.flags,
      args: [],
      paths: [],
      redirects,
      wrapper: { name: u.wrapper },
      raw,
      source,
      dynamicPaths: true,
    }
  }

  if (u.kind === 'wrapped-script') {
    return {
      cmd: u.wrapper,
      flags: u.flags,
      args: resolved.strings,
      paths: [],
      redirects,
      wrapper: { name: u.wrapper, script: u.script },
      raw,
      source,
    }
  }

  const { strings, hasDynamic } = resolved
  const cmd = basenameCommand(u.cmd)

  return {
    cmd,
    flags: u.flags,
    args: [],
    paths: strings,
    redirects,
    wrapper: u.kind === 'wrapped'
      ? { name: u.wrapper }
      : undefined,
    raw,
    source,
    dynamicPaths: hasDynamic || undefined,
  }
}

async function collectFromCallExpr(
  node: CallExprNode,
  raw: string,
  source: AuditedCall['source'],
  ctx: AuditContext,
  out: AuditedCall[],
  redirects: AuditedRedirect[],
): Promise<void> {
  const { unwrapCallParsed, findCalls } = await getShellAstModule()
  const u = await unwrapCallParsed(node)
  if (!u) {
    out.push({
      cmd: 'unknown',
      flags: [],
      args: [],
      paths: [],
      redirects,
      raw,
      source,
      dynamicPaths: true,
    })
    return
  }

  if (u.kind === 'wrapped-script') {
    let innerProcessed = false
    if (u.innerAst) {
      const innerCalls = findCalls(u.innerAst, { depth: 'top' })
      if (innerCalls.length > 0) {
        innerProcessed = true
        for (const inner of innerCalls) {
          await collectFromCallExpr(inner, u.script, source, ctx, out, [])
        }
      }
    }
    if (!innerProcessed && u.script.trim()) {
      const inner = await extractAuditedCalls(u.script, { ...ctx, shell: source })
      if (inner.calls.length > 0) {
        innerProcessed = true
        out.push(...inner.calls)
      }
    }
    if (!innerProcessed) {
      const resolved = await resolvedArgs(u.args)
      out.push(unwrappedToAuditedCall(u, raw, source, redirects, resolved))
    }
    return
  }

  if (u.kind === 'wrapped') {
    const innerProcessed = await tryExtractWrappedInlineScript(u, source, ctx, out)
    if (innerProcessed) return
  }

  const resolved = await resolvedArgs(u.args)
  out.push(unwrappedToAuditedCall(u, raw, source, redirects, resolved))
}

/** 从 shell 字符串提取全部可审计子命令（unwrap wrapper + 递归 -c 脚本） */
export async function extractAuditedCalls(
  command: string,
  ctx: AuditContext = {},
): Promise<{ calls: AuditedCall[]; writeRedirects: AuditedRedirect[] }> {
  const source = ctx.shell === 'sh' ? 'sh' : ctx.shell === 'zsh' ? 'zsh' : 'bash'
  const dialect = shellDialect(ctx)
  const ast = await parseShellCommand(command, dialect)
  const writeRedirects = await extractWriteRedirects(ast)
  const calls: AuditedCall[] = []
  const { findCalls } = await getShellAstModule()
  for (const call of findCalls(ast, { depth: 'top' })) {
    await collectFromCallExpr(call, command, source, ctx, calls, writeRedirects)
  }
  return { calls, writeRedirects }
}
