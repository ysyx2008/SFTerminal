// 通用 UI 词汇：应用基础、欢迎页、巡检、按钮文案、头部、关于、赞助、语言、连接状态
export default {

  // App level
  app: {
    title: 'SailFish',
    description: 'AI-powered smart assistant'
  },


  // Welcome page
  welcome: {
    title: 'Welcome to SailFish',
    titleSteam: 'Welcome to SFTerm',
    subtitle: 'AI-powered smart assistant',
    subtitleSteam: 'Efficient terminal & connection manager',
    quickStart: 'Quick Start',
    assistant: 'AI Assistant',
    assistantDesc: 'Chat with AI directly',
    localTerminal: 'Local Terminal',
    localTerminalDesc: 'Open local command line',
    sshConnect: 'SSH Connect',
    sshConnectDesc: 'Connect to remote servers',
    smartPatrol: 'Smart Patrol',
    smartPatrolDesc: 'AI auto-inspect multiple servers',
    watch: 'Watches',
    watchDesc: 'See your operations overview',
    comingSoon: 'Coming Soon',
    recentConnections: 'Recent Connections',
    viewAllSessions: 'View All Sessions',
    tip1: 'Press Ctrl+T / Cmd+T to quickly create a new terminal tab',
    tip2: 'Right-click terminal to send selected content to AI for analysis',
    tip3: 'Enable Agent mode to let AI automatically execute complex tasks',
    tip4: 'Import Xshell session configs with one click for easy migration',
    tip5: 'Code blocks in AI replies can be sent to terminal with one click',
    tip6: 'Press Ctrl+W to quickly close current terminal tab',
    tip7: 'Upload docs to knowledge base, AI auto-retrieves relevant content',
    tip8: 'Agent auto-detects host environment, system and installed tools',
    tip9: 'Set MBTI personality for Agent to get different response styles',
    tip10: 'Configure MCP servers to let AI access external tools and resources',
    tip11: 'Knowledge base supports PDF, Word, text and more formats',
    tip12: 'Agent can remember important info and recall it in future sessions',
    tip13: 'Double-click a session to quickly connect to SSH server',
    tip14: 'Connect to internal servers via jump hosts',
    tip15: 'SFTP file manager supports drag-and-drop upload/download',
    tip16: 'Each terminal tab has its own AI conversation history',
    tip17: 'Terminal colors auto-sync with UI theme for a unified look',
    tip18: 'In strict mode, every command requires confirmation',
    tip19: 'In relaxed mode, only dangerous commands need confirmation',
    tip20: 'Supports multiple AI models: OpenAI, Qwen, DeepSeek, Ollama',
    tip21: 'Upload documents to chat with AI for content analysis',
    tip22: 'Supports PDF, Word, TXT, Markdown and more document formats',
    tip23: 'Uploaded docs can be auto-saved to knowledge base for retrieval',
    tip24: 'Drag and drop files to AI chat for quick upload',
    tip25: 'Multiple terminal themes available: Dracula, Monokai, Nord, etc.',
    tip26: 'Set different character encodings for different SSH servers',
    tip27: 'Organize multiple servers with session grouping',
    tip28: 'AI chat supports context, understands previous conversations',
    tip29: 'Ask AI directly how to use any command',
    tip30: 'Auto error detection in terminal, click for AI diagnosis',
    clickToSwitchTip: 'Click to switch tip'
  },


  // Smart Patrol
  patrol: {
    noSessions: 'No SSH Sessions',
    noSessionsDesc: 'Please add SSH server configurations in Session Manager first',
    noSessionsHint: 'No SSH sessions. Add remote servers or use local terminal only',
    goAddSessions: 'Add Sessions',
    inputPlaceholder: 'Describe your patrol task, e.g., Check disk usage on all production servers...',
    startExecution: 'Start',
    stopExecution: 'Stop',
    emptyTitle: 'Ready to start smart patrol',
    emptyDesc: 'Describe your task, Agent will automatically identify servers and execute',
    exampleTasks: 'Example Tasks',
    strategyLabels: {
      cautious: 'Cautious Mode',
      batch: 'Batch Confirm',
      free: 'Free Mode'
    },
    strategyDescs: {
      cautious: 'Confirm each dangerous command',
      batch: 'Batch confirm same commands',
      free: 'Auto execute (use with caution)'
    },
    exampleTask1: 'Check disk usage on all production servers',
    exampleTask2: 'View memory and CPU load on each server',
    exampleTask3: 'Check if nginx service is running properly'
  },


  // Common buttons and actions
  common: {
    save: 'Save',
    saving: 'Saving...',
    cancel: 'Cancel',
    confirm: 'Confirm',
    delete: 'Delete',
    edit: 'Edit',
    add: 'Add',
    new: 'New',
    close: 'Close',
    back: 'Back',
    next: 'Next',
    prev: 'Previous',
    skip: 'Skip',
    finish: 'Finish',
    search: 'Search',
    refresh: 'Refresh',
    copy: 'Copy',
    clear: 'Clear',
    enable: 'Enable',
    disable: 'Disable',
    enabled: 'Enabled',
    disabled: 'Disabled',
    loading: 'Loading...',
    unknown: 'Unknown',
    none: 'None',
    yes: 'Yes',
    no: 'No',
    success: 'Success',
    failed: 'Failed',
    error: 'Error',
    warning: 'Warning',
    info: 'Info',
    tips: 'Tips',
    version: 'Version',
    name: 'Name',
    type: 'Type',
    status: 'Status',
    actions: 'Actions',
    settings: 'Control Panel',
    help: 'Help',
    about: 'About',
    import: 'Import',
    export: 'Export',
    reset: 'Reset',
    apply: 'Apply',
    connect: 'Connect',
    disconnect: 'Disconnect',
    retry: 'Retry',
    select: 'Select',
    selectAll: 'Select All',
    unselectAll: 'Unselect All',
    noData: 'No data',
    confirmDelete: 'Are you sure you want to delete?',
    operationSuccess: 'Operation successful',
    operationFailed: 'Operation failed',
    // Confirm dialog related
    size: 'Size',
    count: 'Count',
    items: 'item(s)'
  },


  // Header toolbar
  header: {
    hostManager: 'Host Manager',
    aiAssistant: 'AI Assistant',
    settings: 'Control Panel',
    closeSidebar: 'Close Sidebar',
    appMenu: 'Application Menu (Alt)'
  },


  // Windows custom title bar controls (rendered on Windows only)
  windowControls: {
    minimize: 'Minimize',
    maximize: 'Maximize',
    restore: 'Restore Down',
    close: 'Close'
  },


  // About page
  about: {
    title: 'SailFish',
    description: 'AI-powered smart assistant',
    contact: 'Contact Us',
    qqGroup: 'QQ Group',
    qqGroupCopied: 'Group number copied',
    license: 'License',
    website: 'Website',
    copyright: '© 2026 SailFish',
    // Update check
    checkUpdate: 'Check for Updates',
    checkingUpdate: 'Checking for updates...',
    newVersionAvailable: 'New version {version} available',
    downloadUpdate: 'Download Update',
    downloadingUpdate: 'Downloading update...',
    updateReady: 'Version {version} is ready',
    installAndRestart: 'Install and Restart',
    upToDate: 'You are up to date',
    updateError: 'Failed to check for updates',
    autoCheckUpdate: 'Auto Check for Updates',
    autoCheckUpdateHint: 'Automatically check for new versions on startup',
    autoDownloadUpdate: 'Auto Download & Silent Install',
    goToDownload: 'Go to Download',
    downloadSource: 'Download Source',
    sourceRecommended: 'Best',
    sourceUnreachable: 'N/A',
    // Sponsor support
    supportTitle: 'Support the Author',
    supportDescription: 'If you find this software helpful, consider buying me a coffee ☕',
    wechatPay: 'WeChat Pay',
    alipay: 'Alipay',
    thanksMessage: 'Every support fuels my motivation!',
    thanksDetail: 'Your recognition means the world. SailFish will keep evolving ✨'
  },


  // Sponsor features
  sponsor: {
    badge: '✨ Sponsor',
    confirmButton: 'I Supported',
    confirmTitle: 'Confirm Support',
    confirmMessage: 'Thank you for your support! Click confirm to unlock exclusive perks 🎁',
    exclusive: 'Exclusive',
    unlockHint: 'Unlock after supporting',
    thanksUnlock: 'Thanks for support! Exclusive perks unlocked 🎉',
    resetButton: 'Reset sponsor status (for testing)',
    resetConfirm: 'Are you sure you want to reset sponsor status? This will remove sponsor perks and can be used to test the sponsor flow again.'
  },


  // Language Settings
  languageSettings: {
    title: 'Language Settings',
    selectLanguage: 'Select Language',
    languages: {
      'zh-CN': '简体中文',
      'en-US': 'English'
    },
    restartHint: 'Some changes may require restarting the app to take effect'
  },


  // Connection status panel
  conn: {
    connected: 'connected',
    channels: 'Channels',
    mcpServers: 'MCP',
    noChannels: 'No channels configured',
    goSetup: 'Set up',
    connect: 'Connect',
    disconnect: 'Disconnect',
    start: 'Start',
    stop: 'Stop',
    settings: 'Settings',
  }
}
