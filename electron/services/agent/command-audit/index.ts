export type {
  AuditContext,
  AuditedCall,
  AuditedRedirect,
  CallRiskAssessment,
  CommandRiskAssessment,
  WorkspaceZone,
  SystemPathPattern,
} from './types'

export {
  PROTECTED_WORKSPACE_DIRS,
  PROTECTED_WORKSPACE_FILES,
  SYSTEM_PATH_PATTERNS,
} from './types'

export { defaultAuditContext } from './assess-shell'

export { assessAuditedCall, assessRedirectPaths, aggregateHasUnknown } from './assess-call'

export { checkIndirectionGuard, dangerousByGuard } from './indirection-guard'

export { commandNeedsConfirm, isSubAgentBlocked, displayRiskLevel } from './confirm-policy'

export { assessShellRisk, shellNeedsConfirm } from './assess-shell'

export { ensureShellAstReady, parseShellCommand } from './parser'

export { extractAuditedCalls, extractWriteRedirects } from './extract-calls'

export { isWindowsNativeShellCommand } from './platform-detect'

export {
  adjustRiskByPathZones,
  getWorkspaceZone,
  isSystemPath,
  resolveCommandPath,
} from './workspace-guard'

export {
  ALLOWED_USERDATA_ENTRIES,
  initUserDataGuard,
  isUserDataForbidden,
} from './userdata-guard'

export {
  ARGV_COMMAND_RULES,
  assessCommandFlags,
  basenameCommand,
  getArgvCommandRule,
  normalizeFlags,
  splitArgv,
} from './whitelist'

export type { CommandRule, ParsedArgv } from './whitelist'

export { maxRisk, maxRiskAll } from './risk-level'

export { resolveFailClosedLevel, resolveOutsideWritesUpgrade, resolveExtraFreeDirs, resolveSubAgentBlockDangerous, resolveRelaxedConfirmModerate } from './fail-closed-policy'
export type { FailClosedKind } from './fail-closed-policy'
