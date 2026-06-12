# Firefox 扩展上架 AMO 指南

SailFish 浏览器助手 Firefox 版需 **Mozilla 签名** 才能持久安装（临时加载重启会丢失）。

相比 Chrome Web Store，AMO 流程更轻：**注册开发者账号 → 上传 zip → 选分发方式 → 等自动/人工审核 → 拿到签名 XPI**。

## 1. 打包

```bash
npm run pack:firefox-extension
# 输出：resources/browser-bridge/dist/sailfish-browser-assistant-firefox-1.0.0.zip
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

## 9. 更新版本

1. 改 `resources/browser-bridge/firefox-amo-publish/manifest.json` 的 `version`（开发目录 `firefox/manifest.json` 的 version 建议同步，扩展 ID 必须一致）
2. 重新 `npm run pack:firefox-extension`
3. AMO 开发者中心 → 该扩展 → **Upload New Version**

## 参考

- [Signing and distribution overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
- [Submitting an add-on](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)
