#!/usr/bin/env node
/* eslint-env node */
/**
 * 固定开销探针：一轮对话还没开始，系统提示 + 工具清单已经占掉多少窗口。
 *
 * 这个数字决定小窗口模型到底还能不能干活——它是每一轮都要重付的地板价，
 * 窗口减掉它才是真正留给对话和工具输出的空间。
 *
 * 用法：node scripts/probe-fixed-overhead.js
 * 代价：每种模式一次极小的真实 API 调用。
 */
'use strict'

const Module = require('module')
const path = require('path')

const shimPath = path.join(__dirname, '..', 'electron', 'cli', 'electron-shim.js')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'electron' || request === 'electron-updater') return shimPath
  return origResolve.call(this, request, parent, isMain, options)
}

process.env.SFT_CLI_MODE = '1'
require(path.join(__dirname, '..', 'electron', 'cli', 'cli-data.js')).setupCliDataDir({ defaultSandbox: true })
require('tsx/cjs')

const svcDir = path.join(__dirname, '..', 'electron', 'services')
const { ConfigService } = require(path.join(svcDir, 'config.service.ts'))
const { AiService } = require(path.join(svcDir, 'ai.service.ts'))
const { PromptBuilder } = require(path.join(svcDir, 'agent', 'prompt-builder.ts'))
const { getAgentTools } = require(path.join(svcDir, 'agent', 'tools.ts'))
const { stripCompositionMarkers } = require(path.join(svcDir, 'agent', 'context-composition.ts'))
const { estimateTextTokens } = require(path.join(svcDir, 'agent', 'token-estimate.ts'))

const MODES = ['assistant', 'local', 'ssh']

async function main() {
  const config = new ConfigService()
  const ai = new AiService(config)
  const profile = config.getAiProfiles().filter((p) => p.apiKey)[0]
  if (!profile) {
    console.log('没有可用的 AI 配置（缺 apiKey）')
    return
  }

  const context = {
    terminalType: 'assistant',
    workingDirectory: '/tmp',
    hostId: 'local',
    systemInfo: { os: process.platform, shell: 'zsh' },
  }

  console.log(`\n模型：${profile.model}（用它的计数口径量，换模型会略有出入）\n`)
  console.log('模式         工具数   系统提示    工具清单      地板价    32K 剩余   128K 剩余')
  console.log('─'.repeat(78))

  for (const mode of MODES) {
    const systemPrompt = stripCompositionMarkers(
      new PromptBuilder({ context: { ...context, terminalType: mode }, executionMode: 'relaxed' }).build()
    )
    const tools = getAgentTools(undefined, { mode, includeContextTools: true }, undefined)

    // 只发 system + 一个字，prompt_tokens 就约等于「系统提示 + 工具清单」的真实占用
    const res = await ai.chatWithTools(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: 'hi' }],
      tools,
      profile.id
    )
    const floor = res.usage?.prompt_tokens ?? 0
    const sysTokens = estimateTextTokens(systemPrompt)
    const toolTokens = Math.max(0, floor - sysTokens)

    const pct = (window) => {
      const left = window - floor
      return `${left.toLocaleString()} (${Math.round((left / window) * 100)}%)`.padStart(12)
    }
    console.log(
      `${mode.padEnd(12)} ${String(tools.length).padStart(4)}   ` +
      `${String(sysTokens).padStart(8)}   ${String(toolTokens).padStart(8)}   ` +
      `${String(floor).padStart(8)}  ${pct(32000)} ${pct(128000)}`
    )
    await new Promise((r) => setTimeout(r, 800))
  }

  console.log('\n注：系统提示按本地口径估算，工具清单 = 真实 prompt_tokens 减去它，含协议固定开销。\n')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
