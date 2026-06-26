<div align="center">

<pre>
███████╗ █████╗ ██╗██╗     ███████╗██╗███████╗██╗  ██╗
██╔════╝██╔══██╗██║██║     ██╔════╝██║██╔════╝██║  ██║
███████╗███████║██║██║     █████╗  ██║███████╗███████║
╚════██║██╔══██║██║██║     ██╔══╝  ██║╚════██║██╔══██║
███████║██║  ██║██║███████╗██║     ██║███████║██║  ██║
╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝
</pre>

<img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/resources/logo.png" alt="旗鱼 Logo" width="80">

**旗鱼 SailFish**

**你的私人桌面秘书**

*了解你的习惯，主动帮你办事——本地终端、远程服务器、邮件日历，真正上手操作电脑*

[![Build](https://github.com/ysyx2008/SailFish/actions/workflows/build-release.yml/badge.svg)](https://github.com/ysyx2008/SailFish/actions)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![en](https://img.shields.io/badge/lang-English-blue.svg)](./README.md)
[![cn](https://img.shields.io/badge/lang-中文-red.svg)](./README_CN.md)

[官方网站](http://www.sfterm.com/) · [下载](https://github.com/ysyx2008/SailFish/releases) · [文档](./docs/)

</div>

---

## 为什么是秘书，不只是工具

旗鱼不是被动等指令的聊天机器人，而是住在你电脑里的**私人秘书**——有自己的节奏，能主动监控和找你，记得住你是谁、上次聊过什么，并且能真正动手操作。

| 痛点 | 旗鱼的做法 |
|------|---------|
| 纯聊天 AI 只会说不会做 | 秘书能运行命令、读写文件、操控浏览器、收发邮件 |
| 每次对话都从零开始 | 三层记忆 + 知识库：认识你（L2）、能回忆（L3）、档案室按需取用 |
| 需要你主动守着 | 觉醒模式 + 关切：秘书自己监控、定时执行、主动通知 |
| 只能坐在电脑前 | 微信、钉钉、飞书、Slack、Telegram 等渠道随时联络同一位秘书 |
| 不会写命令、看不懂报错 | 用自然语言描述，秘书规划步骤并执行 |
| 内网环境 | 支持私有化 AI 模型和代理 |

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-welcome.jpg" width="800" alt="旗鱼">
</p>

## 两种用法：任务与联络

| 入口 | 关系 | 特点 |
|------|------|------|
| **任务** | 你支使秘书完成具体工作 | 一次性、可并行、彼此隔离；桌面端主力 |
| **联络** | 你与秘书的持续关系线 | 常驻、多渠道汇流；秘书也能主动找你 |

桌面以任务为主，联络在末尾——所有 IM 渠道汇入同一条关系线，秘书不会「换个人」。

## ✨ 核心能力

| 功能 | 说明 |
|------|------|
| 🧬 **身份与人格** | IDENTITY/SOUL/USER 驱动秘书人格；首次启动诞生对话，越用越像「你的」秘书 |
| 🧠 **三层记忆** | L2 秘书认识你（习惯与事实）、L3 秘书能回忆（完整经历按需检索）；知识库是交给秘书的档案室 |
| 🌅 **觉醒模式** | 秘书变为主动角色——个性对话、后台监控、主动找你 |
| 👁️ **关切与传感器** | 心跳、文件变化、日历、邮件触发自动化；首页一眼看到有没有出问题 |
| 💬 **多渠道联络** | 微信、钉钉、飞书、企业微信、Slack、Telegram、Web——汇入同一位秘书 |
| 🖥️ **本地 & SSH 终端** | 秘书真正上手操作本机与远程服务器；JumpServer 堡垒机同步 |
| 🌐 **浏览器助手** | 接管已有 Chrome/Firefox，保留登录态，无需另开窗口 |
| 📦 **产出物面板** | 文档、图表、PPT 等生成物侧边预览与切换 |
| 📁 **文件管理器** | 双栏管理本地与远程文件 |
| 🐦 **飞书 / 钉钉 / 企微** | 日历、待办、审批、文档、多维表格等企业办公技能 |
| 📊 **Office 技能** | Excel、Word、PPT 通过自然语言生成与编辑 |
| 📧 **邮件 & 日历** | 秘书帮你读写邮件、管理日程 |
| 🔍 **Web 搜索** | Bocha、Tavily、Google、Jina 多引擎 |
| 🛒 **技能市场 & 插件** | 社区技能一键安装；插件扩展工具、Provider、IM 渠道 |
| 🔌 **MCP 扩展** | 接入数据库、API 等外部工具 |
| 🔊 **语音合成** | 秘书回复自动朗读 |
| 🔒 **系统托盘** | 最小化到托盘，常驻后台 |
| 🖥️ **CLI 模式** | `npm run sft` 无头运行全部后端服务 |

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-ppt.png" width="800" alt="PPT 演示文稿">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-assistant.png" width="800" alt="桌面秘书">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-skills.png" width="800" alt="技能市场">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-im.png" width="800" alt="多渠道联络">
</p>

## 🚀 快速开始

### 下载安装

从 [GitHub Releases](https://github.com/ysyx2008/SailFish/releases) 或 [官方网站](http://www.sfterm.com/) 下载最新版本。Windows 除 NSIS 安装包外还提供 **ZIP 便携版**；若安装程序提示无法运行（如部分 Windows Server 2016 环境），可选用 ZIP 解压后运行。

### 开发调试

```bash
# 安装依赖
npm install

# 启动开发模式
npm run dev

# 构建应用
npm run build:mac    # macOS
npm run build:win    # Windows
```

> **开发版 Windows 安装包**（仅供作者跨平台测试用）：本地执行 `npm run build:win:remote` 即可触发 GitHub Actions 远程构建，约 8-10 分钟后产物会覆盖到 OSS 固定路径。不保证稳定。
> 下载地址：<https://sfterm-download.oss-cn-wuhan-lr.aliyuncs.com/dev/SailFish-Setup-dev.exe>

### AI 配置

旗鱼支持 OpenAI 兼容 API。在设置中配置：

```json
{
  "name": "日常 DeepSeek",
  "apiUrl": "https://api.deepseek.com/chat/completions",
  "apiKey": "sk-xxx",
  "model": "deepseek-v4-flash"
}
```

**推荐模型**（需支持 Function Calling，可配置多个、随时切换）：

- **日常**（快、省、够用）：DeepSeek V4 Flash · Qwen 3.5 Plus · Claude Sonnet 4.6 · Gemini Flash
- **复杂任务**（长推理、多步骤）：DeepSeek V4 Pro · GPT-5.5 · Claude Opus 4.8 · Gemini 3.1 Pro
- **视觉任务**（截图、识图、扫描件）：豆包 Seed 2.0 · Qwen 3.5 Plus · GPT-5.5 · Gemini Flash · Claude Sonnet 4.6
- **更多厂商**：豆包 Seed 2.0、智谱 GLM-5、Kimi K2.6、MiniMax M2.7、Grok、Mistral 等（设置页一键添加预设）

## 🏗️ 系统架构

<p align="center">
  <img src="./docs/architecture.png" width="800" alt="旗鱼系统架构">
</p>

## 📖 文档

- [Agent 架构](./docs/agent-architecture.md)
- [IM 集成指南](./docs/messaging-integration_CN.md)
- [更新日志](./CHANGELOG.md)
- [贡献指南](./CONTRIBUTING.md)

## 📄 许可证

**双许可模式**：开源使用遵循 AGPL v3.0，商业使用需授权。

- ✅ 个人使用、学习研究、教育机构
- ✅ 企业内部使用（≤1000 套，修改需开源）
- 💼 需商业授权：>1000 套、SaaS/产品集成、闭源修改

详见 [LICENSE](./LICENSE) 文件。

## 🔗 相关链接

- 🌐 [官方网站](http://www.sfterm.com/)
- 📦 [GitHub](https://github.com/ysyx2008/SailFish)
- 🐛 [问题反馈](https://github.com/ysyx2008/SailFish/issues)

## 🙏 致谢

基于 [Electron](https://www.electronjs.org/)、[Vue.js](https://vuejs.org/)、[xterm.js](https://xtermjs.org/)、[LanceDB](https://lancedb.com/) 等优秀开源项目构建。
