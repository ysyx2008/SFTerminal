/**
 * 命令风险评估
 */
import type { RiskLevel } from './types'

/**
 * 交互式命令信息
 */
export interface InteractiveCommandInfo {
  isInteractive: boolean
  type?: 'fullscreen' | 'continuous' | 'input_required' | 'pager'
  reason?: string
  alternative?: string
}

/**
 * 检测命令是否是交互式的
 */
export function detectInteractiveCommand(command: string): InteractiveCommandInfo {
  const cmd = command.toLowerCase().trim()
  const cmdName = cmd.split(/\s+/)[0]

  // 全屏交互式程序
  const fullscreenCommands: Record<string, string> = {
    'vim': '使用 sed、awk 或 echo >> 来编辑文件',
    'vi': '使用 sed、awk 或 echo >> 来编辑文件',
    'nvim': '使用 sed、awk 或 echo >> 来编辑文件',
    'nano': '使用 sed、awk 或 echo >> 来编辑文件',
    'emacs': '使用 sed、awk 或 echo >> 来编辑文件',
    'top': '使用 ps aux --sort=-%mem | head 或 ps aux --sort=-%cpu | head',
    'htop': '使用 ps aux --sort=-%mem | head 或 ps aux --sort=-%cpu | head',
    'btop': '使用 ps aux --sort=-%mem | head',
    'nmon': '使用 vmstat 或 iostat',
    'mc': '使用 ls、cd、cp、mv 等命令',
    'ranger': '使用 ls、cd、cp、mv 等命令',
    'tmux': '不支持在 Agent 中使用 tmux',
    'screen': '不支持在 Agent 中使用 screen',
  }
  
  if (fullscreenCommands[cmdName]) {
    return {
      isInteractive: true,
      type: 'fullscreen',
      reason: `${cmdName} 是全屏交互式程序，会阻塞终端`,
      alternative: fullscreenCommands[cmdName]
    }
  }

  // 持续运行/监控命令
  const continuousPatterns: Array<{ pattern: RegExp; reason: string; alternative: string }> = [
    { 
      pattern: /^watch\s+/, 
      reason: 'watch 会持续运行直到手动停止',
      alternative: '直接执行要监控的命令一次，或使用 while 循环配合 sleep'
    },
    { 
      pattern: /\btail\s+(-[fF]|--follow)/, 
      reason: 'tail -f 会持续监听文件',
      alternative: '使用 tail -n 50 查看最后几行'
    },
    { 
      pattern: /\bjournalctl\s+(-f|--follow)/, 
      reason: 'journalctl -f 会持续监听日志',
      alternative: '使用 journalctl -n 50 或 journalctl --since "5 minutes ago"'
    },
    { 
      pattern: /\bdocker\s+logs\s+(-f|--follow)/, 
      reason: 'docker logs -f 会持续监听',
      alternative: '使用 docker logs --tail 50'
    },
    { 
      pattern: /\bkubectl\s+logs\s+(-f|--follow)/, 
      reason: 'kubectl logs -f 会持续监听',
      alternative: '使用 kubectl logs --tail 50'
    },
    {
      pattern: /\bping\s+(?!.*-c\s*\d)/, 
      reason: 'ping 不带 -c 参数会持续运行',
      alternative: '使用 ping -c 4 限制次数'
    },
  ]
  
  for (const { pattern, reason, alternative } of continuousPatterns) {
    if (pattern.test(cmd)) {
      return { isInteractive: true, type: 'continuous', reason, alternative }
    }
  }

  // 分页器（通常用管道）
  const pagerPatterns: Array<{ pattern: RegExp; reason: string; alternative: string }> = [
    { 
      pattern: /\|\s*less\s*$/, 
      reason: 'less 是交互式分页器',
      alternative: '移除 | less，或使用 | head -n 100'
    },
    { 
      pattern: /\|\s*more\s*$/, 
      reason: 'more 是交互式分页器',
      alternative: '移除 | more，或使用 | head -n 100'
    },
    { 
      pattern: /^less\s+/, 
      reason: 'less 是交互式分页器',
      alternative: '使用 cat 或 head -n 100'
    },
    { 
      pattern: /^more\s+/, 
      reason: 'more 是交互式分页器',
      alternative: '使用 cat 或 head -n 100'
    },
  ]
  
  for (const { pattern, reason, alternative } of pagerPatterns) {
    if (pattern.test(cmd)) {
      return { isInteractive: true, type: 'pager', reason, alternative }
    }
  }

  // 可能需要输入的命令（没有 -y 参数）
  const inputRequiredPatterns: Array<{ pattern: RegExp; noInputPattern: RegExp; reason: string; alternative: string }> = [
    {
      pattern: /\bapt(-get)?\s+install\b/,
      noInputPattern: /\s-y\b|\s--yes\b/,
      reason: 'apt install 可能需要确认',
      alternative: '添加 -y 参数自动确认'
    },
    {
      pattern: /\byum\s+install\b/,
      noInputPattern: /\s-y\b/,
      reason: 'yum install 可能需要确认',
      alternative: '添加 -y 参数自动确认'
    },
    {
      pattern: /\bdnf\s+install\b/,
      noInputPattern: /\s-y\b/,
      reason: 'dnf install 可能需要确认',
      alternative: '添加 -y 参数自动确认'
    },
    {
      pattern: /\bsudo\s+.*(apt|yum|dnf)\s+install\b/,
      noInputPattern: /\s-y\b|\s--yes\b/,
      reason: '包管理器安装可能需要确认',
      alternative: '添加 -y 参数自动确认'
    },
  ]
  
  for (const { pattern, noInputPattern, reason, alternative } of inputRequiredPatterns) {
    if (pattern.test(cmd) && !noInputPattern.test(cmd)) {
      return { isInteractive: true, type: 'input_required', reason, alternative }
    }
  }

  // 其他需要输入的命令
  const otherInputCommands = [
    { pattern: /^read\b/, reason: 'read 命令等待用户输入', alternative: '使用变量或参数传递值' },
    { pattern: /\bpasswd\b/, reason: 'passwd 需要交互式输入密码', alternative: '使用 chpasswd 或 echo "user:pass" | chpasswd' },
    { pattern: /^ssh\s+(?!.*-o\s*BatchMode)/, reason: 'ssh 可能需要输入密码', alternative: '使用密钥认证或 sshpass' },
    { pattern: /\bsudo\s+-S\b/, reason: 'sudo -S 从 stdin 读取密码', alternative: '确保 NOPASSWD 配置或使用其他方式' },
  ]
  
  for (const { pattern, reason, alternative } of otherInputCommands) {
    if (pattern.test(cmd)) {
      return { isInteractive: true, type: 'input_required', reason, alternative }
    }
  }

  return { isInteractive: false }
}

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
