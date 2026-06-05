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

**你的私人 AI Agent**

*说出你的需求，AI 自主规划执行——手机也能遥控*

[![Build](https://github.com/ysyx2008/SailFish/actions/workflows/build-release.yml/badge.svg)](https://github.com/ysyx2008/SailFish/actions)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![en](https://img.shields.io/badge/lang-English-blue.svg)](./README.md)
[![cn](https://img.shields.io/badge/lang-中文-red.svg)](./README_CN.md)

[官方网站](http://www.sfterm.com/) · [下载](https://github.com/ysyx2008/SailFish/releases) · [文档](./docs/)

</div>

---

## 为什么选择旗鱼？

| 痛点 | 旗鱼方案 |
|------|---------|
| 🤯 不会写命令？ | 用自然语言描述，AI 帮你执行 |
| 😵 看不懂报错？ | AI 分析原因并给出解决方案 |
| 🔁 重复性操作？ | Agent 自动化执行多步任务 |
| 🏢 内网环境？ | 支持私有化 AI 模型和代理 |
| 🛠️ CLI 配置太复杂？ | 图形界面，开箱即用 |
| 📱 不在电脑旁？ | 通过 Web、微信、钉钉、飞书、企业微信、Slack、Telegram 远程访问 Agent |

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-welcome.jpg" width="800" alt="旗鱼">
</p>

## ✨ 核心功能

| 功能 | 说明 |
|------|------|
| 🤖 **AI Agent** | 描述任务，Agent 自动规划执行 |
| 🧬 **身份体系** | Agent 人格由 IDENTITY.md、SOUL.md、USER.md 驱动，支持深度人格定制，首次启动自动发起诞生对话 |
| 🌅 **觉醒模式** | AI 变为主动助手 —— 个性驱动的对话、后台监控、推送通知 |
| 🧠 **关切与传感器** | 心跳、文件变化、日历、邮件四种传感器触发自动化工作流，支持有状态上下文 |
| 🌐 **远程 Agent** | 随时随地访问你的 Agent——Web、微信、钉钉、飞书、企业微信、Slack、Telegram |
| 🐦 **飞书技能** | 读写多维表格、云文档、电子表格、日历、任务、云空间；OAuth 授权让 Agent 以用户身份操作飞书 |
| 📌 **钉钉技能** | 日历日程、待办任务、考勤打卡、通讯录、审批流程、多维表格、钉盘、知识库 |
| 💼 **企微技能** | 日历管理、审批流程、打卡记录、通讯录操作、会议、微盘、文档 |
| 🖥️ **SSH/SFTP** | 完整的远程连接和文件管理，支持 JumpServer 堡垒机资产同步 |
| 📁 **文件管理器** | 双栏文件管理器，支持本地与远程 |
| 📚 **知识库** | 本地 RAG + L3 对话向量检索实现跨会话长期记忆，完全离线运行 |
| 🔍 **Web 搜索** | 内置联网搜索，支持 Bocha、Tavily、Google Custom Search、Jina 四种引擎 |
| 🔌 **MCP 扩展** | 通过 MCP 协议接入外部工具 |
| 🗄️ **数据库** | 自然语言执行 SQL 和分析 |
| 🛒 **技能市场** | 浏览、安装、分享社区 Agent 技能，一键扩展 |
| 📊 **Excel & Word** | 样式主题、Markdown 生成 Excel、一键生成多级编号制度文件 —— 全部通过自然语言完成 |
| 📽️ **PPT 演示文稿** | 自然语言生成原生可编辑 PowerPoint（.pptx），Canvas 幻灯片预览、流式渲染进度，长 deck 支持逐页追加 |
| 🔊 **语音合成** | Agent 回复自动朗读，支持 OpenAI、火山引擎、阿里 DashScope 多种 TTS 服务 |
| 🔌 **插件系统** | 通过轻量插件 API 扩展 Agent 能力：自定义工具、Provider、路由、IM 渠道 |
| 🔒 **系统托盘** | 最小化到托盘；Cmd+W 隐藏窗口不退出，单实例运行 |
| 🖥️ **CLI 模式** | 无需 Electron 运行全部后端服务 —— 通过 `npm run sft` 实现无头自动化 |

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-ppt.png" width="800" alt="PPT 演示文稿">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-assistant.png" width="800" alt="AI 助手">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-skills.png" width="800" alt="技能市场">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-im.png" width="800" alt="远程 Agent">
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
npm run build:linux  # Linux
```

> **开发版 Windows 安装包**（仅供作者跨平台测试用）：本地执行 `npm run build:win:remote` 即可触发 GitHub Actions 远程构建，约 8-10 分钟后产物会覆盖到 OSS 固定路径。不保证稳定。
> 下载地址：<https://sfterm-download.oss-cn-wuhan-lr.aliyuncs.com/dev/SailFish-Setup-dev.exe>

### AI 配置

旗鱼支持 OpenAI 兼容 API。在设置中配置：

```json
{
  "name": "你的 AI",
  "apiUrl": "https://api.openai.com/v1/chat/completions",
  "apiKey": "sk-xxx",
  "model": "gpt-4o"
}
```

**Agent 模式推荐模型**（需支持 Function Calling）：
- DeepSeek V3
- 通义千问 qwen-plus / qwen-max
- OpenAI GPT-4o / GPT-4o-mini
- Claude 4.5 Sonnet（支持 Anthropic 原生 API）
- Gemini、Grok、Mistral、豆包、智谱 GLM、Kimi（内置预设模板）

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
