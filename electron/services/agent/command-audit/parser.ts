/**
 * shell-ast（mvdan/sh WASM）懒加载与预热
 *
 * 使用 dynamic import：包为 ESM-only，与 Electron 主进程其它 ESM 依赖一致。
 */
type ShellAstModule = typeof import('@questi0nm4rk/shell-ast')

let shellAstPromise: Promise<ShellAstModule> | null = null
let preloadPromise: Promise<void> | null = null

async function loadShellAst(): Promise<ShellAstModule> {
  shellAstPromise ??= import('@questi0nm4rk/shell-ast')
  return shellAstPromise
}

/** 预热 WASM，避免首条 shell 命令审计卡顿。幂等。 */
export async function ensureShellAstReady(): Promise<void> {
  preloadPromise ??= (async () => {
    const mod = await loadShellAst()
    await mod.preloadWasm()
  })()
  await preloadPromise
}

export async function parseShellCommand(
  src: string,
  dialect: 'bash' | 'posix' | 'mksh' = 'bash',
): Promise<Awaited<ReturnType<ShellAstModule['parse']>>> {
  await ensureShellAstReady()
  const { parse } = await loadShellAst()
  return parse(src, dialect)
}

export async function getShellAstModule(): Promise<ShellAstModule> {
  await ensureShellAstReady()
  return loadShellAst()
}
