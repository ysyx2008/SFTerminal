<div align="center">

<pre>
███████╗ █████╗ ██╗██╗     ███████╗██╗███████╗██╗  ██╗
██╔════╝██╔══██╗██║██║     ██╔════╝██║██╔════╝██║  ██║
███████╗███████║██║██║     █████╗  ██║███████╗███████║
╚════██║██╔══██║██║██║     ██╔══╝  ██║╚════██║██╔══██║
███████║██║  ██║██║███████╗██║     ██║███████║██║  ██║
╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝
</pre>

<img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/resources/logo.png" alt="SailFish Logo" width="80">

**SailFish**

**Your Personal Desktop Secretary**

*Knows your habits, acts proactively, and truly operates your computer — local terminal, remote servers, email, calendar, and more*

[![Build](https://github.com/ysyx2008/SailFish/actions/workflows/build-release.yml/badge.svg)](https://github.com/ysyx2008/SailFish/actions)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![en](https://img.shields.io/badge/lang-English-blue.svg)](./README.md)
[![cn](https://img.shields.io/badge/lang-中文-red.svg)](./README_CN.md)

[Website](http://www.sfterm.com/en/) · [Download](https://github.com/ysyx2008/SailFish/releases) · [Documentation](./docs/)

</div>

---

## Why a Secretary, Not Just a Tool

SailFish isn't a chatbot waiting for commands. It's a **personal secretary** living on your desktop — with its own rhythm, proactive monitoring, the ability to reach out to you, memory of who you are and what you discussed, and the power to actually operate your computer.

| Pain Point | SailFish Approach |
|------------|-------------------|
| Chat-only AI can't act | Your secretary runs commands, reads/writes files, controls the browser, sends email |
| Every conversation starts from zero | Three-tier memory + knowledge base: knows you (L2), recalls past work (L3), file archive on demand |
| You have to watch and wait | Awaken mode + Watch: proactive monitoring, scheduled tasks, push notifications |
| Tied to your desk | Reach your same secretary via WeChat, DingTalk, Feishu, Slack, Telegram, or Web |
| Don't know the command? | Describe in natural language; your secretary plans and executes |
| Intranet restrictions? | Supports private AI models and proxies |

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-welcome_en.jpg" width="800" alt="SailFish">
</p>

## Two Ways to Work: Tasks & Reach

| Entry | Relationship | Character |
|-------|--------------|-----------|
| **Tasks** | You delegate specific work to your secretary | One-off, parallel, isolated; the desktop mainstay |
| **Reach** | Your ongoing relationship with your secretary | Always-on, multi-channel; your secretary can reach out first |

Tasks come first on desktop; Reach sits at the end — all IM channels flow into one continuous relationship, not a different bot each time.

## ✨ Core Capabilities

| Feature | Description |
|---------|-------------|
| 🧬 **Identity & Personality** | IDENTITY/SOUL/USER shape your secretary's character; birth conversation on first launch |
| 🧠 **Three-Tier Memory** | L2 knows you (habits & facts), L3 recalls past work on demand; knowledge base is your secretary's archive |
| 🌅 **Awaken Mode** | Your secretary becomes proactive — personality-driven chat, background monitoring, reaching out to you |
| 👁️ **Watch & Sensors** | Heartbeat, file-watch, calendar, and email sensors; anomaly badges on the home screen at a glance |
| 💬 **Multi-Channel Reach** | WeChat, DingTalk, Feishu, WeCom, Slack, Telegram, Web — one secretary, one relationship |
| 🖥️ **Local & SSH Terminal** | Your secretary operates your machine and remote servers; JumpServer bastion sync |
| 🌐 **Browser Bridge** | Control your open Chrome or Firefox — no new window, logins preserved |
| 📦 **Artifact Panel** | Preview and switch documents, charts, PPT, and other outputs in the sidebar |
| 📁 **File Manager** | Dual-pane local and remote file management |
| 🐦 **Feishu / DingTalk / WeCom** | Calendar, tasks, approvals, docs, Bitable, and other enterprise office skills |
| 📊 **Office Skills** | Excel, Word, PPT generation and editing via natural language |
| 📧 **Email & Calendar** | Your secretary reads/sends email and manages your schedule |
| 🔍 **Web Search** | Bocha, Tavily, Google, Jina multi-engine search |
| 🛒 **Skill Market & Plugins** | One-click community skills; plugins extend tools, providers, and IM channels |
| 🔌 **MCP Extension** | Connect databases, APIs, and external tools |
| 🔊 **Text-to-Speech** | Secretary responses read aloud |
| 🔒 **System Tray** | Minimize to tray, always available in the background |
| 🖥️ **CLI Mode** | Headless backend via `npm run sft` |

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-assistant_en.png" width="800" alt="Desktop Secretary">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-skills_en.png" width="800" alt="Skill Market">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-im_en.png" width="800" alt="Multi-Channel Reach">
</p>

## 🚀 Quick Start

### Download

Get the latest release from [GitHub Releases](https://github.com/ysyx2008/SailFish/releases) or [Official Website](http://www.sfterm.com/en/). On Windows, releases include a **portable ZIP** in addition to the NSIS installer—use the ZIP if the installer fails on older systems (e.g. some Windows Server 2016 builds).

### Development

```bash
# Install dependencies
npm install

# Start development
npm run dev

# Build
npm run build:mac    # macOS
npm run build:win    # Windows
```

> **Dev Windows build** (for the author's cross-platform testing only): run `npm run build:win:remote` locally to trigger a GitHub Actions build; the artifact overwrites a fixed OSS path in 8-10 minutes. Stability is not guaranteed.
> Download: <https://sfterm-download.oss-cn-wuhan-lr.aliyuncs.com/dev/SailFish-Setup-dev.exe>

### AI Configuration

SailFish supports OpenAI-compatible APIs. Configure in Settings:

```json
{
  "name": "Daily DeepSeek",
  "apiUrl": "https://api.deepseek.com/chat/completions",
  "apiKey": "sk-xxx",
  "model": "deepseek-v4-flash"
}
```

**Recommended models for secretary mode** (requires Function Calling; configure multiple profiles and switch anytime):

- **Daily use** (fast, affordable): DeepSeek V4 Flash · Qwen 3.5 Plus · Claude Sonnet 4.6 · Gemini Flash
- **Complex tasks** (long reasoning, multi-step): DeepSeek V4 Pro · GPT-5.5 · Claude Opus 4.7 · Gemini 3.1 Pro
- **Vision tasks** (screenshots, image analysis, scanned PDFs): Doubao Seed 2.0 · Qwen 3.5 Plus · GPT-5.5 · Gemini Flash · Claude Sonnet 4.6
- **More providers**: Doubao Seed 2.0, Zhipu GLM-5, Kimi K2.6, MiniMax M2.7, Grok, Mistral, and more (one-click presets in Settings)

## 🏗️ Architecture

<p align="center">
  <img src="./docs/architecture.png" width="800" alt="SailFish Architecture">
</p>

## 📖 Documentation

- [Agent Architecture](./docs/agent-architecture.md)
- [IM Integration Guide](./docs/messaging-integration.md)
- [Changelog](./CHANGELOG.md)
- [Contributing](./CONTRIBUTING.md)

## 📄 License

**Dual Licensing**: AGPL v3.0 for open source use, commercial license available.

- ✅ Personal use, research, education
- ✅ Enterprise internal use (≤1000 installations, modifications must be open-sourced)
- 💼 Commercial license required for: >1000 installations, SaaS/product integration, closed-source modifications

See [LICENSE](./LICENSE) for details.

## 🔗 Links

- 🌐 [Website](http://www.sfterm.com/en/)
- 📦 [GitHub](https://github.com/ysyx2008/SailFish)
- 🐛 [Issues](https://github.com/ysyx2008/SailFish/issues)

## 🙏 Acknowledgements

Built with [Electron](https://www.electronjs.org/), [Vue.js](https://vuejs.org/), [xterm.js](https://xtermjs.org/), [LanceDB](https://lancedb.com/), and many other amazing open source projects.
