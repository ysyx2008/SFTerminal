// 通用 UI 词汇：应用基础、欢迎页、巡检、按钮文案、头部、关于、赞助、语言、连接状态
export default {

  // 应用级别
  app: {
    title: '旗鱼',
    description: 'AI 驱动的智能助手'
  },


  // 欢迎页
  welcome: {
    title: '欢迎使用旗鱼',
    titleSteam: '欢迎使用旗鱼终端',
    subtitle: 'AI 驱动的智能助手',
    subtitleSteam: '高效的终端与连接管理工具',
    quickStart: '快速开始',
    assistant: 'AI 助手',
    assistantDesc: '与 AI 直接对话',
    localTerminal: '本地终端',
    localTerminalDesc: '打开本机命令行终端',
    sshConnect: 'SSH 连接',
    sshConnectDesc: '连接远程服务器',
    smartPatrol: '智能巡检',
    smartPatrolDesc: 'AI 自动巡检多台服务器',
    watch: '关切',
    watchDesc: '查看运营总览与监控',
    comingSoon: '即将推出',
    recentConnections: '最近连接',
    viewAllSessions: '查看全部会话',
    tip1: '按 Ctrl+T / Cmd+T 可快速新建终端标签页',
    tip2: '右键终端可将选中内容发送给 AI 分析',
    tip3: '开启助手模式，让 AI 自动执行复杂任务',
    tip4: '支持导入 Xshell 会话配置，一键迁移',
    tip5: 'AI 回复中的代码块可一键发送到终端执行',
    tip6: '按 Ctrl+W 可快速关闭当前终端标签页',
    tip7: '上传文档到知识库，AI 会自动检索相关内容',
    tip8: '助手会自动探测主机环境，了解系统和已安装工具',
    tip9: '可以为助手设置 MBTI 性格，获得不同风格的回复',
    tip10: '配置 MCP 服务器，让 AI 能访问外部工具和资源',
    tip11: '知识库支持 PDF、Word、文本等多种文档格式',
    tip12: '助手可以记住重要信息，下次交互时自动提供',
    tip13: '双击会话可快速连接 SSH 服务器',
    tip14: '支持通过跳板机连接内网服务器',
    tip15: 'SFTP 文件管理器支持拖拽上传下载',
    tip16: '每个终端标签页都有独立的 AI 对话记录',
    tip17: '终端配色自动与界面主题融合，切换主题即可改变整体风格',
    tip18: '严格模式下每个命令都需要确认才会执行',
    tip19: '宽松模式下只有危险命令需要确认',
    tip20: '支持多种 AI 模型：OpenAI、通义千问、DeepSeek、Ollama',
    tip21: '可以上传文档与 AI 对话，让 AI 帮你分析文档内容',
    tip22: '支持上传 PDF、Word、TXT、Markdown 等多种文档格式',
    tip23: '上传的文档可自动保存到知识库，随时检索',
    tip24: '在 AI 对话框拖拽文件即可快速上传',
    tip25: '支持多种终端主题：Dracula、Monokai、Nord 等',
    tip26: '可以为不同的 SSH 服务器设置不同的字符编码',
    tip27: '会话支持分组管理，方便组织多台服务器',
    tip28: 'AI 对话支持上下文，能理解之前的对话内容',
    tip29: '可以直接询问 AI 如何使用某个命令',
    tip30: '终端出错时会自动提示，点击即可让 AI 诊断',
    clickToSwitchTip: '点击切换提示'
  },


  // 智能巡检
  patrol: {
    noSessions: '暂无 SSH 会话',
    noSessionsDesc: '请先在会话管理器中添加 SSH 服务器配置',
    noSessionsHint: '暂无 SSH 会话，可添加远程服务器或仅使用本地终端',
    goAddSessions: '添加会话',
    inputPlaceholder: '描述你的巡检任务，例如：检查所有生产服务器的磁盘使用情况...',
    startExecution: '开始执行',
    stopExecution: '停止执行',
    emptyTitle: '准备好开始智能巡检了',
    emptyDesc: '描述你的任务，助手会自动识别需要检查的服务器并执行',
    exampleTasks: '示例任务',
    strategyLabels: {
      cautious: '审慎模式',
      batch: '批量确认',
      free: '自由模式'
    },
    strategyDescs: {
      cautious: '每个危险命令都确认',
      batch: '相同命令批量确认',
      free: '自动执行（谨慎使用）'
    },
    exampleTask1: '检查所有生产服务器的磁盘使用情况',
    exampleTask2: '查看各服务器的内存和CPU负载',
    exampleTask3: '检查 nginx 服务是否正常运行'
  },


  // 通用按钮和操作
  common: {
    save: '保存',
    saving: '保存中...',
    cancel: '取消',
    confirm: '确定',
    delete: '删除',
    edit: '编辑',
    add: '添加',
    new: '新建',
    close: '关闭',
    back: '返回',
    next: '下一步',
    prev: '上一步',
    skip: '跳过',
    finish: '完成',
    search: '搜索',
    refresh: '刷新',
    copy: '复制',
    clear: '清空',
    enable: '启用',
    disable: '禁用',
    enabled: '已启用',
    disabled: '未启用',
    loading: '加载中...',
    unknown: '未知',
    none: '无',
    yes: '是',
    no: '否',
    success: '成功',
    failed: '失败',
    error: '错误',
    warning: '警告',
    info: '信息',
    tips: '提示',
    version: '版本',
    name: '名称',
    type: '类型',
    status: '状态',
    actions: '操作',
    settings: '控制面板',
    help: '帮助',
    about: '关于',
    import: '导入',
    export: '导出',
    reset: '重置',
    apply: '应用',
    connect: '连接',
    disconnect: '断开',
    retry: '重试',
    select: '选择',
    selectAll: '全选',
    unselectAll: '取消全选',
    noData: '暂无数据',
    confirmDelete: '确定要删除吗？',
    operationSuccess: '操作成功',
    operationFailed: '操作失败',
    // 确认框相关
    size: '大小',
    count: '数量',
    items: '个项目'
  },


  // 头部工具栏
  header: {
    hostManager: '主机管理',
    aiAssistant: 'AI 助手',
    settings: '控制面板',
    closeSidebar: '关闭侧边栏',
    appMenu: '应用菜单（Alt）'
  },


  // Windows 自绘标题栏按钮（仅 Win 平台显示）
  windowControls: {
    minimize: '最小化',
    maximize: '最大化',
    restore: '向下还原',
    close: '关闭'
  },


  // 关于页面
  about: {
    title: '旗鱼',
    description: 'AI 驱动的智能助手',
    contact: '联系我们',
    qqGroup: 'QQ 交流群',
    qqGroupCopied: '群号已复制',
    license: '开源协议',
    website: '官方网站',
    copyright: '© 2026 旗鱼',
    // 更新检测
    checkUpdate: '检查更新',
    checkingUpdate: '正在检查更新...',
    newVersionAvailable: '发现新版本 {version}',
    downloadUpdate: '下载更新',
    downloadingUpdate: '正在下载更新...',
    updateReady: '版本 {version} 已准备就绪',
    installAndRestart: '安装并重启',
    upToDate: '当前已是最新版本',
    updateError: '检查更新失败',
    autoCheckUpdate: '自动检查更新',
    autoCheckUpdateHint: '启动时自动检查是否有新版本',
    autoDownloadUpdate: '自动下载并静默安装',
    goToDownload: '前往下载',
    downloadSource: '下载源',
    sourceRecommended: '推荐',
    sourceUnreachable: '不可达',
    // 赞助支持
    supportTitle: '支持作者',
    supportDescription: '如果旗鱼让你的工作更高效，欢迎请作者喝杯咖啡 ☕',
    wechatPay: '微信赞赏',
    alipay: '支付宝',
    thanksMessage: '每一份支持都是前进的动力！',
    thanksDetail: '你的认可是对作者最大的鼓励，旗鱼会持续进化，不负期待 ✨'
  },


  // 赞助者功能
  sponsor: {
    badge: '✨ 赞助者',
    confirmButton: '我已支持',
    confirmTitle: '确认支持',
    confirmMessage: '感谢你的支持！点击确认后即可解锁专属特权 🎁',
    exclusive: '专属',
    unlockHint: '支持作者后解锁',
    thanksUnlock: '感谢支持！专属特权已解锁 🎉',
    resetButton: '重置赞助状态（测试用）',
    resetConfirm: '确定要重置赞助状态吗？这将移除赞助者特权，可用于重新测试赞助流程。'
  },


  // 语言设置
  languageSettings: {
    title: '语言设置',
    selectLanguage: '选择语言',
    languages: {
      'zh-CN': '简体中文',
      'en-US': 'English'
    },
    restartHint: '部分更改可能需要重启应用才能生效'
  },


  // 连接状态面板
  conn: {
    connected: '已连接',
    channels: '远程渠道',
    mcpServers: 'MCP',
    noChannels: '未配置渠道',
    goSetup: '去设置',
    connect: '连接',
    disconnect: '断开',
    start: '启动',
    stop: '停止',
    settings: '设置',
  }
}
