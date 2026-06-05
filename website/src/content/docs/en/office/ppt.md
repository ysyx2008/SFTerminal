---
title: "PPT Presentations"
description: "Let AI generate editable PowerPoint presentations for you"
---

# PPT Presentations

SailFish's AI Agent can generate **native editable** PowerPoint files (`.pptx`). Just describe the content and style — the AI handles layout, rendering, and export. Text stays editable in PowerPoint; you are not stuck with flat images you cannot change.

![PPT generation: Agent plans and renders on the left, Canvas slide preview on the right](/screenshot-ppt.png)

## Quick Start

Tell the AI what presentation you need:

```
Create an 8-slide product intro deck in 16:9 widescreen —
cover, market pain points, product solution, key features, and summary
```

```
Turn the server inspection results above into a 5-slide report and save to report.pptx on my desktop
```

The AI renders slide by slide with real-time Canvas preview and tells you where the `.pptx` was saved.

## What Makes It Different

| Feature | Description |
|---------|-------------|
| Native & editable | Standard `.pptx` with native text, bullets, shapes, and images — continue editing in PowerPoint or Keynote |
| Browser layout | Each slide's HTML is rendered by local Chrome/Edge for accurate layout, avoiding coordinate overlap from hand-calculated positions |
| Canvas preview | Preview each slide in the assistant Canvas panel during generation; open the file or reveal in folder |
| Streaming progress | Shows "Rendering slide i/N" so long decks are not a black box |
| Append mode | Build long decks in multiple passes — new slides append to the same file without truncation |

## Supported Slide Elements

AI-created slides support common layout elements:

| Element | Description |
|---------|-------------|
| Headings & body | `<h1>`–`<h6>`, `<p>` paragraphs with bold, italic, underline |
| Bullets | Ordered and unordered lists |
| Card shapes | `<div>` blocks with background, border radius, and borders |
| Images | Local image paths; charts can be generated as PNG via the chart skill first |
| Aspect ratio | 16:9 widescreen (default) or 4:3 standard |

## Use Cases

### Work Reports

```
Based on this week's Git commits, create a 6-slide weekly report deck —
completed tasks, code stats, issues encountered, and next week's plan
```

```
Organize server CPU, memory, and disk usage into a 4-slide ops report
```

### Product Demos

```
Create a 10-slide investor pitch deck —
clean and professional, covering market opportunity, product highlights, business model, and team
```

### Training Materials

```
Create a 12-slide Git intro training deck —
one core concept per slide with example commands
```

### Appending Long Decks

For longer presentations, generate in multiple passes:

```
Append 5 more slides about the technical architecture to demo.pptx
```

The AI reads the existing deck config, appends new slides at the end, and re-exports the complete file.

## Requirements

- **Local browser**: Chrome, Edge, or Chromium must be installed (same as the browser skill, used for headless rendering)
- **Supported modes**: Local terminal and AI assistant modes; rendering runs on your machine — **not supported** on SSH remote sessions
- **Slide limit**: Recommended up to 50 slides per job

## File Location & Access

Generated `.pptx` files are saved in the Agent workspace or a path you specify. Ways to access them:

| Method | Action |
|--------|--------|
| Canvas preview | View each slide in the assistant Canvas panel during generation; click Open or Reveal in Folder |
| Check path | Ask the AI where the file was saved |
| Send via IM | Ask the AI to send the file via DingTalk, Feishu, WeCom, or Slack |
| Move file | Ask the AI to move it somewhere (e.g., desktop) |

Common commands:

```
Move the PPT you just created to my desktop
```

```
Send this presentation to me via Feishu
```

## Working with Word and Excel

SailFish also handles Word and Excel documents:

- **Word**: Reports, proposals, meeting notes, and other long-form documents
- **Excel**: Data analysis and spreadsheet work

```
Read quarterly data from sales.xlsx and create an 8-slide performance analysis deck
```

```
Extract the key points from this Word report into a 5-slide presentation
```
