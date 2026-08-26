// 外部集成：邮箱技能、Gateway 通知、IM 通知
export default {

  // 邮箱技能
  email: {
    no_accounts_configured: '未配置邮箱账户，请先在设置中添加邮箱账户',
    account_not_found: '未找到邮箱账户: {id}',
    already_connected: '邮箱 {email} 已连接',
    credential_not_found: '未找到邮箱 {email} 的凭据，请在设置中重新配置',
    connected: '已连接到邮箱 {email}',
    connect_failed: '连接邮箱失败',
    not_connected: '未连接邮箱，请先调用 email_connect',
    folder_list: '文件夹列表',
    folder_not_found: '文件夹 {folder} 不存在',
    folder_empty: '文件夹 {folder} 为空',
    total_messages: '封邮件',
    page_info: '第 {page} 页，每页 {limit} 封',
    unknown_sender: '未知发件人',
    no_subject: '(无主题)',
    uid_required: '请指定邮件 UID',
    message_not_found: '未找到 UID 为 {uid} 的邮件',
    from: '发件人',
    to: '收件人',
    cc: '抄送',
    bcc: '密送',
    subject: '主题',
    date: '日期',
    body: '正文',
    body_truncated: '正文已截断',
    content: '内容',
    text_not_available: '纯文本版本不可用',
    no_content: '(无内容)',
    attachments: '附件',
    unknown_size: '未知大小',
    unnamed_attachment: '未命名附件',
    chars: '字符',
    search_results: '搜索结果',
    found: '封匹配',
    showing: '显示 {count} 封',
    no_results: '未找到匹配的邮件',
    search_failed: '搜索失败',
    to_and_subject_required: '请指定收件人和主题',
    send_confirm: '确认发送邮件',
    files: '个文件',
    user_rejected: '用户取消了操作',
    attachment_not_found: '附件文件不存在: {path}',
    sent_success: '邮件已发送到 {to}，Message-ID: {messageId}',
    send_failed: '发送邮件失败',
    uids_required: '请指定要操作的邮件 UID 列表',
    target_folder_required: '移动操作需要指定目标文件夹',
    action_trash: '将邮件移动到垃圾箱',
    action_delete: '永久删除邮件（不可恢复）',
    action_move: '将邮件移动到 {folder}',
    affected_messages: '影响的邮件数',
    operation_success: '操作成功，已处理 {count} 封邮件: {action}',
    operation_failed: '操作失败',
    list_failed: '获取邮件列表失败',
    read_failed: '读取邮件失败',
    output_truncated: '输出已截断'
  },


  // Gateway 远程访问通知
  gateway: {
    remoteTaskStarted: '远程任务开始',
    remoteConnected: '远程客户端已连接',
    remoteChat: '远程对话'
  },


  // IM 渠道连接状态通知
  im: {
    channelConnected: '{platform} 已连接',
    channelDisconnected: '{platform} 连接已断开',
    wechatSendFailed: '未能发送到微信。请在微信里再给我任意发一条消息。',
  },
}
