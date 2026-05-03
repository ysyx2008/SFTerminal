---
title: 'Multi-pane Terminal Splits'
description: 'Work with local terminals and multiple SSH sessions side by side in one tab'
---

# Multi-pane Terminal Splits

Multi-pane splits are useful when you need to watch and operate multiple environments at the same time: keep production logs visible, verify commands on staging, and keep a local terminal open for scripts.

## When to Use Splits

- Watch logs, run commands, and inspect service status side by side
- Compare production, staging, and local output
- Run an operation on one server while observing its effect on another
- Let the AI analyze the output from the currently active pane

If you only need to switch between unrelated tasks, multiple tabs are enough. If several environments need to stay visible at once, use splits.

## Creating a Split

Open the terminal menu in the top-right and choose:

- **Split Horizontally**: Open a new pane beside the current pane
- **Split Vertically**: Open a new pane below the current pane
- **Split and connect to…**: Choose what the new pane should connect to

Regular splits inherit the current pane's connection type. For example, if the current pane is an SSH session, the new pane opens in the same kind of SSH context.

## Split and Connect To

Use **"Split and connect to…"** when you want the new pane to open another environment directly:

1. Open the terminal menu
2. Choose **"Split and connect to…"**
3. Pick the direction: horizontal or vertical
4. Choose the connection target:
   - **Local terminal**
   - A saved **SSH session**
5. Click **"Split"**

This lets one tab contain a local terminal, a production SSH session, and a staging SSH session. Each pane has its own connection state and working directory.

## Switching and Closing Panes

- **Switch panes**: Click any pane to activate it
- **Close a pane**: Choose **"Close Pane"** from the pane menu
- **Shortcuts**: Split and close-pane shortcuts can be viewed and customized under **Settings → Keyboard Shortcuts**

When only one pane remains in a tab, closing behavior returns to normal tab behavior.

## How the Agent Chooses a Pane

The Agent works with the currently active pane:

- The pane you click becomes the current target
- When analyzing terminal output, the AI prioritizes the active pane
- When running commands, the AI uses the local or SSH environment behind the active pane

If you want the AI to operate a specific server, click that pane before sending your request.

## Typical Workflows

### Production Troubleshooting

1. Keep production logs open on the left with `journalctl` or app logs
2. Open staging on the right to reproduce the issue and test commands
3. Ask the AI to analyze the active pane's error, then switch panes to run the suggested command elsewhere

### Local Script + Remote Verification

1. Use a local terminal on the left to edit and run scripts
2. Connect to a remote server on the right to observe service impact
3. Add another split for logs when needed

### Multi-server Comparison

1. Open production, pre-production, and staging servers in one tab
2. Run the same inspection command in each pane
3. Ask the AI to compare outputs and identify configuration drift

## Tips

- Avoid too many panes; 2-4 panes are easiest to manage
- Give SSH sessions clear names to avoid operating on production by mistake
- Before running risky commands, confirm that the intended pane is active
- If tasks are unrelated, opening a new tab is cleaner than adding more splits
