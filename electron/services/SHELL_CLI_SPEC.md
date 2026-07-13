# Shell CLI（`sailfish` 命令）

> Last verified: 2026-07-13

## 职责

在 macOS 上将 `sailfish` 安装到用户 PATH（默认 `~/.local/bin/sailfish`），薄壳转发到：

- **打包态**：`ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/SailFish" ".../dist-electron/cli.js"`
- **开发态**：`node electron/cli/main.js`（tsx + electron-shim）

不包含命令解析本身（见 `electron/cli/`）。

## 公开 API

| 方法 | 说明 |
|------|------|
| `getShellCliStatus()` | 是否已安装、shim 路径、目标 App/仓库 |
| `installShellCli()` | 写入薄壳；若 `~/.local/bin` 不在 PATH 则 `pathHint=true` |
| `uninstallShellCli()` | 删除薄壳 |

## IPC

- `shellCli:status` / `shellCli:install` / `shellCli:uninstall`

## 约束

- 第一期仅 macOS；Windows 另议
- 不要求 sudo（使用 `~/.local/bin` 而非 `/usr/local/bin`）
- 升级 App 后薄壳仍指向 `.app` 路径；若用户移动 App，需重新「安装命令行工具」
