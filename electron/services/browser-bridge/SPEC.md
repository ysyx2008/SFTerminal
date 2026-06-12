# Browser Bridge 服务 SPEC

> Last verified: 2026-06-11

## 职责

让用户 **已打开** 的 Chrome / Edge / Firefox 标签页与登录态可被 Agent 复用。通过浏览器扩展 + Native Messaging Host + Electron TCP 网关实现，扩展随旗鱼安装器部署（不上架商店）。

## 架构

```
Agent browser_* (attach 模式)
    ↕
BrowserBridgeService (Electron TCP :随机端口)
    ↕
native-host/host.mjs (Chrome 按连接 spawn)
    ↕ Native Messaging (stdin/stdout)
扩展 background.js → content.js (DOM / 快照)
```

## 公开契约

### IPC

| Channel | 说明 |
|---------|------|
| `browserBridge:getStatus` | 返回 `BrowserBridgeStatus` |
| `browserBridge:install` | 复制扩展、写 manifest、注册 Native Host |
| `browserBridge:uninstall` | 移除 Native Host 注册与本机扩展文件 |
| `browserBridge:openExtensionGuide` | 用对应浏览器打开扩展管理页（`chrome://` 等内部 URL） |

### Agent 集成

- `browser_launch` 增加 `attach: true` 或 `mode: 'attach'`：连接用户浏览器，不启动 Playwright
- `browser_launch.browser`：`auto` | `firefox` | `chromium`（`chrome`/`edge` 别名）；双开时必须显式指定；会话绑定后后续 `browser_*` 走同一路由
- attach 会话存于 `bridge-session.ts`（含 `origin` + `browserTarget`），与 Playwright `session.ts` 并行
- 未 attach 时行为不变

### Native Host 名

固定 `com.sailfish.browser`（见 `shared/types/browser-bridge.ts`）。

### 扩展 ID

- Chromium：`ocdljfppijcjpgaaamgeailkgajgjdml`（manifest `key` 固定）
- Firefox：`sailfish-browser-bridge@yushen.dev`

## 安装

1. 从 `resources/browser-bridge/` 复制到 `{userData}/browser-bridge/`（`userData` 随「数据管理」自定义目录变化，见 `bootstrap.ts`）
2. 写 `{userData}/browser-bridge/native-host/com.sailfish.browser.json` 并注册 NativeMessagingHosts（macOS 覆盖 Chrome / **Arc** / Brave / Edge / Chromium / Vivaldi / Opera 等各自目录）
   - **Chromium 系**：manifest 用 `allowed_origins`（`chrome-extension://…/`）
   - **Firefox**：manifest 用 `allowed_extensions`（扩展 ID 字符串，如 `sailfish-browser-bridge@yushen.dev`）
3. 写 `$HOME/.sailfish-browser-bridge.json` 指针（供 Chrome 拉起的 host 进程定位当前 gateway，**不硬编码** SFTerm/SailFish 路径）
4. macOS：`clang` 编译 `{Electron.app}/Contents/Helpers/sailfish-browser-host` Mach-O（与 Claude 同款路径；Chrome 无法稳定拉起 `$HOME` 下的 host）；manifest **按浏览器拆分**（Chrome 仅 `chrome-extension://`，Firefox 仅 `moz-extension://`）
5. Windows host 启动：`ELECTRON_RUN_AS_NODE=1` + 应用可执行文件 + `host.mjs`

**迁移/修改数据目录后**：启动时会 `install()` 刷新 host-env、指针与浏览器注册；若仍异常，设置页「重新安装组件」并重启浏览器。

Firefox：安装器提供已解压扩展目录；正式持久安装需 Mozilla 签名 XPI（见 `scripts/sign-firefox-extension.md`）。

## 依赖

- `electron/services/agent/skills/browser/` — attach 模式执行器
- `{userData}/browser-bridge/gateway.json` — TCP 端口与 token（随运行更新）
- `$HOME/.sailfish-browser-bridge.json` — 当前 `{userData}` 下的 bridge 根路径指针

## 测试

- `electron/services/browser-bridge/__tests__/protocol.test.ts`
- `electron/services/agent/skills/browser/__tests__/bridge-session.test.ts`
