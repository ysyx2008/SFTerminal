---
title: 'SSH Connection'
description: 'Configure SSH connections, manage session groups, and use jump hosts or bastion hosts'
---

# SSH Connection

SailFish supports connecting to remote servers via SSH, with session management, grouping, and jump host features.

## Creating an SSH Session

1. Click the **"Manage Hosts"** button at the bottom of the left sidebar
2. Click **"New Host"**
3. Fill in the connection details:
   - **Session Name**: A custom label (e.g., "Production Server")
   - **Host**: Server IP or domain
   - **Port**: SSH port, default 22
   - **Username**: Login username
   - **Auth Type**: Password or private key

4. Click **"Save"**, then click the session in the list to connect

## Authentication

### Password

Enter your username and password. Passwords are stored encrypted locally.

### Private Key

1. Set auth type to **"Private Key"**
2. Enter the path to your key file (e.g., `~/.ssh/id_rsa`)
3. If the key is passphrase-protected, enter the passphrase

## Session Groups

Organize servers by purpose:

1. Click **"New Group"** in the host management panel
2. Enter a group name (e.g., "Production", "Staging")
3. Assign sessions to groups when editing them

Groups support **jump host** configuration — all sessions in a group inherit it automatically (see below).

## Jump Host / Bastion Host

In enterprise environments, servers are usually behind a bastion host (jump server) for security and auditing. SailFish natively supports jump host connections and is compatible with JumpServer and other bastion host products.

### How It Works

```
SailFish → Jump Host (Bastion) → Target Server
```

SailFish first establishes an SSH connection to the jump host, then tunnels through it to reach the target server. All operations pass through the bastion, so session recording and command auditing work as expected.

### Configuration

Jump hosts can be configured at the **group level** or **session level**:

#### Option 1: Group Level (Recommended)

Put all servers behind the same bastion host in one group:

1. Edit the group → check **"Enable Jump Host"**
2. Fill in the jump host details:
   - **Host**: Bastion host address
   - **Port**: SSH port (JumpServer typically uses **2222**)
   - **Username**: Bastion host login username
   - **Auth Type**: Password or private key
3. All sessions in this group will automatically route through this jump host

#### Option 2: Session Level

When a specific session needs a different jump host:

1. Edit the session → find the **"Jump Host"** section
2. Choose the mode:
   - **Inherit from Group** (default): Use the group's jump host
   - **Custom**: Configure a jump host specifically for this session
   - **Disable Jump Host**: Connect directly, even if the group has a jump host

### JumpServer Example

[JumpServer](https://github.com/jumpserver/jumpserver) is a widely-used open-source bastion host. SailFish connects through JumpServer via SSH jump host:

| Setting | Value |
|---------|-------|
| Jump Host | JumpServer IP or domain |
| Jump Port | **2222** (JumpServer default SSH port) |
| Username | Your JumpServer account |
| Auth Type | Password or key (depends on JumpServer config) |
| Target Host | The actual server you want to reach |
| Target Port | 22 (target server's SSH port) |

Once configured, SailFish will automatically log into JumpServer first, then reach the target machine through it. All operations are fully audited by the bastion host.

> **Tip**: Other bastion host products (e.g., Teleport, etc.) that support standard SSH protocols can be configured the same way.

### Priority Rules

Jump host configuration priority:

1. **Session override** — If the session has its own jump host, it takes priority
2. **Group inheritance** — If no session override, the group's jump host is used
3. **No jump host** — If the session explicitly disables it, or the group has none, connect directly

## Character Encoding

If you see garbled text when connecting to servers with non-UTF-8 encoding:

1. Edit the session → find the **"Character Encoding"** option
2. Common choices:
   - **UTF-8** (default, recommended)
   - **GBK** / **GB2312**: Legacy CentOS / Windows servers
   - **Big5**: Traditional Chinese environments
