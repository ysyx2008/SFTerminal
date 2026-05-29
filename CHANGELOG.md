# Changelog

All notable changes to SailFish will be documented in this file.

## v10.41.0 (2026-05-29) (Latest)

> 支持自定义数据目录自动迁移，全面优化微信稳定性，修复多项问题。
> Custom data directory with auto-migration, comprehensive WeChat stability improvements, and various bug fixes.

### 新功能 / New Features
- 🎯 **数据目录迁移 / Custom Data Directory**：支持自定义数据存放目录，重启时自动迁移并显示进度窗口 / Users can now choose a custom data storage location; data auto-migrates on restart with a progress window
- 🎯 **自动更新改进 / Auto-Update Improvements**：优化更新提醒与安装策略 / Refined update notification and installation strategies
- 🎯 **MCP工具中文展示名 / MCP Tool Chinese Display Name**：工具调用步骤显示中文名称 / Tool call steps now show Chinese display names for better readability

### 修复 / Bug Fixes
- 🐛 **CI构建失败 / CI Build Failure**：移除 `tsconfig.json` 中的 `references`，修复CI干净环境下的TS6305错误 / Removed `references` in `tsconfig.json` to fix TS6305 error on clean CI environments
- 🐛 **微信稳定性全面优化 / WeChat Stability Overhaul**：修复消息雪崩、重复发送、断流、长任务中断、消息次序、keepalive自愈及工具失败提示——对齐官方2.4.4 SDK / Fixed message avalanches, duplicate sending, connection drops, long-task disconnects, message ordering, keepalive self-healing, and tool failure indicators — aligned with official 2.4.4 SDK
- 🐛 **Agent引导 / Agent Onboarding**：仅自动展示一次，跳过不再重复 / Only shows automatically once; skip no longer repeats
- 🐛 **Excel表头重复 / Excel Header Duplication**：修复读取时表头行重复输出，增加写入前校验 / Fixed repeated header rows and added pre-write validation
- 🐛 **粘贴逻辑统一 / Paste Logic Unification**：Word复制仅粘贴纯文本 / Word paste now only pastes plain text
- 🐛 **并发会话守卫 / Concurrent Session Guard**：Agent运行时禁止从已完成任务另开会话 / Prevented re-opening completed tasks while Agent is still running

### 测试 / Tests
- 🧪 **微信适配器测试 / WeChat Adapter Tests**：测试断言与实际实现对齐 / Aligned test assertions with actual implementation

## v10.40.1 (2026-05-24)

> Fixes Chinese PDF rendering, WeChat long-task disconnects, and Canvas Markdown preview issues, plus improvements to terminal batch commands and Word document handling.

### Improvements
- 🔧 **Batch Commands for Split Panes**: Batch commands can target split-pane windows and support range switching
- 🔧 **Word Style Extraction from Templates**: Automatically extract styles from docx templates to simplify formatting workflows
- 🔧 **Canvas Markdown Preview**: Defaults to preview mode; preview content can be quoted to AI with text selection and copy support
- 🔧 **Unified Word Title Conventions**: Standardized document title format with tolerance for `## title:` typos
- 🔧 **Chart White Background**: `render_echarts_option` now injects a white background by default

### Bug Fixes
- 🐛 **Chinese PDF Rendering Boxes**: Injected cMap and standard_fonts to fix missing glyphs
- 🐛 **PDF Packaging Render Failure**: Added pdfjs-config.mjs to asarUnpack for production PDF rendering
- 🐛 **WeChat Long-Task Disconnect**: Typing keepalive now spans the entire Agent task
- 🐛 **WeChat Delivery Failure Sync**: Delivery failures sync to IM and register sessions on inbound messages
- 🐛 **Canvas Shortcut & Focus Styles**: Fixed Markdown preview shortcut toggle and removed focus halo

## v10.40.0 (2026-05-18)

> Canvas Markdown panels now support editing and preview switching with AI reference, plus improved quoting, background task notifications, and more.

### New Features
- 🎯 **Markdown Panel Editing**: Canvas Markdown panels now support switching between edit and preview mode; content can be directly referenced into the AI input box

### Improvements
