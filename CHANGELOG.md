# Changelog

All notable changes to SailFish will be documented in this file.

## v10.42.0 (2026-06-02) (Latest)

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
