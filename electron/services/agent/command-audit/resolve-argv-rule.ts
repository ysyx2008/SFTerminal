/**
 * 命令规则解析：内置 ARGV 优先，其次用户命令规则
 */
import { ARGV_COMMAND_RULES, basenameCommand, type CommandRule } from './whitelist'
import { lookupUserCommandRule } from './user-command-rules'

/** 查找命令规则；未命中返回 undefined（调用方 Fail-Closed） */
export function getArgvCommandRule(cmd: string): CommandRule | undefined {
  const name = basenameCommand(cmd).toLowerCase()
  return ARGV_COMMAND_RULES[name] ?? lookupUserCommandRule(name)
}
