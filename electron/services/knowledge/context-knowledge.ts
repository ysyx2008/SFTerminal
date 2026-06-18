/**
 * L2 知识文档服务（Context Knowledge）
 *
 * 每个 contextId 对应一份结构化 Markdown 知识文档，
 * 自动注入 system prompt，固定 token 预算。
 *
 * contextId 规则：
 *   - 本地终端: "local"
 *   - SSH 终端: "user@host"
 *   - 无终端模式: "personal"
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import type { AiService } from '../ai.service'
import { createLogger } from '../../utils/logger'

const log = createLogger('ContextKnowledge')

export interface ContextKnowledgeOptions {
  /** 文档最大字符数（约等于 token 预算 × 2） */
  maxDocChars?: number
}

const DEFAULT_MAX_DOC_CHARS = 5000
const MIN_VALID_DOC_LENGTH = 10
const MAX_CONTEXT_ID_LENGTH = 128

interface DocumentUpdateResult {
  updated: boolean
  document: string
}

export class ContextKnowledgeService {
  private storageDir: string
  private maxDocChars: number
  private cache: Map<string, string> = new Map()

  constructor(options?: ContextKnowledgeOptions) {
    this.storageDir = path.join(app.getPath('userData'), 'knowledge', 'context-docs')
    this.maxDocChars = options?.maxDocChars ?? DEFAULT_MAX_DOC_CHARS
    this.ensureDir()
    this.loadAll()
  }

  /**
   * 将 contextId 统一转换为安全的文件名/缓存 key
   */
  private normalizeId(contextId: string): string {
    const truncated = contextId.substring(0, MAX_CONTEXT_ID_LENGTH)
    return truncated.replace(/[^a-zA-Z0-9@._-]/g, '_')
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true })
    }
  }

  private loadAll(): void {
    try {
      const files = fs.readdirSync(this.storageDir).filter(f => f.endsWith('.md'))
      for (const file of files) {
        const content = fs.readFileSync(path.join(this.storageDir, file), 'utf-8')
        const id = file.replace(/\.md$/, '')
        this.cache.set(id, content)
      }
    } catch (error) {
      log.warn('加载已有文档失败:', error)
    }
  }

  /**
   * 获取知识文档内容（用于注入 prompt）
   * 返回空字符串表示该 contextId 尚无知识文档
   */
  getDocument(contextId: string): string {
    return this.cache.get(this.normalizeId(contextId)) ?? ''
  }

  /**
   * 直接设置知识文档（用于用户手动编辑或初始化）
   */
  setDocument(contextId: string, content: string): void {
    const safeId = this.normalizeId(contextId)
    const truncated = content.length > this.maxDocChars
      ? content.substring(0, this.maxDocChars)
      : content
    this.cache.set(safeId, truncated)
    this.saveToDisk(safeId, truncated)
  }

  /**
   * 删除知识文档
   */
  deleteDocument(contextId: string): void {
    const safeId = this.normalizeId(contextId)
    this.cache.delete(safeId)
    const filePath = path.join(this.storageDir, `${safeId}.md`)
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    } catch (error) {
      log.warn('删除文档失败:', error)
    }
  }

  /**
   * 获取所有 contextId 列表
   */
  listContextIds(): string[] {
    return Array.from(this.cache.keys())
  }

  /** 单份 L2 知识文档最大字符数（与 setDocument / LLM 提示一致，供设置页展示） */
  getMaxDocChars(): number {
    return this.maxDocChars
  }

  /**
   * 通过 LLM 更新知识文档
   *
   * 将当前文档 + 任务执行记录（或纯对话内容）交给 LLM，让它决定要不要更新文档。
   * 如果 LLM 判断没有新信息，返回 { updated: false }。
   *
   * - 有工具调用：走 buildUpdatePrompt，基于执行记录提炼
   * - 纯对话（无工具调用但有 finalResponse）：走 buildConversationUpdatePrompt，
   *   让 LLM 判断对话中是否有用户明确表达的偏好/配置/约定值得持久化
   */
  async updateWithLLM(
    contextId: string,
    aiService: AiService,
    profileId: string | undefined,
    taskContext: {
      userRequest: string
      commandRecords: string[]
      finalResponse?: string
    }
  ): Promise<DocumentUpdateResult> {
    const currentDoc = this.getDocument(contextId)

    if (taskContext.commandRecords.length === 0) {
      if (!taskContext.finalResponse) {
        return { updated: false, document: currentDoc }
      }
      const prompt = this.buildConversationUpdatePrompt(contextId, currentDoc, taskContext.userRequest, taskContext.finalResponse)
      return this.callLLMAndApply(contextId, aiService, profileId, prompt, currentDoc)
    }

    const prompt = this.buildUpdatePrompt(contextId, currentDoc, taskContext)
    return this.callLLMAndApply(contextId, aiService, profileId, prompt, currentDoc)
  }

  // ==================== 内部方法 ====================

  private async callLLMAndApply(
    contextId: string,
    aiService: AiService,
    profileId: string | undefined,
    prompt: string,
    currentDoc: string
  ): Promise<DocumentUpdateResult> {
    try {
      const response = await aiService.chat([
        { role: 'user', content: prompt }
      ], profileId)

      const result = this.parseUpdateResponse(response, currentDoc)

      if (result.updated) {
        this.setDocument(contextId, result.document)
      }

      return result
    } catch (error) {
      log.error('LLM 调用失败:', error)
      return { updated: false, document: currentDoc }
    }
  }

  private saveToDisk(safeId: string, content: string): void {
    try {
      const tempPath = path.join(this.storageDir, `${safeId}.md.tmp`)
      const finalPath = path.join(this.storageDir, `${safeId}.md`)
      fs.writeFileSync(tempPath, content, 'utf-8')
      fs.renameSync(tempPath, finalPath)
    } catch (error) {
      log.error('写入失败:', error)
    }
  }

  private buildUpdatePrompt(
    contextId: string,
    currentDoc: string,
    taskContext: { userRequest: string; commandRecords: string[] }
  ): string {
    const contextType = this.describeContextType(contextId)
    const isNewDoc = !currentDoc
    const docSection = isNewDoc
      ? '（尚无知识文档，如有值得记录的信息请创建）'
      : `\`\`\`markdown\n${currentDoc}\n\`\`\``

    return `你是一个知识文档维护助手。根据以下任务执行记录，判断是否需要更新${contextType}的知识文档。

## 当前知识文档
${docSection}

## 本次任务
**用户请求**: ${taskContext.userRequest}

**执行记录**:
${taskContext.commandRecords.join('\n')}

## 规则
- 只记录在**未来多次任务中都会用到**的核心事实（系统配置、软件版本、关键路径、服务架构、用户偏好等）
- 不记录：一次性操作结果、临时状态（CPU/内存占用、PID）、命令输出原文、操作过程描述
- 如果执行记录中没有值得更新的新信息，直接回复 NO_CHANGE
- 如果有新信息，输出完整的更新后文档（Markdown 格式，使用分类标题组织）
- 更新已有信息时直接修改原文（如版本号变了就改版本号），不要追加重复内容
- 文档总长度控制在 ${this.maxDocChars} 字符以内，超出时删减最不重要的信息

## 输出格式
如果无需更新，只回复: NO_CHANGE
如果需要更新，直接输出完整的 Markdown 文档内容（不要用代码块包裹）`
  }

  private buildConversationUpdatePrompt(
    contextId: string,
    currentDoc: string,
    userRequest: string,
    finalResponse: string
  ): string {
    const contextType = this.describeContextType(contextId)
    const isNewDoc = !currentDoc
    const docSection = isNewDoc
      ? '（尚无知识文档，如有值得记录的信息请创建）'
      : `\`\`\`markdown\n${currentDoc}\n\`\`\``

    return `你是一个知识文档维护助手。以下是一次纯对话交互，判断其中是否有值得持久化到${contextType}知识文档中的信息。

## 当前知识文档
${docSection}

## 本次对话
**用户**: ${userRequest}

**助手**: ${finalResponse}

## 规则
- 只记录用户明确要求记住的偏好、配置、约定，或对话中揭示的长期有效事实
- 不记录：一次性问答、临时查询结果、闲聊内容
- 如果对话中没有值得持久化的新信息，直接回复 NO_CHANGE
- 如果有新信息，输出完整的更新后文档（Markdown 格式，使用 ## 分类标题组织）
- 更新已有信息时直接修改原文，不要追加重复内容
- 文档总长度控制在 ${this.maxDocChars} 字符以内，超出时删减最不重要的信息

## 输出格式
如果无需更新，只回复: NO_CHANGE
如果需要更新，直接输出完整的 Markdown 文档内容（不要用代码块包裹）`
  }

  private describeContextType(contextId: string): string {
    if (contextId === 'local') return '本地主机'
    if (contextId === 'personal') return '个人'
    if (contextId.includes('@') || contextId.includes('_')) return '远程主机'
    return '当前上下文'
  }

  private parseUpdateResponse(response: string, currentDoc: string): DocumentUpdateResult {
    const trimmed = response.trim()

    if (trimmed === 'NO_CHANGE' || trimmed.startsWith('NO_CHANGE')) {
      return { updated: false, document: currentDoc }
    }

    let document = trimmed
    const fenceMatch = trimmed.match(/^```(?:markdown)?\s*\n([\s\S]*?)\n```\s*$/)
    if (fenceMatch) {
      document = fenceMatch[1]
    }

    if (!document || document.length < MIN_VALID_DOC_LENGTH) {
      return { updated: false, document: currentDoc }
    }

    return { updated: true, document }
  }
}

// ==================== 单例 ====================

let instance: ContextKnowledgeService | null = null

export function getContextKnowledgeService(): ContextKnowledgeService {
  if (!instance) {
    instance = new ContextKnowledgeService()
  }
  return instance
}
