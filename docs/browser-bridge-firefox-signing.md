# Firefox 扩展签名（可选）

Firefox 要求持久安装的扩展必须经过 Mozilla 签名。开发阶段可在 `about:debugging` 临时加载。

正式分发步骤：

1. 注册 [Firefox Add-on Developer](https://addons.mozilla.org/developers/) 账号
2. 打包 `resources/browser-bridge/firefox/` 为 zip
3. 在 AMO 开发者中心提交 **Unlisted** 签名（不上公开商店）
4. 将签名的 `.xpi` 放入 `resources/browser-bridge/firefox/dist/` 并在安装器中调用 `firefox.exe -install-global-extension`

旗鱼安装器当前复制 **未签名** 的源码目录，适合开发与企业侧载；生产 Firefox 用户需完成上述签名流程。
