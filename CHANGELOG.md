# Changelog

All notable changes to SailFish will be documented in this file.

## v10.41.0 (2026-05-29) (Latest)

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
