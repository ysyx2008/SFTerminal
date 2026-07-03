/**
 * 从 shell-ast 解析结果提取 AuditedCall 列表
 */
import type { CallExprNode, Redirect, ShellFile } from '@questi0nm4rk/shell-ast'
import { isDynamic, isResolved, wordToLit } from '@questi0nm4rk/shell-ast'
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
  const { findRedirects } = await getShellAstModule()
  const redirects = findRedirects(ast, { depth: 'top', ops: 'write' })
  return redirects
    .map(r => redirectNodeToAudited(r))
    .filter((r): r is AuditedRedirect => r !== null)
}

function redirectNodeToAudited(r: Redirect): AuditedRedirect | null {
  const target = wordToLit(r.word)
  if (!target) return null
  return {
    op: mapRedirectOp(r.op),
    target,
    isWrite: isWriteRedirectOp(r.op),
  }
}

function resolvedArgs(args: UnwrappedCall['args']): { strings: string[]; hasDynamic: boolean } {
  const strings: string[] = []
  let hasDynamic = false
  for (const a of args) {
    if (isDynamic(a)) hasDynamic = true
    else if (isResolved(a)) strings.push(a)
  }
  return { strings, hasDynamic }
}

function unwrappedToAuditedCall(
  u: UnwrappedCall,
  raw: string,
  source: AuditedCall['source'],
  redirects: AuditedRedirect[],
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
      args: resolvedArgs(u.args).strings,
      paths: [],
      redirects,
      wrapper: { name: u.wrapper, script: u.script },
      raw,
      source,
    }
  }

  const { strings, hasDynamic } = resolvedArgs(u.args)
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
    out.push(unwrappedToAuditedCall(u, raw, source, redirects))
    const innerAst = u.innerAst
    if (innerAst) {
      const innerCalls = findCalls(innerAst, { depth: 'top' })
      for (const inner of innerCalls) {
        await collectFromCallExpr(inner, u.script, source, out, [])
      }
    } else if (u.script.trim()) {
      const inner = await extractAuditedCalls(u.script, { shell: source })
      out.push(...inner.calls)
    }
    return
  }

  out.push(unwrappedToAuditedCall(u, raw, source, redirects))
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
    await collectFromCallExpr(call, command, source, calls, writeRedirects)
  }
  return { calls, writeRedirects }
}
