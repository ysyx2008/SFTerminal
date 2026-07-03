/**
 * 判断命令是否属于 Windows 原生 shell（PowerShell / CMD）语法。
 * 这类命令不走 bash AST，回退 regex 审计（Phase 2 范围外）。
 */
const WIN_NATIVE_PATTERN =
  /\b(remove-item|get-content|stop-process|start-process|new-item|copy-item|move-item|clear-content|install-module|stop-computer|restart-computer|stop-service|restart-service|remove-service|rename-item|install-package|rd|rmdir|del|erase|format|xcopy|robocopy|taskkill|icacls|takeown|choco|winget|net\s+(stop|start)|sc\s+(stop|delete|start|config)|reg\s+(delete|add))\b/i

export function isWindowsNativeShellCommand(command: string): boolean {
  return WIN_NATIVE_PATTERN.test(command.trim())
}
