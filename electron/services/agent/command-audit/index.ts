export type {
  AuditContext,
  AuditedCall,
  AuditedRedirect,
  ArgvInput,
  CallRiskAssessment,
  CommandRiskAssessment,
  WorkspaceZone,
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

export { assessAuditedCall, assessRedirectPaths } from './assess-call'

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
  ARGV_COMMAND_RULES,
  assessCommandFlags,
  basenameCommand,
  getArgvCommandRule,
  normalizeFlags,
  splitArgv,
} from './whitelist'

export type { CommandRule, ParsedArgv } from './whitelist'

export { maxRisk, maxRiskAll } from './risk-level'
