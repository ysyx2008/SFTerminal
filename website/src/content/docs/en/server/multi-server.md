---
title: "Multi-Server Management"
description: "Manage multiple servers simultaneously for greater operational efficiency"
---

# Multi-Server Management

If you manage multiple servers, SailFish's multi-tab interface, grouping, and AI collaboration features can significantly improve your workflow.

## Multi-Tab Operations

Each server connection opens in a new tab. You can have multiple tabs open and switch between them:

| Tab | Purpose |
|-----|---------|
| Production server A | Monitor status |
| Production server B | View logs |
| Staging environment | Deploy and verify |
| Database server | Manage data |
| Local terminal | Development and debugging |

### Tab Actions

- **New tab**: Click the `+` button or press `Ctrl/Cmd + T`
- **Switch**: Click a tab or press `Ctrl/Cmd + Tab`
- **Close**: Click the tab `×` or press `Ctrl/Cmd + W`
- **Rename**: Right-click a tab and choose "Rename" (helpful when managing many servers)
- **Reorder**: Drag tabs to change their order

Each tab has its **own** terminal and AI conversation—a conversation in server A's tab does not affect server B.

## Server Groups

When you have many servers, groups help you quickly find the right one.

### Creating Groups

In **Settings → SSH Connection Management**, you can assign each server to a group:

- **By environment**: Production / Staging / Development / Pre-release
- **By project**: Project A / Project B / Project C
- **By role**: Web servers / Database / Cache / Message queue
- **By region**: Datacenter A / Datacenter B / Offshore

### Using Groups

Once grouped, the left sidebar shows servers by group:

```
▼ Production
    web-01 (10.0.1.10)
    web-02 (10.0.1.11)
    db-master (10.0.1.20)
▼ Staging
    test-web (10.0.2.10)
    test-db (10.0.2.20)
▶ Development
    ...
```

Click a group name to expand or collapse it; click a server to connect.

## Xshell Session Import

Users migrating from Xshell can import all session configurations in one step while keeping the existing group structure:

1. Open **Settings → SSH Connection Management**
2. Click **Import** → **Xshell**
3. Select your Xshell sessions directory (often `Documents/NetSarang Computer/6/Xshell/Sessions`)
4. Confirm import

Import includes:

- Server address, port, and username
- Authentication (password or key)
- Folder/group structure

## AI and Host Profiles

After connecting to multiple servers, SailFish's AI maintains a **Host Profile** for each server.

### What is a Host Profile

A host profile is the AI's "dossier" for a server, including:

- **Operating system**: CentOS 7, Ubuntu 22.04, Debian 12, etc.
- **Installed software**: nginx, Docker, MySQL, Python version, etc.
- **Network config**: IP address, open ports
- **Common paths**: App deployment path, log path, config path
- **Usage patterns**: Commands and workflows you often use

### Benefits of Host Profiles

With host profiles, the AI does not need to relearn the server environment each time:

| Without Profile | With Profile |
|-----------------|--------------|
| You: Restart the web service<br>AI: What web server are you using? nginx? Apache? | You: Restart the web service<br>AI: This server uses nginx. Running `systemctl restart nginx` |
| You: Check the logs<br>AI: Where are the logs located? | You: Check the logs<br>AI: Checking /var/log/nginx/error.log (path from your earlier confirmation) |

Profiles accumulate automatically—the more you use a server, the better the AI knows it.

### Teaching the AI Manually

You can also proactively tell the AI important information:

```
Remember: This server is the web frontend. The app is at /home/app/frontend,
managed with PM2, with nginx as reverse proxy
```

The AI saves this information to the server's profile.

## Cross-Server Operations

In each tab, the AI knows which server it is connected to.

### Typical Workflow

In the **production web server** tab:

```
Check nginx status and recent error logs—any 502 errors?
```

Switch to the **database server** tab:

```
Check MySQL slow query log—any queries over 5 seconds?
```

Switch to the **local terminal** tab:

```
Based on what we found on those two servers, analyze the possible causes of the 502 errors
```

> Each tab has its own conversation context, but you can summarize findings from one tab verbally in another to have the AI synthesize the analysis.

## Batch Operations

When you need to run the same operations on multiple servers:

### Option 1: One by One

1. Have the AI run and verify the operation on one server first
2. Once confirmed correct, tell the AI to run the same operation on other servers

### Option 2: Script It

```
Write a shell script that:
1. Stops nginx
2. Updates config from /tmp/nginx.conf
3. Tests config syntax
4. Starts nginx
5. Verifies the service status
```

Then run the script on each server.

### Option 3: Use Awaken Mode

For recurring tasks across multiple servers (e.g. health checks), create a Watch in Awaken mode to automate them. See [Awaken Mode Introduction](/docs/awaken/awaken-intro).
