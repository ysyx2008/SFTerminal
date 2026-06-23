# Changelog

All notable changes to SailFish will be documented in this file.

## v11.1.0 (2026-06-18) (Latest)

> The assistant artifact panel is now fully available—preview and switch between generated documents, charts, and more in the sidebar, with a collapsible layout that stays out of your way. The browser bridge can control your existing Chrome or Firefox session without opening a new window, keeping site logins intact.

### New Features
- 🎯 **Artifact Panel**: Collapse/expand, interactive HTML preview, single preview with title dropdown; Agent can open/close the panel explicitly; artifacts stored by kind with Agent awareness synced
- 🎯 **Browser Bridge Attach Mode**: Control your open Chrome or Firefox directly—no new window, logins preserved; connection status dashboard; Chrome Web Store listing
- 🎯 **Knowledge GPU Acceleration**: Migrated to Transformers.js v4 with GPU embedding acceleration; improved index rebuild stability and orphan chunk cleanup
- 🎯 **Agent Scratch Workspace**: New `scratch/` temp directory; workspace protection narrowed to IDENTITY/SOUL only
- 🎯 **Home Watch Anomaly Badge**: Welcome page watch cards show anomaly count
- 🎯 **Mermaid Zoom**: Click to enlarge with fixed white background
- 🎯 **Resizable Welcome Sidebar**: Drag to resize recent conversations sidebar; width cached in localStorage to avoid layout jump on startup
- 🎯 **Sub-Agent Safety**: Block dangerous commands and clearly communicate system limits to sub-agents

### Improvements
- ⚡ **Browser Bridge Protocol v1**: Thin extension architecture; content extraction moved to desktop Readability
- ⚡ **Artifact History Externalization**: Persist regenerable content; canvasData no longer lost after resume
- ⚡ **UI Polish**: Successful tool_result hidden by default; knowledge/startup progress bars split and fixed to avoid layout bounce; AiPanel scroll position saved across tabs
- ⚡ **OEM Brand Override**: Unified window title and i18n strings
- ⚡ **Data Management**: Added assistant session count in storage stats
- ⚡ **CI**: Windows build heap limit, model file caching, Dependabot security PR routing fix

### Bug Fixes
- 🐛 **Terminal Tool Regression**: Fixed v11 terminal tools not working
- 🐛 **Browser Bridge Reconnect**: Auto-reconnect after restart
- 🐛 **Streaming Messages**: Scroll-to-bottom interruption and "new message" flicker; user supplement messages out of order or lost
- 🐛 **Artifact Panel**: Lost on resume, collapse bar icons, animation, PPT preview color mismatch, Electron tooltip, etc.
- 🐛 **Email Attachments**: ZIP GBK extraction and overwrite protection
- 🐛 **Image Preview**: Mac trackpad gestures, pointer-anchored zoom
- 🐛 **Build**: vue-tsc errors breaking Windows installer build
- 🐛 **Website**: Browser bridge privacy policy page title hidden under navbar

## v11.0.0 (2026-06-12)

> A redesigned home page—start conversations, browse and manage recent history, and switch back to your workspace without losing progress.

### New Features
- 🎯 **Redesigned Home Page**: Integrated composer on the welcome page to start assistant chats without opening a tab first; recent conversations sidebar with browse, pin, custom titles, and right-click rename/delete
- 🎯 **Persistent Home Entry**: Home button stays available while work is in progress; return to the welcome page anytime without losing conversation progress, with history linked to current work state

### Improvements
- ⚡ **Agent History Storage Hardening**: Per-session file storage with atomic writes; legacy data migrated automatically on startup

### Bug Fixes
- 🐛 **Main Process i18n**: Menu, quit confirmation, and other user-visible main-process strings now follow the selected language
- 🐛 TTS auto-read did not sync when the setting was enabled

## v10.43.2 (2026-06-10)

> Introduced the workbench architecture, abstracting terminal and assistant UIs into a composable region model to lay the foundation for future extensions such as a browser workbench; plus minor knowledge index and loading progress improvements and a few bug fixes.

### Improvements
- ⚡ **Workbench Architecture Refactor** (internal): Terminal and assistant UIs abstracted into a workbench model with composable, extensible regions—foundation for future workbench types
- ⚡ **Incremental Knowledge Index Repair**: On startup, missing vector/BM25 entries are repaired incrementally instead of a full rebuild; checkpoint support allows resuming after interruption
- ⚡ **Unified System Loading Progress**: Backend startup and knowledge index repair merged into a single loading bar
- ⚡ **Loading Progress UI**: Multiple progress bars no longer overlap; index repair copy updated to "repair"

### Bug Fixes
- 🐛 **PPT Card Layout**: Fixed missing titles/badges inside cards and normalized in-card document flow
- 🐛 **IM Duplicate Notifications**: `talk_to_user` no longer pushes duplicate tool-process notifications

## v10.43.1 (2026-06-08)

> Improved exec output truncation and updater dialog experience, plus fixes for stale streaming placeholders after network failures.

### Improvements
- ⚡ **Updater Version Summary**: The auto-update dialog now shows the current version's changelog summary with a link to the full release notes.
- ⚡ **Exec Output Truncation**: Command output uses 16KB line-level head/tail truncation with metadata; full lines are preserved when possible, falling back to character truncation only when necessary.
- ⚡ **Hide Redundant Tool Result Cards**: Successful file write/edit operations no longer show redundant tool_result cards for a cleaner chat interface.
- ⚡ **Website Performance**: Reduced CPU usage when the website page stays open.

### Bug Fixes
- 🐛 **Network Failure Placeholder Cleanup**: Stale streaming placeholder steps are now cleared after Agent network request failures, preventing the UI from getting stuck.

## v10.43.0 (2026-06-05)

> Agent 可以生成可编辑的 PowerPoint 了，技能 API Key 配置和文件发送等体验也打磨得更顺手。

### New Features
- 🎯 **PPT Generation**: Agent can now generate editable PowerPoint documents directly. HTML content is rendered via browser and mapped to native PPT elements (text, shapes, images), supporting real-time streaming progress, Canvas preview, and append-on-overflow.

### Improvements
- ⚡ **Skill API Key Management**: Configure API keys directly in skill cards with persistent status display. `load_user_skill` auto-injects keys into terminal environment, no more manual env vars.
- ⚡ **Context Progress Bar**: Progress bar now shows the actual model name being used for the current conversation.
- ⚡ **Async File Sending**: File uploads no longer block the UI. Agent asynchronously tracks progress and waits for results.
- ⚡ **Cleaner Non-debug Mode**: Tool success logs are hidden by default in non-debug mode for a cleaner chat interface.
- ⚡ **Improved Image Preview**: Multi-image preview reworked to a compact single-column list navigation.
- ⚡ **Windows First-start Optimization**: LanceDB moved to a separate utility process, eliminating the first-launch freeze on Windows.
- ⚡ **Non-blocking Knowledge Search**: BM25 index uses async I/O, no more UI stutter during knowledge base search.

### Bug Fixes
- 🐛 Fixed file message notification showing raw `{name}{size}` placeholders.
- 🐛 Fixed unescaped raw HTML in Markdown causing Meta Refresh injection risk.
- 🐛 Fixed base64 inline images in agent execution steps causing renderer crashes.
- 🐛 Reduced embedding batch size to prevent knowledge base processing overload.
- 🐛 WeChat CDN upload now uses idle detection instead of fixed timeout for more stable connections.

## v10.42.0 (2026-06-02)

> Customizable Tab names, Mermaid chart rendering in AI chat, API key test in AI settings, async history search, and several fixes.

### New Features
- 🎯 **Customizable Tab Names**: Double-click a tab title to enter inline editing mode. Press Enter/blur to save, Esc to cancel. Clearing the custom title restores the auto-generated title.
- 🎯 **Mermaid Chart Rendering in AI Chat**: Render ` ```mermaid ` code blocks as architecture diagrams, flowcharts, sequence diagrams, etc. Supports streaming progressive rendering, right-click copy/save as PNG/SVG/JPG.
- 🎯 **AI Settings: API Key Test & Model List**: Test API key and endpoint connectivity with latency display. Fetch available models from `/v1/models` and display in a dropdown. Auto-detect vision models and set modelType accordingly.

### Improvements
- ⚡ **Async History Search**: History search is now fully asynchronous, eliminating main thread freezing. Cold-start recall is parallelized for faster startup.

### Bug Fixes
- 🐛 Fixed Tab rename input focus and select-all failure caused by string refs in v-for.
- 🐛 Fixed updater dialog logic: show confirmation dialog when auto-download is off; skip redundant toast when auto-download is on.

## v10.41.1 (2026-05-30)

> Canvas preview improvements with open button and macOS update experience optimization.

### New Features
- 🎯 **Canvas Preview "Open" Button**: Added an "Open" button to the Canvas preview panel with a dropdown option to reveal the file in Finder/Explorer.
- 🎯 **macOS Update Optimization**: Update downloads now redirect to the official website and automatically select the correct version based on your interface language.

### Improvements
- 🎨 **Refined Canvas Open Button Style**: Polished the visual appearance of the open button in the preview panel.
- 📝 **Simplified Save Label**: Streamlined the save button text in Canvas preview for clarity.

### Bug Fixes
- 🔧 **Fixed Canvas Preview Gap**: Eliminated the unwanted gap between the assistant's conversation area and the Canvas preview panel.

## v10.41.0 (2026-05-29)

> Custom data directory with auto-migration, comprehensive WeChat stability improvements, and various bug fixes.

### New Features
- 🎯 **Custom Data Directory**: Users can now choose a custom data storage location; data auto-migrates on restart with a progress window
- 🎯 **Auto-Update Improvements**: Refined update notification and installation strategies
- 🎯 **MCP Tool Chinese Display Name**: Tool call steps now show Chinese display names for better readability

### Bug Fixes
- 🐛 **CI Build Failure**: Removed `references` in `tsconfig.json` to fix TS6305 error on clean CI environments
- 🐛 **WeChat Stability Overhaul**: Fixed message avalanches, duplicate sending, connection drops, long-task disconnects, message ordering, keepalive self-healing, and tool failure indicators — aligned with official 2.4.4 SDK
- 🐛 **Agent Onboarding**: Only shows automatically once; skip no longer repeats
- 🐛 **Excel Header Duplication**: Fixed repeated header rows and added pre-write validation
- 🐛 **Paste Logic Unification**: Word paste now only pastes plain text
- 🐛 **Concurrent Session Guard**: Prevented re-opening completed tasks while Agent is still running

### Tests
- 🧪 **WeChat Adapter Tests**: Aligned test assertions with actual implementation

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
