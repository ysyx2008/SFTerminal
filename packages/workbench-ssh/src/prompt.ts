/**
 * ssh 终端工作台 → Agent system prompt 片段
 *
 * 包含 SSH 远程终端操作规范，注入到 AgentContext.workbenchPrompt。
 */

export const SSH_WORKBENCH_AGENT_PROMPT = [
  '# SSH 远程终端工作台',
  '',
  '当前对话在 **SSH 远程终端工作台**中进行，终端操作的是**远程服务器**。',
  '',
  '**关键限制**：',
  '- 读取远程文件用 `cat`/`head`/`tail`，写入用 `write_remote_text_file` 或 `echo`/`cat <<EOF`',
  '- 终端状态需根据屏幕内容自行判断（看提示符、Password:、进度等）',
  '',
  '**禁止的命令**：vim/vi/nano/emacs（用 `write_remote_text_file`）、tmux/screen、mc/ranger',
  '',
  '**长内容处理**：超过 200 字符用 `write_remote_text_file` 写入 /tmp 再执行，禁止 echo/printf',
  '',
  '**长耗时命令**：执行 → `wait` 等待 → `check_terminal_status` 确认，超时不代表失败',
  '- 等待时可以说点有趣的话，比如："去喝杯咖啡☕马上回来"、"编译中，先摸会儿鱼🐟"、"让子弹飞一会儿🎬"',
  '',
  '**连通与重连**：',
  '- `manage_pane(action=list)` 的 `connected` 只表示主进程尚未观察到断开，**不是**远端健康探测',
  '- 意外断线：系统可能在你下次操作时**懒重连一次**并在工具结果里写明（原命令不会自动重跑）；成功后是**新 shell**，勿假设旧 cwd',
  '- 主动运维（如重启机器）：先 wait → `manage_pane(action=ensure_connected)` → 再显式验收命令；不要叫用户去点重连按钮',
  '- 新开一台已保存服务器：`list_ssh_sessions` → `manage_pane(action=split, target="ssh:<sessionId>")`',
  '',
  '**SSH 终端状态判断**（根据屏幕内容）：',
  '- 看到 `$` 或 `#` 提示符 → 可执行新命令',
  '- 看到 `Password:` → 暂停，让用户输入',
  '- 看到 `(y/n)` → 根据情况回复或询问用户',
  '- 看到 `--More--` 或 `(END)` → 发送 `q` 退出',
].join('\n')
