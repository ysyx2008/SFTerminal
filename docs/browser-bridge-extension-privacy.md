# SailFish Browser Assistant — Privacy Policy / 旗鱼浏览器助手 — 隐私政策

> **Public URLs (after website deploy):**
> - English: https://www.sfterm.com/browser-assistant-privacy/
> - 中文: https://www.sfterm.com/zh/browser-assistant-privacy/
>
> **Effective date / 生效日期:** 2026-06-13

---

## English

### 1. Scope

This Privacy Policy applies to the **SailFish Browser Assistant** browser extension (“Extension”) for Chromium and Firefox. The Extension is a **companion** to the SailFish desktop application (“SailFish App”). It does **not** work on its own.

### 2. Summary

- The Extension **does not** send your data to the Extension author’s servers.
- The Extension communicates **only** with the SailFish App on **your computer** via the browser’s Native Messaging API.
- Page content is accessed **only when you** run a browser task through the SailFish App.

### 3. Data the Extension May Access

When you use browser automation (attach mode) in SailFish, the Extension may access, on the **active tab you are using**:

| Data | Purpose |
|------|---------|
| Page URL and title | List tabs, navigate, report context to the Agent |
| DOM structure / text (accessibility-style snapshot) | Let the Agent understand the page and choose actions |
| Interaction targets (buttons, links, inputs) | Perform clicks, typing, and form actions you request |

The Extension does not run this access in the background for advertising, profiling, or analytics.

### 4. How Data Flows

```
Your browser tab → Extension (local) → Native Messaging Host (local) → SailFish App (local)
```

All of the above runs on **your device**. The Extension author does not operate a cloud service that receives this data.

What happens **after** data reaches the SailFish App (for example, sending prompts to an AI provider you configured) is governed by the **SailFish App** and that provider’s policies—not by this Extension alone. For AI provider privacy comparisons, see [SailFish data privacy guide](https://www.sfterm.com/data-privacy/).

### 5. Permissions

| Permission | Why it is needed |
|------------|------------------|
| `nativeMessaging` | Talk to the local SailFish Native Host only |
| `tabs` | List and switch tabs in your browser |
| `scripting` / `activeTab` | Read page snapshots and run actions on the current tab when the Agent requests it |
| `<all_urls>` | Operate on pages you ask the Agent to open or control (not limited to one site) |
| `storage` | Remember local connection status (e.g. bridge connected) |
| `alarms` | Keep the local bridge connection healthy |

### 6. What We Do Not Do

- We do **not** sell your data.
- We do **not** use Extension data for advertising or cross-site tracking.
- We do **not** upload page content to Extension author servers.
- We do **not** collect data when the Extension is installed but SailFish is not running a browser task.

### 7. Retention

The Extension does not maintain a remote datastore. Temporary data exists in browser memory and local extension storage during use. The SailFish App may retain conversation or task history according to **your** SailFish settings.

### 8. Your Choices

- **Uninstall** the Extension or disable it in the browser at any time.
- **Do not install** the Native Host in SailFish if you do not want attach mode.
- Use SailFish’s **launch mode** (separate Playwright window) without the Extension.
- Control AI-related data sharing in SailFish App settings and your choice of AI provider.

### 9. Children

The Extension is not directed at children under 13 (or the minimum age in your jurisdiction). We do not knowingly collect personal information from children through the Extension.

### 10. Changes

We may update this policy. The “Effective date” at the top will change when we do. Continued use after an update means you accept the revised policy.

### 11. Contact

- Website: https://www.sfterm.com/
- Source / issues: https://github.com/ysyx2008/SailFish

---

## 中文

### 1. 适用范围

本隐私政策适用于 **旗鱼浏览器助手**（SailFish Browser Assistant）浏览器扩展（以下简称「扩展」），包括 Chromium 系与 Firefox 版本。本扩展是 **旗鱼桌面应用**（以下简称「旗鱼」）的伴侣组件，**不能单独使用**。

### 2. 摘要

- 扩展 **不会** 将您的数据发送至扩展作者的服务器。
- 扩展仅通过浏览器 **Native Messaging**，与 **您本机** 的旗鱼通信。
- 仅在 **您通过旗鱼发起浏览器任务** 时，扩展才会访问页面内容。

### 3. 扩展可能访问的数据

当您在旗鱼中使用浏览器 attach 模式时，扩展可能访问 **您正在使用的活动标签页** 中的：

| 数据 | 用途 |
|------|------|
| 页面 URL、标题 | 列出标签、导航、向 Agent 提供上下文 |
| 页面 DOM 结构 / 文本（无障碍树式快照） | 供 Agent 理解页面并选择操作 |
| 可交互元素（按钮、链接、输入框等） | 执行您要求的点击、输入等操作 |

扩展不会出于广告、用户画像或统计分析而在后台持续采集上述数据。

### 4. 数据如何流动

```
浏览器标签页 → 扩展（本机）→ Native Host（本机）→ 旗鱼（本机）
```

以上环节均在 **您的设备** 上完成。扩展作者不运营接收该数据的云端服务。

数据进入旗鱼之后（例如您配置的 AI 服务商处理对话），由 **旗鱼主程序** 及该服务商的政策约束，不属于本扩展单独管辖。关于 AI 服务商隐私对比，可参考 [旗鱼数据安全与隐私说明](https://www.sfterm.com/zh/data-privacy/)（该页面为第三方 AI 服务商科普，非本扩展专用政策）。

### 5. 权限说明

| 权限 | 用途 |
|------|------|
| `nativeMessaging` | 仅与本机旗鱼 Native Host 通信 |
| `tabs` | 列出、切换浏览器标签页 |
| `scripting` / `activeTab` | 在 Agent 请求时读取页面快照并执行操作 |
| `<all_urls>` | 对您指定 Agent 操作的网页生效（不限于单一网站） |
| `storage` | 保存本地连接状态（如桥接已连接） |
| `alarms` | 维持本地桥接连接 |

### 6. 我们不会

- **出售** 您的数据；
- 将扩展数据用于 **广告** 或跨站追踪；
- 将页面内容上载至扩展作者服务器；
- 在扩展已安装但未通过旗鱼执行浏览器任务时采集数据。

### 7. 数据保留

扩展不维护远程数据库。使用过程中的临时数据存在于浏览器内存及扩展本地存储中。旗鱼可能根据 **您的设置** 保留对话或任务历史。

### 8. 您的选择

- 随时在浏览器中 **禁用或卸载** 扩展；
- 不在旗鱼中安装 Native Host，即可不使用 attach 模式；
- 使用旗鱼 **launch 模式**（独立 Playwright 窗口），无需本扩展；
- 在旗鱼设置中选择 AI 服务商并控制相关数据共享。

### 9. 儿童

本扩展不面向 13 岁以下儿童（或您所在司法辖区规定的最低年龄）。我们不会在扩展中故意收集儿童个人信息。

### 10. 政策变更

我们可能更新本政策。更新时会修改文首「生效日期」。更新后继续使用即视为接受修订内容。

### 11. 联系我们

- 官网：https://www.sfterm.com/
- 源码与反馈：https://github.com/ysyx2008/SailFish
