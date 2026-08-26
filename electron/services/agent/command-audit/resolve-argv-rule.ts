/**
 * 命令规则解析：用户硬拒覆盖内置，其余内置优先，再看用户规则
 */
import { ARGV_COMMAND_RULES, basenameCommand, type CommandRule } from './whitelist'
import { lookupUserCommandRule } from './user-command-rules'

/** 查找命令规则；未命中返回 undefined（调用方 Fail-Closed） */
export function getArgvCommandRule(cmd: string): CommandRule | undefined {
  const name = basenameCommand(cmd).toLowerCase()
  const builtin = ARGV_COMMAND_RULES[name]
  const user = lookupUserCommandRule(name)
  if (user?.baseLevel === 'blocked') {
    return builtin ? { ...builtin, baseLevel: 'blocked' } : user
  }
  return builtin ?? user
}
