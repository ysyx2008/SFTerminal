# Firefox AMO 发布包（与开发目录分离）

本目录**仅用于** Mozilla Add-ons 上架签名，不影响 `../firefox/` 的临时加载开发测试。

## 关系

| 目录 | 用途 |
|------|------|
| `../firefox/` | 旗鱼安装器复制、about:debugging 临时加载、日常联调 |
| `firefox-amo-publish/` | AMO 专用 manifest + 图标；打包时覆盖到构建目录 |

打包脚本会：

1. 复制 `../firefox/` 全部 JS/HTML（开发版逻辑）
2. 用本目录的 `manifest.json` 和 `icons/` 覆盖
3. 输出 zip 到 `../dist/`

```bash
npm run pack:firefox-extension
```

扩展 ID 必须与 `../firefox/manifest.json` 中的 `gecko.id` 一致。
