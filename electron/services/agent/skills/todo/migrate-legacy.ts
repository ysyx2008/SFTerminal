/**
 * Deferred：v9 挂起后，在联络（__companion__）上征询并完成 TODO.md → TODO.json。
 *
 * 流程（复用现有 companion，不改编 proactive 管道）：
 * 1. 启动：短 user_task + contextHint（完整 SOP，不进聊天正文）
 * 2. Agent talk_to_user 征询 → 本轮结束（未调用则宿主兜底投递 toast/IM）
 * 3. 用户在联络回复 → 会话上下文里已有 SOP，按指引迁 / 写 deferred|skipped|done
 * 4. 文件系统收尾（删/备份 md）由代码确定性完成
 *
 * 征询 run 必须带桌面 callbacks（与 IM 进联络同形），否则 user_task / 确认框不会出现在 UI。
 */
import * as fs from 'fs'
import * as path from 'path'
import { app, BrowserWindow, Notification } from 'electron'
import { createLogger } from '../../../../utils/logger'
import { serializeAgentStepForIpc } from '../../../../utils/agent-step-ipc'
import type { AgentService } from '../../index'
import type { AgentCallbacks, AgentContext, AgentStep } from '../../types'
import { getLocalOS, getDefaultShell } from '../../../../utils/platform'
import { addProactiveContext } from '../../proactive-store'
import { getIMService } from '../../../im/im.service'
import {
  getTodoMigrationMarkerPath,
  getWorkspaceDir,
  hasValidTodoJson,
  isTodoMdMigrationPending,
  LEGACY_TODO_MD,
  readTodoMigrationMarker,
  TODO_FILENAME,
  relocateLegacyTodoMigrationMarker,
  writeTodoMigrationMarker,
  type TodoMigrationMarker,
} from './migration-marker'

const log = createLogger('TodoMdAgentMigrate')

const COMPANION_ID = '__companion__'

/** 联络 tab 上可见的短任务文案（勿放大段 SOP） */
const CONSENT_USER_TASK = '[系统] 待办数据迁移征询'

/** 模型未调 talk_to_user 时的确定性兜底文案（兼作 IM/toast） */
const CONSENT_FALLBACK_NOTICE =
  '发现工作区还有旧版 Markdown 待办（TODO.md）。要不要现在迁成结构化本地待办？方便之后提醒。回复「迁」或「以后再说」即可。'

/**
 * 完整内部指引：注入 contextHint → 进入 API 消息，写入会话后随联络上下文延续。
 * 不显示在 user_task 气泡里。
 */
function buildMigrationSop(workspace: string, markerPath: string): string {
  return `【待办迁移 SOP — 内部指令，勿整段念给用户听】

背景：升级后要把工作区旧版 Markdown 待办迁到结构化本地待办（todo 技能 / TODO.json）。
工作区：${workspace}
迁移标记文件：${markerPath}
（位于工作区 migrations/ 免确认目录；状态字段 status：pending | deferred | skipped | done | failed）

## 本轮（启动征询）— 严格
1. **唯一动作**：必须调用 **talk_to_user** 工具（不是普通文字收工）。message 用秘书口吻说明发现旧版 TODO.md、想迁成结构化待办以便提醒，并询问要不要现在迁。
2. 禁止用不带 tool_calls 的纯文本回复结束本轮——那样桌面 toast / IM 都不会发出。
3. 本轮 **禁止** 任何其它工具：不要 write_text_file / write_file / todo_create / read_file / exec / skill。talk_to_user 发出后立刻结束。

## 用户之后在联络里回复时（同一会话上下文续跑）
- **同意迁**：若 todo_* 不可用先 skill 加载 todo；read_file 读 TODO.md（没有则 TODO.md.bak）；用 todo_create 逐条写入（日期/优先级仅文中明确才填，勿编造；已勾可选 completed）；全部成功后用 write_text_file 把迁移标记写成 status=done（保留 createdAt，补 completedAt；路径见上，免确认）；用日常回复告诉用户迁了几条即可，**不要再 talk_to_user**。
- **以后再说**：write_text_file 将标记写成 status=deferred（下次启动会再提醒）；简短确认即可。
- **明确不用迁了**：write_text_file 写成 status=skipped；简短确认即可。
- **禁止**：exec / shell / 重命名或删除 TODO.md（备份由程序处理）。
- 本地秘书待办用 todo_*，不要用日历 calendar_todo_*。`
}

/**
 * 与 messageUser 同形：桌面 toast（watch:proactive-message）+ IM + 可选系统通知。
 * 征询轮若模型漏调 talk_to_user，用此兜底，否则用户只会看到联络黄点。
 */
async function deliverConsentNotice(message: string, title = '待办迁移'): Promise<void> {
  const trimmed = message.trim()
  if (!trimmed) return

  try {
    const im = getIMService()
    const result = await im.sendNotification(trimmed, { markdown: !!title, title })
    if (result.success) {
      log.info(`Consent notice delivered via IM (${result.platform})`)
    } else if (result.error) {
      log.warn('Consent notice IM delivery failed:', result.error)
    }
  } catch (e) {
    log.debug('Consent notice IM unavailable:', e)
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
    log.debug('Consent notice app delivery failed:', e)
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
      log.debug('Consent notice system notification failed:', e)
    }
  }

  addProactiveContext(COMPANION_ID, trimmed, title)
}

/** 与 IM 入口同形：把 companion run 同步到桌面联络 tab；顺带侦测 talk_to_user */
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

function retireLegacyTodoMd(mdPath: string, bakPath: string): void {
  if (!fs.existsSync(mdPath)) return
  try {
    if (!fs.existsSync(bakPath)) {
      fs.renameSync(mdPath, bakPath)
      log.info('Retired TODO.md → TODO.md.bak')
    } else {
      fs.unlinkSync(mdPath)
      log.info('Removed leftover TODO.md (bak already present)')
    }
  } catch (e) {
    log.warn('Failed to retire TODO.md:', e)
  }
}

function markDone(
  markerPath: string,
  marker: TodoMigrationMarker | null,
  note?: string,
): void {
  writeTodoMigrationMarker(markerPath, {
    version: 1,
    status: 'done',
    createdAt: marker?.createdAt ?? Date.now(),
    completedAt: Date.now(),
    bakPath: marker?.bakPath ?? `${LEGACY_TODO_MD}.bak`,
    ...(note ? { note } : {}),
  })
}

/** 已有有效 TODO.json 时收尾残留 md，并把 marker 标 done */
function finalizeIfJsonReady(
  workspace: string,
  markerPath: string,
  marker: TodoMigrationMarker | null,
): boolean {
  const mdPath = path.join(workspace, LEGACY_TODO_MD)
  const bakPath = path.join(workspace, `${LEGACY_TODO_MD}.bak`)
  const jsonPath = path.join(workspace, TODO_FILENAME)
  if (!hasValidTodoJson(jsonPath)) return false
  retireLegacyTodoMd(mdPath, bakPath)
  if (marker?.status !== 'done') {
    markDone(markerPath, marker, 'Finalized after TODO.json already populated')
  }
  log.info('TODO.md migration finalized (TODO.json present)')
  return true
}

/**
 * services 就绪后调用：挂起则联络征询；已迁则只收尾。
 * 不阻塞启动。
 */
export async function runTodoMdAgentMigrationIfNeeded(agentService: AgentService): Promise<void> {
  const userDataPath = app.getPath('userData')
  const workspace = getWorkspaceDir(userDataPath)
  const markerPath = getTodoMigrationMarkerPath(userDataPath)
  relocateLegacyTodoMigrationMarker(userDataPath)
  const marker = readTodoMigrationMarker(markerPath)
  const mdPath = path.join(workspace, LEGACY_TODO_MD)
  const bakPath = path.join(workspace, `${LEGACY_TODO_MD}.bak`)

  // 无论 marker 如何：有效 JSON 就收掉残留 md
  if (finalizeIfJsonReady(workspace, markerPath, marker)) return

  if (!isTodoMdMigrationPending(userDataPath)) return

  if (!fs.existsSync(mdPath) && !fs.existsSync(bakPath)) {
    writeTodoMigrationMarker(markerPath, {
      version: 1,
      status: 'skipped',
      createdAt: marker?.createdAt ?? Date.now(),
      completedAt: Date.now(),
      note: 'TODO.md and bak missing',
    })
    return
  }

  // 上次征询可能卡在无人确认的 write；先中止再征询
  try {
    if (agentService.isRunning(COMPANION_ID)) {
      log.warn('Aborting busy companion before migration consent')
      agentService.abort(COMPANION_ID)
    }
  } catch (e) {
    log.warn('Failed to abort companion before consent:', e)
  }

  try {
    await agentService.preloadSkills(COMPANION_ID, ['todo'])
  } catch (e) {
    log.warn('preload todo skill failed:', e)
  }

  const context: AgentContext = {
    terminalOutput: [],
    systemInfo: { os: getLocalOS(), shell: getDefaultShell() },
    terminalType: 'assistant',
    cwd: workspace,
    contextHint: buildMigrationSop(workspace, markerPath),
  }

  const talkState = { talkedToUser: false }
  try {
    log.info('Offering TODO.md migration consent via companion')
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
    // 征询轮结束即可；迁移动作等用户在联络里回复
    // 模型常漏调 talk_to_user（纯文本收工）→ 无 toast/IM，仅黄点；宿主兜底与 messageUser 同形投递
    if (!talkState.talkedToUser) {
      const notice =
        typeof finalText === 'string' && finalText.trim()
          ? finalText.trim()
          : CONSENT_FALLBACK_NOTICE
      log.warn('Consent run finished without talk_to_user; delivering toast/IM fallback')
      await deliverConsentNotice(notice)
    }
  } catch (e) {
    log.warn('TODO.md migration consent run skipped/failed (will retry next launch):', e)
  }
}
