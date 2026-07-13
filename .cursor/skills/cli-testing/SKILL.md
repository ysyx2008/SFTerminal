---
name: cli-testing
description: 后端代码修改后，通过 CLI 测试验证功能正确性。使用场景：修改了 electron/services/ 下的代码需要测试、准备提交代码前跑回归、用户要求"跑测试"/"验证一下"。
---

# CLI 测试

项目提供了 CLI 模式（`npm run sailfish`，`sft`/`cli` 为别名），可在纯 Node.js 下运行所有后端服务。
修改后端代码后，必须利用 CLI 验证功能正确性，不能只靠"能编译"就认为没问题。

## 何时使用本技能

- 修改了 `electron/services/` 下的任何服务
- 准备提交代码前
- 用户要求"跑测试"、"验证"、"测一下"

## 完整回归测试（提交前必跑）

```bash
bash electron/cli/test-cli.sh --no-ai    # 无需 AI API Key，~10秒
bash electron/cli/test-cli.sh            # 有 API Key 时跑全量
```

## 针对性验证（改了哪个服务就测哪个）

| 改动范围 | 验证命令 |
|----------|---------|
| config.service.ts | `sailfish config:get language && sailfish config:set theme '"test"' && sailfish config:get theme` |
| ai.service.ts | `sailfish ai:models` / `sailfish ai:chat "测试"` |
| agent/ 目录 | `sailfish agent:run "列出当前目录文件" --mode free` |
| knowledge/ 目录 | `sailfish knowledge:list && sailfish knowledge:search "测试"` |
| history.service.ts | `sailfish history:list && sailfish history:stats` |
| host-profile.service.ts | `sailfish host:list && sailfish host:get local` |
| ssh.service.ts | `sailfish ssh:list` |
| pty.service.ts | `sailfish pty:exec "echo ok" && sailfish pty:shells` |
| scheduler.service.ts | `sailfish scheduler:list && sailfish scheduler:history` |
| mcp.service.ts | `sailfish mcp:list` |
| local-fs.service.ts | `sailfish fs:list /tmp && sailfish fs:info` |
| document-parser.service.ts | `sailfish doc:parse README.md && sailfish doc:types` |
| user-skill.service.ts | `sailfish skill:list` |
| watch/ 目录 | `sailfish watch:list && sailfish watch:history && sailfish watch:templates && sailfish watch:state` |
| sensor/ 目录 | `sailfish sensor:status && sailfish sensor:heartbeat` |

> `sailfish` 即已安装的 PATH 命令，或 `npm run sailfish --`；直接用 `node electron/cli/main.js` 也行。`npm run sft` 仍为别名。

## 新增服务或命令时

1. 在 `electron/cli/index.ts` 中添加对应的 CLI 命令
2. 在 `test-cli.sh` 中添加对应的测试用例（包括正常场景和错误场景）
3. 运行测试套件确认全部通过
4. 更新 `.cursor/rules/project-architecture.mdc` 中的架构描述

## 测试失败怎么办

- 先确认是自己的改动导致的还是已有问题
- 修复后重跑测试，确保全部通过再提交
- 如果是测试脚本本身需要更新（如服务接口变了），同步更新 `test-cli.sh`
