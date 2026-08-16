# 崩溃诊断与一键上报（P0：可诊断）设计

> 一次性 plan 文档。完成后取舍升华进 `electron/services/diagnostics/SPEC.md`，本文件删除。

## 1. 背景

11.6.0 Windows 用户反馈频繁崩溃：「主程序昨天闪退三次，子程序崩溃不知道多少次」。

当前诊断能力的空缺：

- 只有 `electron-log` 文件日志（`{userData}/logs/YYYY-MM-DD.log`），**没有 `crashReporter`**——原生崩溃（node-pty / onnxruntime / lancedb / GPU 驱动）不经过 JS，进程直接消失，日志最后一行只是崩溃前的正常业务日志，看不出原因。
- **没有监听** `render-process-gone` / `child-process-gone`，渲染进程与 utilityProcess 崩溃对我们完全不可见。四个 utilityProcess（embedding / lancedb / speech / pdf worker）各自只在 `exit` 里打一行 info 日志，没有统一记录，无法统计。
- 没有「上次是否异常退出」的判定，无法回答「闪退了几次」，也无法在下次启动时补发上报（崩溃当时发不出任何东西）。
- 用户要发日志只能手动去 `%APPDATA%` 翻目录（设置页只有「打开日志目录」按钮）。

## 2. 目标与不做的事

**做（P0）**

1. 崩溃能留下现场：minidump + 结构化崩溃事件记录。
2. 崩溃能被计数：区分正常退出与异常退出，记录连续异常退出次数。
3. **崩溃后主动找用户**，而不是等用户翻设置页：能立即弹的立即弹，主程序闪退则下次启动补弹。
4. 用户能一键把现场交出来，且**主动作是「复制崩溃摘要」**（一段几十行的脱敏文本，用户直接粘到群里），生成完整诊断包 zip 作为次动作。
5. 上报通道留出接口，但本版不接服务端。

**不做（明确留给下一版）**

- 安全模式 / 连续崩溃自动降级（已与用户确认下版再做）。
- 服务端上传端点、邮件转发、OSS 直传。
- 诊断包内容预览界面（用户确认：只脱敏，不做预览）。
- 修改四个 utilityProcess 的 worker 代码——用 `app.on('child-process-gone')` 在主进程统一捕获，零侵入。
- hang（无响应）检测。用户口中的「崩溃」可能包含卡死，但那是另一套手段（`unresponsive` 事件 + 采样），不在本版。

## 3. 崩溃分类与采集手段

| 现象 | 进程 | 采集手段 | 能拿到什么 |
|---|---|---|---|
| 主程序闪退 | browser | Crashpad minidump + 「上次异常退出」标记 | minidump（可还原崩溃栈）、崩溃前日志、退出计数 |
| 界面白屏 / 重载 | renderer | `app.on('render-process-gone')` | reason、exitCode、minidump |
| 产出物预览崩溃 | renderer(webview) | 同上（webview 是独立渲染进程） | 同上 |
| 「子程序崩溃」 | utility | `app.on('child-process-gone')`（`type: 'Utility'`，带 serviceName） | 是哪个 worker（embedding / lancedb / speech / pdf）、reason、minidump |
| GPU 崩溃 | gpu | `child-process-gone`（`type: 'GPU'`） | reason；结合 GPU 信息判断驱动问题 |
| JS 未捕获异常 | browser | 已有 `uncaughtException` / `unhandledRejection` | 栈（现只打日志，改为同时记入崩溃事件） |

minidump 由 Crashpad 落到 `app.getPath('crashDumps')`，`uploadToServer: false` 时保留本地。事后可用 `electron-minidump` 配合 Electron 官方符号服务器还原崩溃栈——这是「日志发过来能看出原因」的关键，没有它，上报功能只是摆设。

## 4. 模块设计

新模块 `electron/services/diagnostics/`，OOP，对外只暴露服务实例 + 早期函数：

| 文件 | 职责 |
|---|---|
| `crash-recorder.ts` | `CrashRecorder`：崩溃事件追加写（JSONL）、正常退出标记读写、启动时判定上次是否异常退出并累计连续次数。**必须能在 app ready 前工作**，只依赖 `fs` + `app.getPath('userData')`，不得引入重依赖 |
| `diagnostics.service.ts` | `DiagnosticsService`：汇总环境信息、挑选要打包的文件、调 redact 脱敏、用 `archiver` 打 zip、返回结果；预留 `upload(pkgPath)` 接口（本版抛「未配置上报通道」） |
| `redact.ts` | 脱敏纯函数，无状态，独立可测 |
| `summary.ts` | 崩溃摘要文本生成，纯函数（崩溃事件 + 环境信息 + 最近日志行 → 一段脱敏文本），独立可测 |
| `crash-notifier.ts` | `CrashNotifier`：按 §7 的分场景决定提示形态，并承担节流与「不再提示」；渲染进程崩溃走原生 dialog，其余走应用内提示 |
| `SPEC.md` | 设计目标 + 行为契约（实现前先写设计目标） |

改动的既有文件：

| 文件 | 改动 |
|---|---|
| `electron/main.ts` | ① `crashReporter.start({ uploadToServer: false })` 放在 bootstrap import 之后、`app.whenReady` 之前的最早期；② 注册 `render-process-gone` / `child-process-gone` → CrashRecorder；③ `uncaughtException` / `unhandledRejection` 兼记崩溃事件；④ `app.on('quit')` 写正常退出标记；⑤ 启动早期调 `markStartup()` 判定上次异常退出；⑥ 三个 IPC handler |
| `electron/preload.ts` | 暴露 `diagnostics.*` |
| `src/vite-env.d.ts` | 补类型声明 |
| `src/components/Settings/DiagnosticsSettings.vue` | 上次异常退出横幅 + 「生成诊断包」按钮 + 生成后「打开所在目录 / 复制路径」 |
| `src/i18n/locales/{zh-CN,en-US}/settings.ts` | 文案（中英同步） |

IPC 契约（薄封装）：

- `diagnostics:getCrashSummary` → `{ lastExitWasCrash, consecutiveCrashCount, recentEvents, dumpCount }`
- `diagnostics:getSummaryText` → 摘要纯文本（前端负责写剪贴板并给出「已复制」反馈）
- `diagnostics:createPackage` → `{ success, filePath?, sizeBytes?, error? }`
- `diagnostics:revealPackage(filePath)` → 打开所在目录
- `diagnostics:setNotifyEnabled(enabled)` → 提示开关

主进程 → 前端事件：`diagnostics:crash-detected`（携带崩溃事件 + 是否为「上次异常退出」补弹），前端据此展示提示。

## 5. 数据格式

`{userData}/diagnostics/` 下：

- `runtime-state.json`：`{ lastCleanExit: boolean, lastStartAt, lastVersion, consecutiveCrashCount }`。启动时读→判定→重置为「本次运行中」；`app.on('quit')` 置 `lastCleanExit: true`。
- `crash-events.jsonl`：每行一条崩溃事件 `{ at, appVersion, platform, kind, processType, serviceName?, reason?, exitCode?, message? }`。追加写，按条数上限滚动（保留最近 200 条），避免高频崩溃把文件写爆。

诊断包 `sailfish-diagnostics-{version}-{yyyyMMdd-HHmm}.zip` 结构：

```
summary.json         版本/平台/OS build/架构/是否打包/启动次数/连续崩溃数/GPU 特性状态
crash-events.jsonl   脱敏后的崩溃事件
logs/                最近 7 天的 *.log（脱敏后写入）
crashDumps/          最近 5 个 .dmp（二进制，不脱敏，体积上限约 50MB）
```

`summary.json` 里的环境信息：`app.getVersion()`、`process.versions`、`os.release()`、`os.arch()`、内存、`app.getGPUFeatureStatus()`、显卡信息（`app.getGPUInfo('basic')`）、是否自定义数据目录。**不含**任何账号、凭据、AI Profile 明细。

## 6. 脱敏策略

**原则：以「运行时已知真实值的精确字符串替换」为主，不写猜测语义的关键词正则**（项目禁止脆弱的关键词匹配代码）。

替换来源都是运行时确定可知的具体值：

- `os.homedir()` → `~`；`os.hostname()` → `<HOST>`；`os.userInfo().username` → `<USER>`
- 已配置的 SSH 主机名 / 登录用户名 → `<SSH_HOST>` / `<SSH_USER>`（从主机配置读取真实值再精确替换）
- 已配置的 AI baseURL 主机名 → `<AI_ENDPOINT>`

仅保留一条形态明确、无歧义的兜底正则：常见 API Key 前缀形态（如 `sk-` 后接长串）整体替换为 `<REDACTED>`。这是对「日志里意外打印了密钥」的兜底，不是语义猜测。

凭据本身不做「读出来再替换」——不从 CredentialService 取明文进内存做匹配，避免为了脱敏反而把密钥读进日志处理链路。

AI 对话内容：本版不单独剥离（用户选择「只脱敏」）。日志级别默认 `warn`/文件 `info`，正常不含对话正文；`aiDebug` 的日志目录**不纳入**诊断包（那里才是对话原文所在）。这条要写进 SPEC 的行为承诺。

## 7. 崩溃提示与「复制崩溃摘要」

### 7.1 为什么必须分场景

主进程崩溃时进程已经死了，没有任何 JS 能弹窗——「崩溃时弹窗」只对主进程还活着的那几类崩溃成立。分场景决定提示形态：

| 崩溃类型 | 主进程状态 | 提示形态 | 理由 |
|---|---|---|---|
| 主程序闪退 | 已死 | **下次启动后**弹应用内窗体 | 当时弹不出来，只能靠异常退出标记补弹 |
| 渲染进程 / webview 崩溃 | 活着，但界面已白屏 | **立即弹原生 `dialog`** | 界面本身不可用，应用内 UI 弹不出来；按钮含「重新加载界面」可当场自愈 |
| GPU 崩溃 | 活着 | 只记录，连续多次才提示 | Chromium 通常能自恢复，弹了是噪音 |
| utilityProcess 崩溃 | 活着 | 应用内轻量提示，说明哪个功能暂不可用 | 用户当前感受是「功能坏了」而非「软件崩了」，不该用阻塞弹窗打断手上的活 |
| JS 未捕获异常 | 活着 | 只记录，不提示 | 量大，弹窗会淹没用户 |

原生 dialog 用于渲染进程崩溃这一条很关键：那种情况下应用内组件已经不可信，只有主进程的原生窗体一定弹得出来。

### 7.2 防打扰（这条比弹窗本身更重要）

用户已经「崩得怀疑人生」，再被弹窗轰炸就会直接卸载。硬约束：

- 同一类型 + 同一 serviceName 的崩溃，10 分钟内只提示一次，其余静默计数。
- 单次运行内提示总数上限 3 次，超出只记录。
- 每个提示都带「本次运行不再提示」，且有全局开关（默认开启提示）。
- 提示措辞不推卸也不恐吓：说清「哪个部分崩了、影响什么、能做什么」，不要出现堆栈原文。

### 7.3 复制崩溃摘要

**主动作是复制，不是生成 zip。** 让用户在群里 Ctrl+V 就能交出关键信息，门槛比「翻目录找 zip 再发文件」低一个数量级，回流率完全不同。

摘要是脱敏后的几十行纯文本，形如：

```
SailFish 崩溃报告
版本: 11.6.0 (Windows 10.0.22631 x64)
时间: 2026-08-16 14:32:05
类型: 子进程崩溃 (Utility / embedding-worker)
原因: crashed, exitCode=-1073741819 (0xC0000005 访问违例)
本次运行崩溃: 3 次 | 连续异常退出: 2 次
GPU: 硬件加速开启 / <显卡与驱动版本>
minidump: 20260816-143205-a1b2c3.dmp（已保存在本机，可另行提供）
最近相关日志:
[14:32:04] [error] [Embedding] worker 意外退出 code=3221225477
...
```

exitCode 这类信息一眼就能判定是原生访问违例，而不是 JS 异常——摘要的价值就在这里，它让「用户随口一句崩了」变成可归类的证据。

摘要**不含** minidump 本体（那要走诊断包），但要报出 dump 文件名，方便后续索取。

顺带解决一个之前的取舍：复制的内容用户在剪贴板里直接可见，这本身就是最好的隐私透明——比做一个诊断包预览界面更省事也更可信。

### 7.4 设置页

设置 → 诊断页，在现有「日志级别 / 打开日志目录」之上加「崩溃诊断」区块：

- 检测到上次异常退出时显示横幅「上次运行异常退出（连续 N 次）」。
- 三个动作：「复制崩溃摘要」（主）、「生成诊断包」（次）、「打开所在目录 / 复制路径」（生成后出现）。
- 提示开关放这里。失败要显示原因，不静默。

## 8. 任务拆解（commit 粒度）

1. **SPEC + 崩溃记录内核**：`diagnostics/SPEC.md`（设计目标）、`crash-recorder.ts` + 单测（异常退出判定、连续计数、JSONL 滚动）。验收：`npx vitest run electron/services/diagnostics`。
2. **接入主进程采集**：`main.ts` 的 crashReporter 启动、三类崩溃事件监听、quit 标记。验收：手动 `process.crash()` / 杀掉 utility 进程后确认 `crash-events.jsonl` 与 crashDumps 有产出。
3. **摘要与诊断包生成**：`redact.ts` + `summary.ts` + `diagnostics.service.ts` + IPC + preload + 类型，含脱敏与摘要单测。验收：单测生成一份摘要文本与一个 zip，检查内容与脱敏结果。
4. **崩溃提示**：`crash-notifier.ts` + 节流规则单测 + 渲染进程崩溃的原生 dialog（含「重新加载界面」）+ 前端提示组件。验收：手动触发渲染进程崩溃（devtools kill / `process.crash()`），确认弹窗出现、能复制摘要、能重载界面；连续触发确认节流生效。
5. **前端诊断页**：UI + 提示开关 + 中英文案。验收：手动点一次，拿到摘要与 zip。
6. **回归**：`bash electron/cli/test-cli.sh --no-ai`，claude-review 审查。

## 9. 风险

- **crashReporter 启动时机**：必须早于任何窗口创建，否则早期崩溃抓不到；且要在 bootstrap 重定向 userData 之后，否则 dump 落到旧目录。
- **诊断包体积**：minidump 单个可能几十 MB，必须按「最近 5 个 + 总量上限」截断，否则 zip 大到没法发。
- **日志脱敏成本**：7 天日志可能上百 MB，脱敏是逐行字符串替换，必须流式处理且不在主线程同步跑（主进程响应性要求），用异步流 + 让出。
- **Windows 文件锁**：当天的 log 文件正被 electron-log 写入，读取用只读流，不做移动/重命名。
