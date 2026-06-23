# Chrome Web Store 发布包（与开发目录分离）

本目录**仅用于** Chrome Web Store 上架，不影响 `../chromium/` 的临时加载开发测试。

## 关系

| 目录 | 用途 |
|------|------|
| `../chromium/` | 旗鱼安装器复制、chrome://extensions 临时加载、日常联调 |
| `chromium-cws-publish/` | CWS 专用 manifest + 图标；打包时覆盖到构建目录 |

打包脚本会：

1. 复制 `../chromium/` 全部 JS/HTML（开发版逻辑）
2. 用本目录的 `manifest.json` 和 `icons/` 覆盖
3. 输出 zip 到 `../dist/`

```bash
npm run pack:chrome-extension
```

扩展 ID 说明：

- **开发目录** `../chromium/manifest.json` 保留 `key` 字段，本地临时加载时 ID 为 `ocdljfppijcjpgaaamgeailkgajgjdml`
- **CWS 上架包** manifest **不得**包含 `key`（商店会拒绝）；商店 ID 为 `dgmhdapfpihhkboikpgfanpgnijbpdhd`
- Native Host 的 `allowed_origins` 在 `shared/types/browser-bridge.ts` 中同时注册开发与商店 ID
