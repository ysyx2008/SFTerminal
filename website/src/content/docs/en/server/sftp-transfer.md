---
title: "SFTP File Transfer"
description: "Transfer files between local and remote servers via SFTP"
---

# SFTP File Transfer

When you connect to an SSH server, SailFish automatically establishes an SFTP channel. You can browse, upload, download, and edit remote files through a visual interface—no need to memorize any commands.

## Opening the Remote File Manager

1. Connect to an SSH server first (see [SSH Connection](/en/docs/server/ssh-connection))
2. Click the **file manager icon** (folder icon) in the left sidebar
3. The file manager automatically displays the remote server's file system

> If the current tab is a local terminal, the file manager shows local files. Switch to an SSH tab and it will automatically display remote files.

## Browsing Files

### Navigation

- **Click a folder** to enter a subdirectory
- **Click the path bar** to type a path for quick navigation (e.g. `/var/log/nginx`)
- **Click the back arrow** to go to the parent directory
- **Click the home icon** to jump to your user home directory

### File Information

For each file or folder, the list shows:

- Name and icon (based on type)
- File size
- Modification time
- Permissions (rwx format)

### Display Options

- **Hidden files**: Toggle with the "Show hidden files" button in the toolbar (files starting with `.`)
- **Sort**: By name, size, or modification time

## Uploading Files

Transfer files from your local machine to the remote server:

### Drag and Drop

The most intuitive method—drag files from your system file manager (Finder or File Explorer) directly onto SailFish's file manager panel.

- Supports multiple files
- Supports folders (recursive upload)
- A progress bar shows upload status

### Upload Button

Click the **Upload** button in the toolbar and select local files in the file picker.

### Upload Notes

- Files are uploaded to the current directory
- If a file with the same name exists, you will be prompted to overwrite
- For large files, wait for completion; the progress bar shows transfer status
- Ensure the remote directory has write permissions (otherwise uploads will fail)

## Downloading Files

Download files from the remote server to your local machine:

1. Locate the file in the file list
2. Right-click the file and choose **Download**
3. Select the local save location
4. Wait for the download to complete

> **Tip**: To download an entire directory, ask the AI to pack it into tar.gz first, then download the archive:
> ```
> Pack /var/log/nginx into a tar.gz file so I can download it
> ```

## Editing Remote Files

Double-click a text file to open it in the built-in editor. The editor supports:

- **Syntax highlighting**: Automatically detects file type and applies highlighting
- **Save sync**: Press `Ctrl/Cmd + S` to save; changes sync back to the server
- **Large file warning**: Prompts when opening very large files to avoid lag

Common editing scenarios:

| File Type | Typical Files |
|-----------|---------------|
| Web server config | `nginx.conf`, `apache2.conf`, `.htaccess` |
| App config | `docker-compose.yml`, `config.yaml`, `.env` |
| Scripts | `deploy.sh`, `backup.sh`, `crontab` |
| Application code | `.py`, `.js`, `.go` and other code files |

> Binary files (images, archives) cannot be opened in the editor; double-clicking them will show an unsupported message.

## File Operations

Right-click a file or folder for these options:

| Action | Description |
|--------|-------------|
| New File | Create an empty file in the current directory |
| New Folder | Create a folder in the current directory |
| Rename | Change the file or folder name |
| Delete | Delete the file or folder (⚠️ Cannot be undone; use with care) |
| Permissions | View and change Unix permissions (e.g. 755, 644) |
| Download | Download to local machine |

## Asking the AI to Handle Files

Besides the visual interface, you can use natural language to have the AI perform more complex file operations:

### Basic Operations

```
Download /var/log/nginx/access.log from the server to my local desktop
```

```
Upload my local deploy.sh to /home/user/ on the server
```

### Batch Operations

```
Delete log files older than 7 days in /var/log/
```

```
Back up all .conf files from /home/app/config/ to /home/app/config_backup/
```

### File Analysis

```
Check the last 50 lines of /var/log/nginx/error.log for any errors
```

```
Count files by type and total size in /home/data/
```

### Pack and Download

```
Pack today's logs from /home/app/logs/ into a single tar.gz file
```
