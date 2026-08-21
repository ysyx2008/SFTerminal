#!/usr/bin/env node
/* eslint-env node */
/**
 * 前缀缓存探针：确认 provider 到底有没有在给我们命中缓存。
 *
 * 每轮请求都带着上万 token 的固定前缀（system prompt + 工具 schema）。这块
 * 只要命中缓存就只按两折计费，命不中就全价重算——但界面上的命中率是 provider
 * 报什么就是什么，报 0 时无从判断是「它不支持」还是「我们的前缀每轮都在变」。
 *
 * 本脚本连发两次**完全相同**的大请求来分辨：
 *   第二次命中 → provider 支持，那 0% 命中就是我们自己的前缀不稳定
 *   第二次仍 0 → 该模型不支持隐式缓存，与我们的代码无关
 *
 * 用法：node scripts/probe-prompt-cache.js [--profile <id>] [--all]
 * 代价：每个 profile 两次真实 API 调用（max_tokens 极小，但输入约 1.8 万 token）。
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
require(path.join(__dirname, '..', 'electron', 'cli', 'cli-data.js')).setupCliDataDir()
require('tsx/cjs')

const svcDir = path.join(__dirname, '..', 'electron', 'services')
const { ConfigService } = require(path.join(svcDir, 'config.service.ts'))
const { AiService } = require(path.join(svcDir, 'ai.service.ts'))
const { PromptBuilder } = require(path.join(svcDir, 'agent', 'prompt-builder.ts'))
const { getAgentTools } = require(path.join(svcDir, 'agent', 'tools.ts'))
const { stripCompositionMarkers } = require(path.join(svcDir, 'agent', 'context-composition.ts'))

function parseArgs() {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--profile')
  return { profileId: i >= 0 ? argv[i + 1] : undefined, all: argv.includes('--all') }
}

function buildFixedPrefix() {
  const context = {
    terminalType: 'assistant',
    workingDirectory: '/tmp',
    hostId: 'local',
    systemInfo: { os: process.platform, shell: 'zsh' },
  }
  const builder = new PromptBuilder({ context, executionMode: 'relaxed' })
  const systemPrompt = stripCompositionMarkers(builder.build())
  const tools = getAgentTools(undefined, { mode: 'assistant', includeContextTools: true }, undefined)
  return { systemPrompt, tools }
}

/** 从各家不同的 usage 形状里取命中数 */
function readCachedTokens(usage) {
  if (!usage) return null
  const raw = usage.raw || usage
  const details = raw.prompt_tokens_details || raw.input_tokens_details
  if (details && typeof details.cached_tokens === 'number') return details.cached_tokens
  if (typeof raw.cached_tokens === 'number') return raw.cached_tokens
  if (typeof raw.cache_read_input_tokens === 'number') return raw.cache_read_input_tokens
  if (typeof usage.cache_hit_tokens === 'number') return usage.cache_hit_tokens
  return null
}

async function probeProfile(ai, profile, systemPrompt, tools) {
  // 两次请求内容必须逐字节一致，否则测的就不是缓存了
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '只回一个字：好' },
  ]

  const results = []
  for (let i = 0; i < 2; i++) {
    const r = await ai.chatWithTools(messages, tools, profile.id)
    const usage = r.usage || {}
    results.push({
      prompt: usage.prompt_tokens ?? 0,
      cached: readCachedTokens(usage),
    })
    if (i === 0) await new Promise((res) => setTimeout(res, 1500))
  }

  const [first, second] = results
  const hitRate = second.cached && second.prompt ? Math.round((second.cached / second.prompt) * 100) : 0
  let verdict
  if (second.cached === null) {
    verdict = 'provider 不上报缓存字段（无法判断）'
  } else if (second.cached > 0) {
    verdict = `✅ 支持，第二次命中 ${hitRate}% —— 实跑中若为 0%，问题在我们的前缀不稳定`
  } else {
    verdict = '❌ 相同请求连发两次仍 0 命中 —— 该模型不支持隐式缓存，与我方代码无关'
  }

  console.log(
    `${profile.model.padEnd(30)} prompt=${String(first.prompt).padStart(6)}  ` +
      `第1次 cached=${String(first.cached ?? '-').padStart(6)}  第2次 cached=${String(second.cached ?? '-').padStart(6)}\n` +
      `${' '.repeat(30)} ${verdict}\n`
  )
}

async function main() {
  const { profileId, all } = parseArgs()
  const config = new ConfigService()
  const ai = new AiService(config)
  const profiles = config.getAiProfiles().filter((p) => p.apiKey)

  const { systemPrompt, tools } = buildFixedPrefix()
  console.log(
    `\n固定前缀规模：system ${systemPrompt.length} 字符 + ${tools.length} 个工具\n` +
      `每个 profile 连发两次完全相同的请求，间隔 1.5 秒\n`
  )

  const targets = all
    ? profiles
    : [profiles.find((p) => p.id === (profileId || config.getActiveAiProfile())) || profiles[0]]

  for (const p of targets.filter(Boolean)) {
    try {
      await probeProfile(ai, p, systemPrompt, tools)
    } catch (e) {
      console.log(`${p.model.padEnd(30)} 探测失败：${e.message}\n`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
