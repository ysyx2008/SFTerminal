export type {
  AuditContext,
  AuditedCall,
  AuditedRedirect,
  ArgvInput,
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

export {
  assessArgvRisk,
  argvNeedsConfirm,
  defaultAuditContext,
  isArgvBlocked,
} from './assess-argv'

export { assessAuditedCall, assessRedirectPaths, aggregateHasUnknown } from './assess-call'

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
