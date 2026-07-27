# Speech（本地语音识别）SPEC

> Last verified: 2026-07-27

## 职责

在桌面端提供**可选**的本地语音转写（STT）：麦克风采集 → sherpa-onnx（Paraformer）识别 → 可选标点恢复，供输入框语音输入使用。推理在 `utilityProcess` worker 中运行，避免阻塞主进程。

## 设计目标

来自 2026-07-23 讨论确认；2026-07-27 补充：未装时禁用 PTT 快捷键；下载安装进度展示速度与预计剩余时间；下载不随设置页关闭中断。

### 要解决的问题

- 语音模型（ASR ~217MB + 标点 ~76MB）随安装包分发，约占打包体积一半，成本过高。
- 系统/输入法听写日益普及，内置 ASR 不再是一等刚需；效果「还行」但不足以当作差异化卖点。
- 仍需保留**离线本地识别**能力，并照顾**无公网的内网用户**。
- 模型与应用代码分离后，必须防止不兼容权重被强行加载。

### 成功标准

- 默认安装包**不再**包含语音模型；有网用户可在设置页一键安装。
- ASR + 标点打成**一个**版本化 pack，国内 OSS / 国外 GitHub 双源。
- 内网用户可通过**同一 pack 的本地导入**安装；设置页提供离线包下载链接。
- pack 带 `manifest`（`format` + `packVersion`）；应用只加载兼容 format，拒绝不匹配包。
- 推理代码仍在应用内；模型在 `userData`，靠契约对齐，而不是做成插件。
- 未安装时麦克风/按住说话**不静默失败**：toast 引导并打开设置 → AI → 语音识别模型区块。

### 关键取舍

| 选择 | 放弃 | 原因 |
|---|---|---|
| 按需组件 + 轻量 manifest | 做成插件 / SpeechProvider 一等公民 | 插件解决不了「只有权重」的问题 |
| ASR+标点合并单一 pack | 拆成两个独立下载 | 安装心智简单 |
| 设置页：在线安装 + 本地导入 + 双源链接 | 官网下载区（本期） | 设置页覆盖主路径 |
| GitHub 独立 tag `speech-pack-v{ver}` | 挂每次应用 Release / 推进 git | 模型与应用版本解耦；URL 不可变 |
| `format` 校验，不主动推模型升级 | 完整组件更新通道 | 先挡住错载 |
| 查找：`userData` → `resources` | 仅单一路径 | 兼容开发态 / OEM / 过渡包 |
| 未装仍显示麦克风（快捷键开启时） | 隐藏按钮 | 可发现；点击引导安装 |
| 未装时禁用 PTT 快捷键 | 快捷键仍响应并反复 toast | Control 等键易被复制粘贴误触，反复弹「去安装」骚扰；麦克风点击仍可引导 |

### 升级与旧用户

- 若启动时 `resources` 仍有完整模型且 `userData` 没有 → 迁移拷贝到 `userData` 并写入 manifest。
- 从已不带模型的包升级上来：设置页重新安装一次。

### 明确不做（本期）

- 不把本地 ASR 做成插件，不实现 `registerSpeechProvider`。
- 不改官网下载区。
- 不做自定义镜像 URL。
- 不做云端 STT、不做系统听写深度集成。
- 不主动弹窗推销模型升级。
- 不投入优化识别质量。

## 行为契约

### Pack 契约

- 产物：`speech-pack-{ver}.zip`，内含 ASR、标点、根级 `manifest.json`。
- `manifest.json`：`id`（`speech-asr-punct`）、`format`（正整数）、`packVersion`、`asr`/`punct` 相对路径。
- GitHub：`releases/download/speech-pack-v{ver}/speech-pack-{ver}.zip`
- OSS：`optional/speech/speech-pack-{ver}.zip`
- 应用内 `SUPPORTED_SPEECH_PACK_FORMAT` 必须与 manifest `format` 相等才可加载。

### 安装与解析

- 落盘：`{userData}/models/speech/`。
- 在线：测速选 OSS/GitHub → 下载 → 解压 → 校验 manifest。
- 本地导入：同一 zip 格式。
- 卸载：删除 userData 中的 pack，并写入 `{userData}/models/speech-pack.opt-out`，**不再回落**到安装目录/开发 `resources` 里的模型；重新在线/本地安装时清除 opt-out。
- `isModelAvailable`：兼容 pack 完整且未 opt-out；否则引导设置页。

### UI / 快捷键

- 设置 → AI：「语音识别模型」：状态行 + 动作按钮；未安装时显示「下载安装 / 从本地安装」与离线包按钮（`window.open`，与 TTS「获取密钥」一致）；**已安装时只保留卸载**，不重复展示本地安装与离线链接。
- 下载安装进度：下载阶段展示已下/总量、速度与预计剩余时间；解压阶段仅显示阶段文案。
- **下载不随设置页关闭中断**：安装在主进程持续执行；设置页只订阅进度。关闭/切走设置后进度状态仍保留，再次打开可续看；若完成时设置页未打开则 toast 提示。
- 快捷键 `voiceInput`：配置可保留；**仅当模型已可用时**才响应按住说话。未装时快捷键静默无效（避免 Control 等键被复制粘贴误触后反复 toast）。
- 麦克风按钮未装：仍显示（快捷键开启时）；点击 toast + 打开设置 AI 并滚到该区块。
- 启动空闲预加载：仅当模型已可用时执行；挂载时不因「未装」主动 toast。

## 文件结构

| 路径 | 说明 |
|---|---|
| `index.ts` | 主进程 API：路径、initialize / transcribe、状态 |
| `pack.ts` | manifest、下载/导入/卸载、迁移 |
| `speech-worker.js` | utilityProcess：sherpa-onnx |
| `SPEC.md` | 本文件 |

## 公开 API

| 符号 | 用途 |
|---|---|
| `isModelAvailable()` | 兼容 pack 是否就绪 |
| `initialize()` / `transcribe()` / `dispose()` | 识别生命周期 |
| `getModelInfo()` / `getStatus()` / `isReady()` | 状态 |
| `getPackStatus()` / `installPack()` / `importPackFromPath()` / `uninstallPack()` | 按需安装 |
| `getPackDownloadUrls()` | 设置页离线链接 |
| `migrateBundledModelsIfNeeded()` | resources → userData |

## 依赖

- `sherpa-onnx-node`、`adm-zip`（经 `zip-extract`）
- Electron `utilityProcess`
- 下载源：阿里云 OSS + GitHub Releases（独立 `speech-pack-v*` tag）
