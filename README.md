# 旗鱼终端

> AI 驱动的跨平台终端，助力运维提效

## 产品介绍

旗鱼终端是一款面向运维工程师和开发者的现代化终端工具。它将传统终端的强大功能与 AI 智能助手深度融合，让命令行操作变得更加高效、智能。

无论是日常的服务器管理、故障排查，还是复杂的批量运维操作，旗鱼终端都能成为你的得力助手。
遇到不熟悉的命令？让AI帮你解释。
看到报错信息一头雾水？AI会分析原因并给出解决方案。
想要执行某个操作但不知道命令？用自然语言描述，AI 为你生成。

对于企业用户，旗鱼终端充分考虑了内网环境的需求：支持配置私有化部署的 AI 模型，支持 HTTP/SOCKS 代理，可以一键导入 Xshell 会话配置，让团队快速上手、平滑迁移。

## 功能特性

- 🖥️ **跨平台支持**：Windows、macOS、Linux
- 🤖 **AI 助手**：命令解释、错误诊断、自然语言生成命令
- 🔐 **SSH 管理**：支持密码和私钥认证，会话分组管理
- 📥 **Xshell 导入**：一键导入 Xshell 会话配置，快速迁移
- 🎨 **丰富主题**：内置多款精美配色方案
- ⚡ **高性能**：基于 xterm.js，流畅的终端体验
- 🏢 **内网友好**：支持配置内网 AI API 和代理

## 技术栈

- **框架**：Electron 28 + Vue 3 + TypeScript
- **终端**：xterm.js 5.x
- **构建**：Vite + electron-builder

## 快速开始

### 环境要求

- Node.js 18+
- npm 或 pnpm

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

### 构建应用

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

## AI 配置

旗鱼终端支持 OpenAI 兼容 API，可以连接：

- 公有云服务：OpenAI、通义千问、DeepSeek 等
- 私有化部署：vLLM、FastChat、Ollama 等

### 配置示例

在设置中添加 AI 配置：

```json
{
  "name": "公司内网模型",
  "apiUrl": "http://10.0.1.100:8080/v1/chat/completions",
  "apiKey": "sk-xxx",
  "model": "qwen-72b",
  "proxy": null
}
```

## Xshell 会话导入

支持从 Xshell 导入已有的会话配置：

1. 点击主机管理面板的「导入」按钮
2. 选择「导入 Xshell 文件」或「导入 Xshell 目录」
3. 选择 `.xsh` 文件或 Xshell Sessions 目录

**说明**：
- 支持导入单个或多个 `.xsh` 文件
- 支持递归导入整个目录，子目录自动作为分组
- Xshell Sessions 目录通常位于：`C:\Users\<用户名>\Documents\NetSarang Computer\Xshell\Sessions`
- 由于 Xshell 密码是加密存储的，导入后需要手动设置密码

## 项目结构

```
├── electron/                # Electron 主进程
│   ├── main.ts             # 入口
│   ├── preload.ts          # 预加载脚本
│   └── services/           # 服务层
│       ├── pty.service.ts  # 本地终端
│       ├── ssh.service.ts  # SSH 连接
│       ├── ai.service.ts   # AI API
│       ├── config.service.ts
│       └── xshell-import.service.ts  # Xshell 导入
├── src/                    # Vue 渲染进程
│   ├── components/         # 组件
│   ├── stores/            # Pinia 状态
│   └── themes/            # 主题配色
├── resources/             # 应用图标
└── electron-builder.yml   # 打包配置
```

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| Ctrl+Shift+T | 新建标签页 |
| Ctrl+W | 关闭当前标签 |
| Ctrl+Tab | 切换标签页 |
| Ctrl+Shift+C | 复制 |
| Ctrl+Shift+V | 粘贴 |
| Ctrl+F | 搜索 |

## 许可证

MIT License

## 致谢

- [Electron](https://www.electronjs.org/)
- [xterm.js](https://xtermjs.org/)
- [Vue.js](https://vuejs.org/)
- [node-pty](https://github.com/microsoft/node-pty)
- [ssh2](https://github.com/mscdex/ssh2)
