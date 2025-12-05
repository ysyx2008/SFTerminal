/**
 * 命令风险评估
 */
import type { RiskLevel } from './types'

/**
 * 评估命令风险等级
 */
export function assessCommandRisk(command: string): RiskLevel {
  const cmd = command.toLowerCase().trim()

  // 黑名单 - 直接拒绝
  const blocked = [
    /rm\s+(-[rf]+\s+)*\/(?:\s|$)/,    // rm -rf /
    /rm\s+(-[rf]+\s+)*\/\*/,           // rm -rf /*
    /:\(\)\{.*:\|:.*\}/,               // fork bomb
    /mkfs\./,                           // 格式化磁盘
    /dd\s+.*of=\/dev\/[sh]d[a-z]/,     // dd 写入磁盘
    />\s*\/dev\/[sh]d[a-z]/,           // 重定向到磁盘
    /chmod\s+777\s+\//,                 // chmod 777 /
    /chown\s+.*\s+\//                   // chown /
  ]
  if (blocked.some(p => p.test(cmd))) return 'blocked'

  // 高危 - 需要确认
  const dangerous = [
    /\brm\s+(-[rf]+\s+)*/,             // rm 命令
    /\bkill\s+(-9\s+)?/,               // kill 命令
    /\bkillall\b/,                      // killall
    /\bpkill\b/,                        // pkill
    /\bchmod\s+/,                       // chmod
    /\bchown\s+/,                       // chown
    /\bshutdown\b/,                     // shutdown
    /\breboot\b/,                       // reboot
    /\bhalt\b/,                         // halt
    /\bpoweroff\b/,                     // poweroff
    /\bsystemctl\s+(stop|restart|disable)/, // systemctl 危险操作
    /\bservice\s+\w+\s+(stop|restart)/,     // service 停止/重启
    /\bapt\s+remove/,                   // apt remove
    /\byum\s+remove/,                   // yum remove
    /\bdnf\s+remove/,                   // dnf remove
    />\s*\/etc\//,                      // 重定向到 /etc
    />\s*\/var\//                       // 重定向到 /var
  ]
  if (dangerous.some(p => p.test(cmd))) return 'dangerous'

  // 中危 - 显示但可自动执行
  const moderate = [
    /\bmv\s+/,                          // mv
    /\bcp\s+/,                          // cp
    /\bmkdir\s+/,                       // mkdir
    /\btouch\s+/,                       // touch
    /\bsystemctl\s+(start|enable|status)/, // systemctl 非危险操作
    /\bservice\s+\w+\s+start/,          // service start
    /\bapt\s+install/,                  // apt install
    /\byum\s+install/,                  // yum install
    /\bdnf\s+install/,                  // dnf install
    /\bnpm\s+install/,                  // npm install
    /\bpip\s+install/,                  // pip install
    /\bgit\s+(pull|push|commit)/        // git 修改操作
  ]
  if (moderate.some(p => p.test(cmd))) return 'moderate'

  // 安全 - 直接执行
  return 'safe'
}
