# 应用内自动更新与阿里云 OSS 布局

本文描述 SailFish 桌面端的**应用内更新**（`electron-updater`）与**阿里云 OSS** 发布物布局。发版流程见 `.claude/skills/release/SKILL.md`；CI 上传见 `.github/workflows/build-release.yml` → `upload-oss`。

## 更新源

| 源 | 用途 | 元数据 |
|----|------|--------|
| GitHub Releases | 国际用户、差分 blockmap 历史齐全 | `latest.yml` / `latest-mac.yml` / `latest-linux.yml` |
| 阿里云 OSS `releases/` | 国内加速（`electron/main.ts` 测速选源） | 同上，路径见下文 |

Steam 构建（`VITE_STEAM_BUILD`）跳过应用内更新。

## OSS 桶：两套路径

桶名：`oss://sfterm-download`  
公网：`https://sfterm-download.oss-cn-wuhan-lr.aliyuncs.com/`

**勿混用**：官网下载与自动更新使用不同目录与命名规则。

### 桶根目录 — 官网手动下载（无版本号）

每次发版 `ossutil cp -f` **覆盖**，始终只有最新一份。

| 对象 | 平台 |
|------|------|
| `SailFish-Setup.exe` | Windows NSIS |
| `SailFish-x64.zip` | Windows 便携 zip（若有） |
| `SailFish-arm64.dmg` / `SailFish-x64.dmg` | macOS |
| `SailFish.AppImage` / `SailFish.deb` | Linux |

用户从官网点「下载」走这里；**不参与**差分更新逻辑。

### `releases/` — 应用内自动更新（带版本号）

`electron-updater` 读取 `releases/latest.yml`（mac/linux 为 `latest-mac.yml` / `latest-linux.yml`）。  
`latest.yml` 中的 `path` 为**带版本号**的安装包，例如 `SailFish-Setup-10.43.2.exe`。

| 对象 | 保留策略 |
|------|----------|
| `latest*.yml`、`release-meta.json` | 每次覆盖为最新 |
| 完整安装包（`.exe` / `.dmg` / `.zip` / `.AppImage`） | **`releases/` 内只保留当前最新版**（约 620MB/个，省存储） |
| `*.blockmap` | **永久保留**（约 600KB/个；**勿**对 blockmap 配置 OSS 生命周期删除） |

发版 CI 在上传完成后执行 `scripts/clean-oss-old-installers.sh`：删除 `releases/` 下旧版完整包，**不删 blockmap**，**不碰桶根目录**固定名文件。

## 差分更新如何工作（Windows）

1. 客户端 `electron-updater` 读取 `latest.yml`，发现新版本。
2. 下载**新版**与**旧版** `.blockmap`（旧版 URL 由文件名中的版本号替换得到，例如 `10.43.1` → `10.43.2`）。
3. 从本机 `%LOCALAPPDATA%/{updaterCacheDirName}/installer.exe` 复制未变块（NSIS 安装/更新时写入）。
4. 通过 HTTP Range 从 OSS/GitHub 上的**新版完整包**只拉取变更块，组装新安装包。

若旧 blockmap 404、本机无 `installer.exe`、或 Range 失败 → 静默回退**全量下载**（进度总量 ≈ 完整 exe 大小）。

**国内 OSS 曾长期全量的常见原因**：`releases/` 只留了最新安装包、没有历史 blockmap；现策略为 blockmap 永久累积。

## 平台差异

| 平台 | 应用内下载 | 差分 | 说明 |
|------|-----------|------|------|
| Windows | ✅ | ✅（条件满足时） | NSIS + blockmap |
| Linux | ✅ | 类似机制 | AppImage + blockmap |
| macOS | ❌ | — | 无 zip 目标、无公证；UI 引导官网下 DMG |

mac 相关代码：`src/composables/useAppUpdaterPrompts.ts`、`SettingsModal.vue`（`isMac` 分支）。

## 相关文件

| 文件 | 职责 |
|------|------|
| `electron/main.ts` | `autoUpdater`、GitHub/OSS 双源、IPC |
| `.github/workflows/build-release.yml` | 构建 + 上传 OSS + 调用清理脚本 |
| `scripts/clean-oss-old-installers.sh` | 清理 `releases/` 旧版完整包 |
| `scripts/generate-release-meta.js` | 更新弹窗版本摘要 |

## 维护注意

- 修改 OSS 布局或清理规则时，**同步更新本文**。
- 不要在 OSS 控制台对 `releases/*.blockmap` 设自动过期。
- 桶根目录固定名文件与 `releases/` 版本化文件职责不同，改 CI 时对照本文两节表格。
