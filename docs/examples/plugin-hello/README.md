# Hello World 插件

SailFish 示例插件，演示工具注册和 Hook 拦截。

## 安装

将本目录复制到 SailFish 插件目录：

```bash
cp -r docs/examples/plugin-hello ~/Library/Application\ Support/SailFish/plugins/
```

重启 SailFish。

## 包含的功能

| 类型 | 名称 | 说明 |
|------|------|------|
| 工具 | `greet` | 用中/英/日/韩向某人打招呼 |
| 工具 | `random_number` | 生成指定范围的随机整数 |
| Hook | `before_tool_call` | 在控制台记录所有工具调用 |

## 验证

安装后在对话中尝试：

- "帮我用日语向 Alice 打个招呼"
- "给我一个 1 到 100 之间的随机数"

Agent 会调用插件注册的工具来完成。

## 以此为模板

1. 复制本目录，修改 `openclaw.plugin.json` 中的 `id` 和 `name`
2. 在 `index.js` 的 `register(api)` 中注册你的工具
3. 放入 plugins 目录，重启即可
