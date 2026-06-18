# Firefox 扩展签名（可选）

Firefox 要求持久安装的扩展必须经过 Mozilla 签名。开发阶段可在 `about:debugging` 临时加载。

**上架 AMO 完整步骤见 [browser-bridge-firefox-amo.md](./browser-bridge-firefox-amo.md)**。

快速流程：

1. `npm run pack:firefox-extension` 生成 zip（源：`firefox/` + 覆盖 `firefox-amo-publish/`）
2. 登录 [AMO 开发者中心](https://addons.mozilla.org/developers/) 上传
3. 推荐选 **Unlisted（自分发）** — 伴侣扩展需配合旗鱼桌面版
4. 下载签名 `.xpi` 分发给用户

扩展 ID 固定为 `sailfish-browser-bridge@yushen.dev`，与 `shared/types/browser-bridge.ts` 一致。
