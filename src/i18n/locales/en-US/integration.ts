// 外部集成：邮箱技能、Gateway 通知、IM 通知
export default {

  // Email Skill
  email: {
    no_accounts_configured: 'No email accounts configured. Please add an email account in settings first.',
    account_not_found: 'Email account not found: {id}',
    already_connected: 'Email {email} is already connected',
    credential_not_found: 'Credential not found for {email}. Please reconfigure in settings.',
    connected: 'Connected to {email}',
    connect_failed: 'Failed to connect to email',
    not_connected: 'Not connected to email. Please call email_connect first.',
    folder_list: 'Folder List',
    folder_not_found: 'Folder {folder} not found',
    folder_empty: 'Folder {folder} is empty',
    total_messages: 'messages',
    page_info: 'Page {page}, {limit} per page',
    unknown_sender: 'Unknown Sender',
    no_subject: '(No Subject)',
    uid_required: 'Please specify email UID',
    message_not_found: 'Email with UID {uid} not found',
    from: 'From',
    to: 'To',
    cc: 'CC',
    bcc: 'BCC',
    subject: 'Subject',
    date: 'Date',
    body: 'Body',
    body_truncated: 'body truncated',
    content: 'content',
    text_not_available: 'plain text version not available',
    no_content: '(No Content)',
    attachments: 'Attachments',
    unknown_size: 'unknown size',
    unnamed_attachment: 'Unnamed Attachment',
    chars: 'chars',
    search_results: 'Search Results',
    found: 'found',
    showing: 'Showing {count}',
    no_results: 'No matching emails found',
    search_failed: 'Search failed',
    to_and_subject_required: 'Please specify recipient and subject',
    send_confirm: 'Confirm Send Email',
    files: 'files',
    user_rejected: 'User cancelled the operation',
    attachment_not_found: 'Attachment file not found: {path}',
    sent_success: 'Email sent to {to}, Message-ID: {messageId}',
    send_failed: 'Failed to send email',
    uids_required: 'Please specify email UID list',
    target_folder_required: 'Move operation requires target folder',
    action_trash: 'Move emails to Trash',
    action_delete: 'Permanently delete emails (cannot be undone)',
    action_move: 'Move emails to {folder}',
    affected_messages: 'Affected messages',
    operation_success: 'Operation successful, {count} emails processed: {action}',
    operation_failed: 'Operation failed',
    list_failed: 'Failed to get email list',
    read_failed: 'Failed to read email',
    output_truncated: 'output truncated'
  },


  // Gateway remote access notifications
  gateway: {
    remoteTaskStarted: 'Remote task started',
    remoteConnected: 'Remote client connected',
    remoteChat: 'Remote Chat'
  },


  // IM channel connection notifications
  im: {
    channelConnected: '{platform} connected',
    channelDisconnected: '{platform} disconnected',
  },
}
