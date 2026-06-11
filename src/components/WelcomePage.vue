<script setup lang="ts">
/**
 * 欢迎页组件
 * 程序启动后显示，提供快速启动各类终端的入口
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot, SquareTerminal, Monitor, Eye } from 'lucide-vue-next'
import { useConfigStore, type SshSession } from '../stores/config'
import MatrixRain from './EasterEgg/MatrixRain.vue'
import WelcomeChatComposer from './WelcomeChatComposer.vue'
import sailfishLogo from '../../resources/logo.png'

const { t } = useI18n()
const configStore = useConfigStore()
const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__

// 彩蛋：连续点击 Logo 20 次触发 Matrix 数字雨
const showMatrixEasterEgg = ref(false)
const logoClickCount = ref(0)
const lastLogoClickTime = ref(0)
const EASTER_EGG_CLICK_COUNT = 20
const EASTER_EGG_CLICK_INTERVAL = 1000 // 毫秒

const handleLogoClick = () => {
  const now = Date.now()
  // 如果距离上次点击超过 1000ms，重置计数
  if (now - lastLogoClickTime.value > EASTER_EGG_CLICK_INTERVAL) {
    logoClickCount.value = 1
  } else {
    logoClickCount.value++
  }
  lastLogoClickTime.value = now

  // 达到 20 次触发彩蛋
  if (logoClickCount.value >= EASTER_EGG_CLICK_COUNT) {
    showMatrixEasterEgg.value = true
    logoClickCount.value = 0
  }
}

const closeMatrixEasterEgg = () => {
  showMatrixEasterEgg.value = false
}

// 随机选择一条 tip 显示，支持点击切换（Steam 版过滤掉 AI 相关提示）
const allTipKeys = [
  'tip1', 'tip2', 'tip3', 'tip4', 'tip5', 'tip6', 'tip7', 'tip8', 'tip9', 'tip10',
  'tip11', 'tip12', 'tip13', 'tip14', 'tip15', 'tip16', 'tip17', 'tip18', 'tip19', 'tip20',
  'tip21', 'tip22', 'tip23', 'tip24', 'tip25', 'tip26', 'tip27', 'tip28', 'tip29', 'tip30'
]
const steamTipKeys = ['tip1', 'tip4', 'tip6', 'tip13', 'tip14', 'tip15', 'tip17', 'tip25', 'tip26', 'tip27']
const tipKeys = isSteamBuild ? steamTipKeys : allTipKeys
const currentTipIndex = ref(Math.floor(Math.random() * tipKeys.length))
const currentTip = computed(() => t(`welcome.${tipKeys[currentTipIndex.value]}`))

// 点击切换到下一条 tip
const nextTip = () => {
  currentTipIndex.value = (currentTipIndex.value + 1) % tipKeys.length
}

const emit = defineEmits<{
  'open-assistant': []
  'open-local': []
  'open-ssh': [session: SshSession]
  'open-session-manager': []
  'open-smart-patrol': []
  'open-watches': []
}>()

const openAssistant = () => {
  emit('open-assistant')
}

const openWatches = () => {
  emit('open-watches')
}

// 最近连接的会话（最多显示 5 个，按最近使用时间逆序排序）
const recentSessions = computed(() => {
  return [...configStore.sshSessions]
    .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
    .slice(0, 3)
})

// 是否有保存的会话
const hasSessions = computed(() => configStore.sshSessions.length > 0)

// 快速连接 SSH
const connectToSession = (session: SshSession) => {
  emit('open-ssh', session)
}

// 打开本地终端
const openLocalTerminal = () => {
  emit('open-local')
}

// 打开会话管理器选择更多
const openSessionManager = () => {
  emit('open-session-manager')
}

// 格式化主机显示
const formatHost = (session: SshSession) => {
  return `${session.username}@${session.host}:${session.port}`
}
</script>

<template>
  <div class="welcome-page">
    <div class="welcome-content">
      <!-- Logo 和标题 -->
      <div class="welcome-header">
        <div class="logo-container" @click="handleLogoClick">
          <div class="logo">
            <img :src="sailfishLogo" alt="Sailfish" class="sailfish-logo" />
          </div>
        </div>
        <div class="header-text">
          <h1 class="welcome-title">{{ t(isSteamBuild ? 'welcome.titleSteam' : 'welcome.title') }}</h1>
          <p class="welcome-subtitle">{{ t(isSteamBuild ? 'welcome.subtitleSteam' : 'welcome.subtitle') }}</p>
        </div>
      </div>

      <!-- AI 快速发起对话（Steam 版隐藏，复用 AiComposer） -->
      <WelcomeChatComposer v-if="!isSteamBuild" />

      <!-- 快速启动卡片 -->
      <div class="quick-start">
        <h2 class="section-title">{{ t('welcome.quickStart') }}</h2>
        <div class="action-cards">
          <!-- AI 助手（Steam 版隐藏） -->
          <div v-if="!isSteamBuild" class="action-card" @click="openAssistant">
            <div class="card-icon assistant">
              <Bot :size="32" :stroke-width="1.5" />
            </div>
            <div class="card-content">
              <div class="card-title">{{ t('welcome.assistant') }}</div>
              <div class="card-desc">{{ t('welcome.assistantDesc') }}</div>
            </div>
          </div>

          <!-- 本地终端 -->
          <div class="action-card" @click="openLocalTerminal">
            <div class="card-icon local">
              <SquareTerminal :size="32" :stroke-width="1.5" />
            </div>
            <div class="card-content">
              <div class="card-title">{{ t('welcome.localTerminal') }}</div>
              <div class="card-desc">{{ t('welcome.localTerminalDesc') }}</div>
            </div>
          </div>

          <!-- SSH 连接 -->
          <div class="action-card" @click="openSessionManager">
            <div class="card-icon ssh">
              <Monitor :size="32" :stroke-width="1.5" />
            </div>
            <div class="card-content">
              <div class="card-title">{{ t('welcome.sshConnect') }}</div>
              <div class="card-desc">{{ t('welcome.sshConnectDesc') }}</div>
            </div>
          </div>

          <!-- 关切总览（Steam 版隐藏，无 Agent 即无关切） -->
          <div v-if="!isSteamBuild" class="action-card" @click="openWatches">
            <div class="card-icon watch">
              <Eye :size="32" :stroke-width="1.5" />
            </div>
            <div class="card-content">
              <div class="card-title">{{ t('welcome.watch') }}</div>
              <div class="card-desc">{{ t('welcome.watchDesc') }}</div>
            </div>
          </div>

          <!-- 智能巡检（暂时隐藏）
          <div class="action-card" @click="openSmartPatrol">
            <div class="card-icon patrol">
              <Bot :size="32" :stroke-width="1.5" />
            </div>
            <div class="card-content">
              <div class="card-title">{{ t('welcome.smartPatrol') }}</div>
              <div class="card-desc">{{ t('welcome.smartPatrolDesc') }}</div>
            </div>
          </div>
          -->
        </div>
      </div>

      <!-- 最近连接 -->
      <div v-if="hasSessions" class="recent-sessions">
        <div class="section-header">
          <h2 class="section-title">{{ t('welcome.recentConnections') }}</h2>
          <div v-if="configStore.sshSessions.length > 3" class="view-all" @click="openSessionManager">
            {{ t('welcome.viewAllSessions') }} →
          </div>
        </div>
        <div class="session-grid">
          <div 
            v-for="session in recentSessions" 
            :key="session.id"
            class="session-item"
            @click="connectToSession(session)"
          >
            <div class="session-icon">
              <Monitor :size="16" />
            </div>
            <div class="session-info">
              <div class="session-name">{{ session.name }}</div>
              <div class="session-host">{{ formatHost(session) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 提示信息（非 Steam 版有对话入口，为节省纵向空间隐藏 tips） -->
      <div v-if="isSteamBuild" class="tips" @click="nextTip" :title="t('welcome.clickToSwitchTip')">
        <div class="tip-item">
          <span class="tip-icon">💡</span>
          <span class="tip-text">{{ currentTip }}</span>
          <span class="tip-next">↻</span>
        </div>
      </div>
    </div>

    <!-- Matrix 数字雨彩蛋 -->
    <MatrixRain v-if="showMatrixEasterEgg" @close="closeMatrixEasterEgg" />
  </div>
</template>

<style scoped>
.welcome-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 24px 20px;
}

.welcome-content {
  max-width: 780px;
  width: 100%;
  margin: auto;
  /* 入场动画 */
  animation: pageEnter 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

@keyframes pageEnter {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Header */
.welcome-header {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 24px;
  margin-bottom: 32px;
  animation: headerEnter 0.35s cubic-bezier(0.16, 1, 0.3, 1) 0.05s forwards;
  opacity: 0;
}

.header-text {
  text-align: left;
}

@keyframes headerEnter {
  from {
    opacity: 0;
    transform: translateY(-10px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.logo-container {
  transition: transform 0.3s ease;
}

.logo-container:hover {
  transform: scale(1.05);
}

.logo-container:active {
  transform: scale(0.98);
}

.logo {
  display: flex;
  justify-content: center;
  align-items: center;
  animation: float 3s ease-in-out infinite;
  will-change: transform;
  transform: translateZ(0); /* 强制 GPU 加速 */
}

.sailfish-logo {
  width: 112px;
  height: 112px;
  object-fit: contain;
  filter: drop-shadow(0 4px 16px rgba(var(--accent-decorative-rgb), 0.4));
  transition: filter 0.3s ease;
}

.logo-container:hover .sailfish-logo {
  filter: drop-shadow(0 6px 30px rgba(var(--accent-decorative-rgb), 0.6));
}

@keyframes float {
  0%, 100% { transform: translate3d(0, 0, 0); }
  50% { transform: translate3d(0, -10px, 0); }
}

.welcome-title {
  font-size: 30px;
  font-weight: 800;
  color: var(--text-primary);
  margin: 0 0 6px 0;
  letter-spacing: -0.5px;
  /* 渐变文字效果 */
  background: linear-gradient(135deg, var(--text-primary) 0%, var(--accent-primary) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* 浅色主题：调整标题渐变 */
[data-color-scheme="light"] .welcome-title {
  background: linear-gradient(135deg, var(--text-primary) 20%, var(--accent-primary) 100%);
  -webkit-background-clip: text;
  background-clip: text;
}

.welcome-subtitle {
  font-size: 15px;
  color: var(--text-muted);
  margin: 0;
  opacity: 0.85;
  letter-spacing: 0.5px;
}

/* Section Title */
.section-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-secondary);
  margin: 0 0 16px 0;
  text-transform: uppercase;
  letter-spacing: 1px;
  opacity: 0.8;
}

/* Quick Start Cards */
.quick-start {
  margin-bottom: 28px;
  animation: sectionEnter 0.3s cubic-bezier(0.16, 1, 0.3, 1) 0.08s forwards;
  opacity: 0;
}

@keyframes sectionEnter {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 卡片容器：默认 4 列等宽 grid，让「关切」始终与前 3 张同行不换行 */
.action-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 20px;
  justify-content: center;
}

@media (max-width: 640px) {
  .action-cards {
    grid-template-columns: 1fr;
    justify-items: center;
  }
  .action-card {
    width: min(280px, 100%);
  }
}

/* 每张卡片继承自己图标的品牌色，让 hover 时整张卡片以自己的品牌色"被点亮"——
   AI 卡 → 橙色氛围、本地卡 → 绿色氛围、SSH 卡 → 蓝色氛围。
   原先所有卡片共用 --accent-decorative-*（浅色下是蓝色 accent），与橙/绿图标
   产生色相冲突（橙图标 + 蓝外晕看着不和谐），新方案让 hover 时图标、边框、
   外晕、底色全部围绕同一品牌色，整张卡片像"亮起来"，告别浅色下的暗淡感。 */
.action-card {
  --card-glow-rgb: var(--accent-decorative-rgb);
  --card-glow-color: var(--accent-decorative-primary);
  position: relative;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 20px;
  padding: 28px;
  cursor: pointer;
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), 
              border-color 0.3s ease, 
              border-width 0.3s ease,
              background 0.3s ease,
              box-shadow 0.3s ease;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 12px;
  /* 宽度由 grid 列均分；保留 height 与 min-width 防止内容挤压 */
  min-width: 0;
  height: 165px;
  overflow: hidden;
  /* 入场动画只用 opacity，让 hover transform 正常工作 */
  animation: cardFadeIn 0.25s ease-out both;
}

/* 通过 :has() 让卡片继承自己图标的品牌色（不需要改模板加 class） */
.action-card:has(.card-icon.assistant) {
  --card-glow-rgb: var(--brand-assistant-rgb);
  --card-glow-color: var(--brand-assistant);
}
.action-card:has(.card-icon.local) {
  --card-glow-rgb: var(--brand-local-rgb);
  --card-glow-color: var(--brand-local);
}
.action-card:has(.card-icon.ssh) {
  --card-glow-rgb: var(--brand-ssh-rgb);
  --card-glow-color: var(--brand-ssh);
}
.action-card:has(.card-icon.patrol) {
  --card-glow-rgb: var(--brand-patrol-rgb);
  --card-glow-color: var(--brand-patrol);
}
/* 关切：橙色品牌色（与 ssh 蓝/local 绿/assistant 紫错开），呼应"运营监控"语义 */
.action-card:has(.card-icon.watch) {
  --card-glow-rgb: 245, 158, 11;
  --card-glow-color: #f59e0b;
}

.action-card:nth-child(1) { animation-delay: 0.10s; }
.action-card:nth-child(2) { animation-delay: 0.16s; }
.action-card:nth-child(3) { animation-delay: 0.22s; }
.action-card:nth-child(4) { animation-delay: 0.28s; }

@keyframes cardFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* ::before 是绕卡片外延 2px 的"边缘柔光环"（z-index:-1 在卡片背后，
   只露出 inset:-2px 这一圈）。配合卡片自己的品牌色，hover 时变成
   一圈与图标同色的发光描边。 */
.action-card::before {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: 22px;
  background: linear-gradient(135deg,
    rgba(var(--card-glow-rgb), 1),
    rgba(var(--card-glow-rgb), 0.55));
  opacity: 0;
  z-index: -1;
  transition: opacity 0.3s ease;
}

.action-card:hover:not(.disabled)::before {
  opacity: 0.55;
}

/* 卡片内部光晕 */
.action-card::after {
  content: '';
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(circle at center, rgba(255,255,255,0.05) 0%, transparent 60%);
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
}

.action-card:hover:not(.disabled)::after {
  opacity: 1;
}

/* hover：让"整张卡片"看起来被自己的品牌色点亮——
   - 边框：本卡品牌色实色（橙/绿/蓝），不再是统一的主题蓝
   - 底色：基础灰底叠 8% 品牌色（color-mix）→ 从中性灰变成"暖灰/森林灰/湖蓝灰"，
     这是解决"按钮还是很暗淡"的关键：卡片本体也参与了氛围
   - 外晕：38px 品牌色发光，强度 0.32（比原来的 0.2 主题色更显眼） */
.action-card:hover:not(.disabled) {
  border-color: var(--card-glow-color);
  border-width: 2px;
  transform: translateY(-8px) scale(1.06);
  background: color-mix(in srgb, var(--card-glow-color) 8%, var(--bg-secondary));
  box-shadow: 
    0 20px 40px rgba(0, 0, 0, 0.18),
    0 0 38px rgba(var(--card-glow-rgb), 0.32);
}

.action-card:active:not(.disabled) {
  transform: translateY(-2px) scale(0.97);
  transition: transform 0.15s ease;
}

.action-card.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* card-icon 直接继承父级 .action-card 上的 --card-glow-rgb 品牌色变量，
   不需要每个 .assistant/.local/.ssh 单独定义。静态阴影和 hover 增强阴影
   都从这条变量取色，与卡片整体氛围保持同一色相。 */
.card-icon {
  --icon-glow-rgb: var(--card-glow-rgb, var(--accent-decorative-rgb));
  width: 60px;
  height: 60px;
  min-width: 60px;
  min-height: 60px;
  flex-shrink: 0;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  box-shadow: 0 4px 15px rgba(var(--icon-glow-rgb), 0.3);
  transition: transform 0.3s ease, box-shadow 0.3s ease, filter 0.3s ease;
}

/* hover：让图标"活过来"的三件套——
   1. filter 提亮+提色：图标本身从静态色变得更鲜艳，这是"有活力"的核心反馈
   2. 加强品牌色光晕（0.6 强度，30px 扩散）：四周染上同色的氛围光
   3. 柔和环境暗影：保留上浮层次感
   原先单一的 rgba(0,0,0,0.35) 阴影在浅色主题下会把鲜艳图标"拍灰"，故彻底替换。 */
.action-card:hover:not(.disabled) .card-icon {
  transform: scale(1.08) translateY(-4px);
  filter: saturate(1.2) brightness(1.08);
  box-shadow:
    0 16px 32px rgba(var(--icon-glow-rgb), 0.55),
    0 6px 14px rgba(0, 0, 0, 0.15);
}

.card-icon.assistant {
  background: linear-gradient(135deg, var(--brand-assistant), var(--brand-assistant-end));
}

.card-icon.local {
  background: linear-gradient(135deg, var(--brand-local), var(--brand-local-end));
}

.card-icon.ssh {
  background: linear-gradient(135deg, var(--brand-ssh), var(--brand-ssh-end));
}

.card-icon.patrol {
  background: linear-gradient(135deg, var(--brand-patrol), var(--brand-patrol-end));
}

.card-icon.watch {
  background: linear-gradient(135deg, #f59e0b, #d97706);
}

/* 标题 hover 不再变色：
   hover 反馈已经由卡片上浮、图标放大、玻璃浮层、柔光描边合力表达，
   再给文字变色会在深色主题下形成"中性卡片 + 蓝色文字孤岛"的割裂感。
   保持 text-primary，让信息层级稳定、氛围内敛。 */
.card-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.card-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}

.coming-soon-badge {
  position: absolute;
  top: 12px;
  right: 12px;
  font-size: 10px;
  font-weight: 600;
  color: var(--brand-patrol);
  background: rgba(var(--brand-patrol-rgb), 0.1);
  padding: 2px 8px;
  border-radius: 4px;
}

/* Recent Sessions */
.recent-sessions {
  margin-bottom: 20px;
  animation: sectionEnter 0.3s cubic-bezier(0.16, 1, 0.3, 1) 0.2s forwards;
  opacity: 0;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.section-header .section-title {
  margin-bottom: 0;
}

.session-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}

.session-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  position: relative;
  overflow: hidden;
}

/* 会话卡片光效 */
.session-item::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent);
  transition: left 0.5s ease;
}

.session-item:hover::before {
  left: 100%;
}

/* border-color 走 --accent-decorative-primary 纯色：
   深色下是清晰白边（不再是孤立的 accent 蓝边），
   其他主题下是各自装饰色（= accent）。和 action-card hover 观感一致。 */
.session-item:hover {
  border-color: var(--accent-decorative-primary);
  background: var(--bg-tertiary);
  transform: translateX(4px);
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
}

/* 静态态：图标前景也走 text-secondary 中性灰，避免深色下的"蓝色屏幕图标孤岛"；
   底板继续用装饰色半透明淡衬。整组 session 入口走"纯中性"风格，让
   主题色只在真正的功能锚点（btn-primary、激活 tab 条等）出现。 */
.session-icon {
  width: 36px;
  height: 36px;
  background: linear-gradient(135deg, rgba(var(--accent-decorative-rgb), 0.2), rgba(var(--accent-decorative-rgb), 0.1));
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  flex-shrink: 0;
  transition: transform 0.2s ease, background 0.2s ease, color 0.2s ease;
}

/* hover 反馈：图标放大 + 底板加亮 + 前景提亮到 text-primary；
   不再使用饱和 accent 渐变底板（那在深色下是孤立的蓝色方块）。 */
.session-item:hover .session-icon {
  transform: scale(1.1);
  background: linear-gradient(135deg, rgba(var(--accent-decorative-rgb), 0.35), rgba(var(--accent-decorative-rgb), 0.2));
  color: var(--text-primary);
}

.session-info {
  flex: 1;
  min-width: 0;
}

/* 与 card-title 同理：hover 不变色，信息层级更稳，深色下不再出现蓝色文字孤岛。
   hover 反馈已经由 session-item 的背景变化 + 位移 + 图标饱和承担。 */
.session-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-host {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* "查看全部会话 →" 改为次级文本色：→ 箭头已经承担"可点击"信号，
   深色下不再是孤立的蓝色链接。hover 时提亮到 text-primary 表达可交互。 */
.view-all {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
  padding: 4px 8px;
  border-radius: 6px;
}

.view-all:hover {
  color: var(--text-primary);
  background: rgba(var(--accent-decorative-rgb), 0.1);
  transform: translateX(4px);
}

/* Tips */
.tips {
  padding: 12px 16px;
  margin-top: 38px;
  background: linear-gradient(135deg, rgba(var(--accent-decorative-rgb), 0.08), rgba(var(--accent-decorative-secondary-rgb), 0.05));
  border: 1px solid rgba(var(--accent-decorative-rgb), 0.15);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s ease;
  user-select: none;
  animation: sectionEnter 0.3s cubic-bezier(0.16, 1, 0.3, 1) 0.25s forwards;
  opacity: 0;
  position: relative;
  overflow: hidden;
}

/* 提示框闪光效果 */
.tips::after {
  content: '';
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(circle at 30% 30%, rgba(255,255,255,0.1) 0%, transparent 50%);
  opacity: 0;
  transition: opacity 0.3s ease;
}

.tips:hover::after {
  opacity: 1;
}

.tips:hover {
  background: linear-gradient(135deg, rgba(var(--accent-decorative-rgb), 0.12), rgba(var(--accent-decorative-secondary-rgb), 0.08));
  border-color: rgba(var(--accent-decorative-rgb), 0.25);
  transform: scale(1.01);
  box-shadow: 0 4px 20px rgba(var(--accent-decorative-rgb), 0.1);
}

.tips:active {
  transform: scale(0.99);
}

.tip-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  position: relative;
  z-index: 1;
}

.tip-icon {
  font-size: 18px;
  flex-shrink: 0;
  animation: tipPulse 2s ease-in-out infinite;
}

@keyframes tipPulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.1); }
}

.tip-text {
  flex: 1;
  line-height: 1.5;
}

/* ↻ 切换指示符：和 view-all 的 → 一致走次级文本色，
   深色下不出现孤立蓝色图标。 */
.tip-next {
  font-size: 16px;
  color: var(--text-secondary);
  opacity: 0;
  transition: all 0.3s ease;
  flex-shrink: 0;
}

.tips:hover .tip-next {
  opacity: 0.8;
  transform: rotate(180deg);
}
</style>

