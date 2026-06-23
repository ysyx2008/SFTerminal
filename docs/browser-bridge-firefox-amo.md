# Firefox 扩展上架 AMO 指南

SailFish 浏览器助手 Firefox 版需 **Mozilla 签名** 才能持久安装（临时加载重启会丢失）。

相比 Chrome Web Store，AMO 流程更轻：**注册开发者账号 → 上传 zip → 选分发方式 → 等自动/人工审核 → 拿到签名 XPI**。

## 1. 打包

```bash
npm run pack:firefox-extension
# 输出：resources/browser-bridge/dist/sailfish-browser-assistant-firefox-1.1.0.zip
```

打包**不会修改** `resources/browser-bridge/firefox/`（临时加载开发目录）。  
AMO 专用 manifest 与图标在 `resources/browser-bridge/firefox-amo-publish/`，打包时复制开发版 JS 再覆盖 AMO 元数据。

## 2. 注册与提交

1. 打开 [Firefox Add-on Developer Hub](https://addons.mozilla.org/developers/)
2. **Submit a New Add-on** → 上传上面的 zip
3. 选择分发方式（见下节）
4. 填写版本说明、权限说明（见「审核说明模板」）
5. `manifest.json` 须含 `data_collection_permissions`（填 `required: ["none"]`），且 `strict_min_version` ≥ **140**（与 Mozilla 内置数据声明配套）
6. 提交时一般只勾选 **Firefox 桌面版**（本扩展依赖 Native Host + 旗鱼桌面版，不支持 Android）

## 3. 分发方式怎么选

| 方式 | 适用 | 说明 |
|------|------|------|
| **On this site（公开上架）** | 希望用户在 AMO 搜索安装 | 需完善商店页、隐私政策；用户仍须安装 SailFish 桌面版 + Native Host |
| **On your own（Unlisted / 自分发）** | **推荐** — 仅旗鱼用户 | 签名后 AMO 给**私有下载链接**；可放官网 / 设置页引导；不上公开搜索 |

本扩展是 **SailFish 桌面伴侣**，必须配合 Native Host（`com.sailfish.browser`）和旗鱼 App 才能工作，**建议选 Unlisted**，避免用户单独安装扩展却无法使用。

## 4. 固定扩展 ID（勿改）

```
sailfish-browser-bridge@yushen.dev
```

`manifest.json` → `browser_specific_settings.gecko.id`。  
旗鱼安装器 Native Host manifest 的 `allowed_origins` 已写死此 ID，**上架后不能改 ID**，否则需用户重新安装组件。

## 5. 审核说明模板（复制到 AMO 备注）

**English (for reviewers):**

```
SailFish Browser Assistant is a companion extension for the SailFish desktop AI Agent app (https://www.sfterm.com/).

It connects to a locally installed Native Messaging host (com.sailfish.browser) registered by the SailFish desktop installer. No remote server receives page content unless the user explicitly runs an Agent task in SailFish.

Permissions:
- nativeMessaging: talk to local SailFish app only
- tabs / scripting / activeTab / <all_urls>: read DOM snapshots and perform clicks/types requested by the user's local Agent

The extension is useless without the SailFish desktop app and native host. Data stays on the user's machine.
```

**中文（给用户看的版本说明）：**

```
旗鱼浏览器助手 — SailFish 桌面 Agent 的 Firefox 伴侣扩展。
需安装旗鱼桌面版并完成「设置 → 浏览器助手」中的 Native Host 注册。
扩展通过本机 Native Messaging 与旗鱼通信，页面内容不上传至扩展作者服务器。
```

## 6. 隐私政策

扩展专用隐私政策（**不是** `/data-privacy/` AI 服务商科普页）：

- 英文：https://www.sfterm.com/browser-assistant-privacy/
- 中文：https://www.sfterm.com/zh/browser-assistant-privacy/

源码：`docs/browser-bridge-extension-privacy.md`（与官网同步）

## 7. 商店页面

- 列表页：https://addons.mozilla.org/firefox/addon/sailfish-browser-assistant/
- 设置页按钮 URL：`shared/types/browser-bridge.ts` → `BROWSER_BRIDGE_FIREFOX_AMO_LISTING_URL`

## 8. 签名完成后

1. 从 AMO 下载 **signed .xpi**
2. 可选：放入 `resources/browser-bridge/firefox/dist/` 并在后续版本安装器里支持一键安装
3. 用户安装方式：
   - Firefox → 扩展 → 齿轮 → **Install Add-on From File…** 选 .xpi  
   - 或 `firefox -install-global-extension sailfish-browser-assistant.xpi`（企业部署）

### ⚠️ 安装后须开启「访问所有网站数据」

Firefox MV3 将 `host_permissions`（含 `<all_urls>`）视为**可选权限**，安装后**默认可能未授予**。未开启时 Native Messaging 仍可连通（设置页可能显示「已连接」），但 Agent **无法**读取页面、快照、点击或跨标签操作。

**方式 A — 扩展弹出窗口（推荐，v1.2.2+）**

1. 点击工具栏上的 SailFish Browser Assistant 图标
2. 若提示 *Site access required*，点击 **Grant site access** 并在浏览器确认

**方式 B — 扩展管理页**

1. 地址栏打开 `about:addons`
2. 进入 **SailFish Browser Assistant** → **权限（Permissions）**
3. 开启 **访问您在所有网站的数据**（*Access your data for all websites*）
4. 回到旗鱼 **设置 → 浏览器助手** 点「刷新状态」；刷新需要 Agent 操作的标签页

旗鱼设置页 Firefox 卡片与故障排查章节也有相同说明；扩展 `ping` 会上报 `hostPermissionsGranted`，桌面端可检测并提示。

## 9. 更新版本

1. 改 `resources/browser-bridge/firefox-amo-publish/manifest.json` 的 `version`（开发目录 `firefox/manifest.json` 的 version 建议同步，扩展 ID 必须一致）
2. 重新 `npm run pack:firefox-extension`
3. AMO 开发者中心 → 该扩展 → **Upload New Version**

### ⚠️ Firefox MV3 与 `importScripts`

Firefox MV3 的 background 使用 **event page**（`background.scripts`），**不是** Service Worker，因此 **`importScripts()` 不可用**。

AMO 包的 `manifest.json` 必须同时列出：

```json
"background": {
  "scripts": ["shared/tabs-api.js", "background-firefox.js"]
}
```

若只列 `background-firefox.js` 并在其内 `importScripts('shared/tabs-api.js')`，background 会在启动时抛错，扩展完全无法连接 Native Host。打包脚本会在缺少双脚本时直接失败。

## 参考

- [Signing and distribution overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
- [Submitting an add-on](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)
