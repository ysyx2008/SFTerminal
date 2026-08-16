/** 可被 AbortSignal 取消的长操作共用的中止错误。 */

export function createAbortError(message = 'The operation was aborted'): Error {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError()
}
