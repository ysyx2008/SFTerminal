# Browser Bridge 服务 SPEC

> Last verified: 2026-06-13

## 职责

让用户 **已打开** 的 Chrome / Edge / Firefox 标签页与登录态可被 Agent 复用。通过浏览器扩展 + Native Messaging Host + Electron TCP 网关实现。

**扩展定位**：长期稳定的「浏览器遥控 API」（protocol v1）。正文提取、Readability、DOM 启发式等**业务逻辑在 SailFish 桌面端**，扩展只负责 DOM 原语与 HTML 回传，以减少应用商店发版频率。

## 架构

```
Agent browser_* (attach 模式)
    ↕
BrowserBridgeService (Electron TCP :随机端口)
    ↕  extractPageContentFromHtml / Readability / html-article-extract
native-host/host.mjs (Chrome 按连接 spawn)
    ↕ Native Messaging (stdin/stdout)
扩展 background.js → content.js (DOM 原语 / 快照 / page_html)
```

## 协议 v1（扩展 ↔ 桌面端）

### 版本

- `BROWSER_BRIDGE_PROTOCOL_VERSION = 1`（`shared/types/browser-bridge.ts`）
- 扩展 `ping` 响应：`{ extension, version, protocol: 1 }`
- 桌面端 `parsePingResult` / `supportsProtocolV1` 做能力判断；旧扩展无 `protocol` 时 `get_content` 降级为 `mode: html` 整页抓取
- Firefox MV3：`host_permissions` 为可选权限；扩展 ping 上报 `hostPermissionsGranted`（v1.2.2+），设置页据此提示用户授权

### 冻结 action 名单

新能力**优先扩展 payload**，不新增 action（**例外**：`tabs` 为 1.2.0 最终 Tab 原语层，此后 Tab 相关策略均在桌面端组合 `tabs` op，扩展不再为 Tab 行为发版）：

`ping` | `tabs` | `list_tabs` | `switch_tab` | `goto` | `close_tab` | `reload` | `evaluate` | `snapshot` | `get_content` | `click` | `type` | `scroll`

legacy `list_tabs` / `switch_tab` / `goto` / `close_tab` 内部委托 `shared/tabs-api.js`，桌面端 1.2.0+ 优先直接发 `tabs`。

### tabs payload（1.2.0+，Tab 原语最终版）

| op | 说明 | 主要字段 |
|----|------|---------|
| `query` | 列出标签 | `query`（默认 `{ currentWindow: true }`） |
| `create` | 新建标签 | `url`, `active`（默认 true）, `index`, `windowId`, `wait`（默认 true 当有 url） |
| `update` | 更新标签（含当前标签导航） | `tabId` / `index` / 省略=活动标签, `url`, `active`, `wait` |
| `activate` | 激活标签 | `tabId` / `index` |
| `remove` | 关闭标签 | `tabId` / `index` / 省略=活动标签 |

扩展 `ping` capabilities：`tabs_manage`, `goto_new_tab`。桌面端 `extensionSupportsTabsManage()` 做能力判断。

### goto payload（legacy，委托 tabs）

| 字段 | 说明 |
|------|------|
| `url` | 目标 URL（必填） |
| `new_tab` | 省略或 `true` → `tabs.create`；**仅** `false` → 当前标签 `tabs.update` |

### get_content payload（protocol v1）

| mode | 扩展行为 | 桌面端 |
|------|---------|--------|
| `page_html` | 回传 `html` + `fallbackText`（body.innerText） | Readability → 启发式 → fallback |
| `text` / `html` | 整页或 selector 原语 | 一般不经桌面端二次提取 |
| `extract: full` | 整页 body / outerHTML | — |

## 公开契约

### IPC

| Channel | 说明 |
|---------|------|
| `browserBridge:getStatus` | 对已连接扩展 ping 后返回 `BrowserBridgeStatus`（含 `connections[].version`） |
| `browserBridge:install` | 复制扩展、写 manifest、注册 Native Host |
| `browserBridge:uninstall` | 移除 Native Host 注册与本机扩展文件 |
| `browserBridge:openExtensionGuide` | 用对应浏览器打开扩展管理页（`chrome://` 等内部 URL） |
| `browserBridge:connectionsChanged`（主→渲染 push） | 扩展连上/断开或 install/uninstall 后推送最新 `BrowserBridgeStatus` |

### Agent 集成

- `browser_launch` 增加 `attach: true` 或 `mode: 'attach'`：连接用户浏览器，不启动 Playwright
- `browser_launch.browser`：`auto` | `firefox` | `chromium`（`chrome`/`edge` 别名）；双开时必须显式指定；会话绑定后后续 `browser_*` 走同一路由
- attach 会话存于 `bridge-session.ts`（含 `origin` + `browserTarget` + `extensionPing`），与 Playwright `session.ts` 并行
- `browser_get_content`（auto/article）：扩展 `page_html` → 桌面端 `extractPageContentFromHtml`
- 未 attach 时行为不变
- Agent 系统提示在 Tier 2 注入 `buildBrowserBridgePromptSection()`（扩展在线时告知优先 attach、无需 browser_launch）
- prompt cache 复用路径下，`agent.ts` 调用 `patchBrowserBridgeSectionInSystemPrompt()` 刷新 system 消息中的该章节，避免同会话追问时状态过期

### Native Host 名

固定 `com.sailfish.browser`（见 `shared/types/browser-bridge.ts`）。

### 扩展 ID

- Chromium 开发版（manifest `key`，临时加载）：`ocdljfppijcjpgaaamgeailkgajgjdml`
- Chromium 商店版（Chrome Web Store）：`dgmhdapfpihhkboikpgfanpgnijbpdhd`
- Native Host `allowed_origins` **同时包含**上述两个 ID
- Firefox：`sailfish-browser-bridge@yushen.dev`

### 扩展 content_scripts（protocol v1 起不再增文件）

`safe-eval.js` | `snapshot.js` | `content.js`

## 安装

1. 从 `resources/browser-bridge/` 复制到 `{userData}/browser-bridge/`（`userData` 随「数据管理」自定义目录变化，见 `bootstrap.ts`）
2. 写 `{userData}/browser-bridge/native-host/com.sailfish.browser.json` 并注册 NativeMessagingHosts（macOS 覆盖 Chrome / **Arc** / Brave / Edge / Chromium / Vivaldi / Opera 等各自目录）
   - **Chromium 系**：manifest 用 `allowed_origins`（`chrome-extension://…/`）
   - **Firefox**：manifest 用 `allowed_extensions`（扩展 ID 字符串，如 `sailfish-browser-bridge@yushen.dev`）
3. 写 `$HOME/.sailfish-browser-bridge.json` 指针（供 Chrome 拉起的 host 进程定位当前 gateway，**不硬编码** SFTerm/SailFish 路径）
4. macOS：`clang` 编译 `{Electron.app}/Contents/Helpers/sailfish-browser-host` Mach-O（与 Claude 同款路径；Chrome 无法稳定拉起 `$HOME` 下的 host）；manifest **按浏览器拆分**（Chrome 仅 `chrome-extension://`，Firefox 仅 `moz-extension://`）
5. Windows host 启动：`ELECTRON_RUN_AS_NODE=1` + 应用可执行文件 + `host.mjs`
   - **Windows 注册表路径（易错）**：Chrome=`Software\Google\Chrome\NativeMessagingHosts\<name>`、Edge=`Software\Microsoft\Edge\...`，但 **Firefox=`Software\Mozilla\NativeMessagingHosts\<name>`（无 `\Firefox` 子级）**。曾误写为 `Mozilla\Firefox` 导致 Firefox 找不到 Native Host；`installer.ts` 装/卸载时会顺带清除历史误写的旧 key。

**迁移/修改数据目录后**：启动时会 `install()` 刷新 host-env、指针与浏览器注册；若仍异常，设置页「重新安装组件」并重启浏览器。

Firefox：安装器提供已解压扩展目录；正式持久安装需 Mozilla 签名 XPI（见 `docs/browser-bridge-firefox-amo.md`）。

## 桌面端正文提取模块

| 模块 | 职责 |
|------|------|
| `electron/utils/readability-extract.ts` | Mozilla Readability（与 web_fetch 共用） |
| `electron/utils/html-article-extract.ts` | DOM 启发式 fallback（原 article-extract.js） |
| `electron/utils/page-content-extract.ts` | 统一编排：Readability → 启发式 → plain fallback |

## 依赖

- `electron/services/agent/skills/browser/` — attach 模式执行器
- `{userData}/browser-bridge/gateway.json` — TCP 端口与 token（随运行更新）
- `$HOME/.sailfish-browser-bridge.json` — 当前 `{userData}` 下的 bridge 根路径指针

## 测试

- `electron/services/browser-bridge/__tests__/protocol.test.ts`
- `electron/utils/__tests__/html-article-extract.test.ts`
- `electron/utils/__tests__/page-content-extract.test.ts`
- `electron/utils/__tests__/readability-extract.test.ts`
- `electron/services/agent/skills/browser/__tests__/bridge-session.test.ts`

## 扩展发版策略

- **1.1.0** = protocol v1 基线（薄扩展 + 桌面端提取）
- **1.2.0** = Tab 原语最终版（`tabs` action + `shared/tabs-api.js`）；此后 Tab 策略（默认新开、后台开 tab、按 id 关闭等）**只在桌面端改**，扩展不再为 Tab 行为发版
- 此后功能迭代优先改 SailFish App；扩展仅在 permissions / 浏览器 API breaking change / DOM 原语（content script）时发版
- AMO 建议 Unlisted 分发（见 `docs/browser-bridge-firefox-amo.md`）
