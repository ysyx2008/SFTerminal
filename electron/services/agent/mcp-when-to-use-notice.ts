/**
 * 升级 one-shot：缺 whenToUse 的已启用 MCP → 联络通知。
 * 仅在本启刚跨过 schema v10 时由 main 调用；不写 marker；不每启重跑。
 */
import { app, BrowserWindow, Notification } from 'electron'
import { createLogger } from '../../utils/logger'
import { serializeAgentStepForIpc } from '../../utils/agent-step-ipc'
import type { AgentService } from './index'
import type { AgentCallbacks, AgentContext, AgentStep } from './types'
import { getLocalOS, getDefaultShell } from '../../utils/platform'
import { addProactiveContext } from './proactive-store'
import { getIMService } from '../im/im.service'
import { getConfigService } from '../config.service'
import type { McpServerConfig } from '@shared/types'

const log = createLogger('McpWhenToUseNotice')

const COMPANION_ID = '__companion__'
const CONSENT_USER_TASK = '[系统] MCP 使用说明升级提示'

const CONSENT_FALLBACK_NOTICE =
  'MCP 配置升级了：每个服务器需要一句「何时使用」说明，方便我选对工具。你可以让我帮你补，或自己去「设置 → MCP」完善。'

function listMissingWhenToUse(): McpServerConfig[] {
  return getConfigService()
    .getMcpServers()
    .filter(s => s.enabled && !(s.whenToUse || '').trim())
}

function buildSop(servers: McpServerConfig[]): string {
  const lines = servers.map(s => `- ${s.name}（id: ${s.id}）`)
  return `【MCP whenToUse 升级 SOP — 内部指令，勿整段念给用户听】

背景：旗鱼为 MCP 增加了 whenToUse（何时该用）。你这边有 ${servers.length} 个已启用但还缺说明的连接器：
${lines.join('\n')}

## 本轮（启动通知）— 严格
1. **唯一动作**：必须调用 **talk_to_user**（不是普通文字收工）。用自然口吻说明：MCP 这块升级了，需要补一句使用说明，发现能力会更好；可以让你代办，也可以用户自己去「设置 → MCP」完善。
2. 禁止用不带 tool_calls 的纯文本结束本轮。
3. 本轮 **禁止** 其它工具（含 skill / config_*）。talk_to_user 发出后立刻结束。

## 用户之后在联络里回复时
- 若用户让你帮忙：先 skill load config，用 config_mcp_server_update 写入确认过的 whenToUse（须先与用户确认文案）；可先连上或根据已有工具名起草。
- 若用户说自己去设置：简短确认即可，不要强行改配置。
- 若用户说以后再说：简短确认即可（不会每启再自动催，联络历史里已有本次通知）。`
}

async function deliverConsentNotice(message: string, title = 'MCP 配置'): Promise<void> {
  const trimmed = message.trim()
  if (!trimmed) return

  try {
    const im = getIMService()
    const result = await im.sendNotification(trimmed, { markdown: !!title, title })
    if (result.success) {
      log.info(`MCP whenToUse notice delivered via IM (${result.platform})`)
    } else if (result.error) {
      log.warn('MCP whenToUse notice IM failed:', result.error)
    }
  } catch (e) {
    log.debug('MCP whenToUse notice IM unavailable:', e)
  }

  let windowFocused = false
  try {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('watch:proactive-message', {
        agentId: COMPANION_ID,
        message: trimmed,
        watchName: title,
      })
      windowFocused = win.isFocused()
    }
  } catch (e) {
    log.debug('MCP whenToUse notice app delivery failed:', e)
  }

  if (!windowFocused && Notification.isSupported()) {
    try {
      const notification = new Notification({
        title,
        body: trimmed.length > 200 ? `${trimmed.substring(0, 200)}...` : trimmed,
      })
      notification.on('click', () => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win || win.isDestroyed()) return
        win.show()
        win.focus()
        win.webContents.send('watch:activate-message', { agentId: COMPANION_ID })
      })
      notification.show()
    } catch (e) {
      log.debug('MCP whenToUse notice system notification failed:', e)
    }
  }

  addProactiveContext(COMPANION_ID, trimmed, title)
}

function createCompanionDesktopCallbacks(
  agentId: string,
  state: { talkedToUser: boolean },
): AgentCallbacks {
  const send = (channel: string, payload: Record<string, unknown>) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(channel, payload)
  }

  const noteTalkToUser = (step: AgentStep) => {
    if (step.type === 'tool_call' && step.toolName === 'talk_to_user') {
      state.talkedToUser = true
    }
  }

  return {
    onStart: (_runId, userTask) => {
      send('agent:running', { agentId, userTask })
    },
    onStep: (_runId, step) => {
      noteTalkToUser(step)
      const serialized = serializeAgentStepForIpc(step)
      if (!serialized) return
      send('agent:step', { agentId, step: serialized })
    },
    onStepRemoved: (_runId, stepId) => {
      send('agent:stepRemoved', { agentId, stepId })
    },
    onNeedConfirm: (confirmation) => {
      send('agent:needConfirm', {
        agentId,
        toolCallId: confirmation.toolCallId,
        toolName: confirmation.toolName,
        toolArgs: JSON.parse(JSON.stringify(confirmation.toolArgs)),
        riskLevel: confirmation.riskLevel,
        displayName: confirmation.displayName,
        reasons: confirmation.reasons,
        trustCommandOffer: confirmation.trustCommandOffer,
      })
    },
    onNeedSecureInput: (request) => {
      send('agent:needSecureInput', {
        agentId,
        requestId: request.requestId,
        skillId: request.skillId,
        envName: request.envName,
        prompt: request.prompt,
        isUpdate: request.isUpdate,
      })
    },
    onComplete: (_runId, result, pendingUserMessages) => {
      send('agent:complete', { agentId, result, pendingUserMessages })
    },
    onError: (_runId, error) => {
      send('agent:error', { agentId, error })
    },
  }
}

/**
 * @param crossedV10ThisBoot 本启 services migration 前 schemaVersion &lt; 10 且之后 ≥ 10
 */
export async function runMcpWhenToUseNoticeIfNeeded(
  agentService: AgentService,
  crossedV10ThisBoot: boolean
): Promise<void> {
  if (!crossedV10ThisBoot) return

  const missing = listMissingWhenToUse()
  if (missing.length === 0) {
    log.info('v10 MCP whenToUse notice skipped: no enabled servers missing whenToUse')
    return
  }

  log.info(`v10 MCP whenToUse notice: ${missing.length} server(s) need whenToUse`)

  try {
    if (agentService.isRunning(COMPANION_ID)) {
      log.warn('Aborting busy companion before MCP whenToUse notice')
      agentService.abort(COMPANION_ID)
    }
  } catch (e) {
    log.warn('Failed to abort companion before MCP notice:', e)
  }

  try {
    await agentService.preloadSkills(COMPANION_ID, ['config'])
  } catch (e) {
    log.warn('preload config skill failed:', e)
  }

  const context: AgentContext = {
    terminalOutput: [],
    systemInfo: { os: getLocalOS(), shell: getDefaultShell() },
    terminalType: 'assistant',
    cwd: app.getPath('home'),
    contextHint: buildSop(missing),
  }

  const talkState = { talkedToUser: false }
  try {
    const finalText = await agentService.runAssistant(
      COMPANION_ID,
      CONSENT_USER_TASK,
      context,
      {
        enabled: true,
        commandTimeout: 30000,
        autoExecuteSafe: true,
        autoExecuteModerate: true,
        executionMode: 'relaxed',
        debugMode: false,
      },
      undefined,
      createCompanionDesktopCallbacks(COMPANION_ID, talkState),
    )
    if (!talkState.talkedToUser) {
      const notice =
        typeof finalText === 'string' && finalText.trim()
          ? finalText.trim()
          : CONSENT_FALLBACK_NOTICE
      log.warn('MCP whenToUse notice finished without talk_to_user; fallback toast/IM')
      await deliverConsentNotice(notice)
    }
  } catch (e) {
    log.error('MCP whenToUse companion run failed:', e)
    await deliverConsentNotice(CONSENT_FALLBACK_NOTICE)
  }
}
