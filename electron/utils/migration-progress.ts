import { app, BrowserWindow } from 'electron'

export interface MigrationProgressOptions {
  titleZh: string
  titleEn: string
  subtitleZh: string
  subtitleEn: string
}

function progressWindowHtml(opts: MigrationProgressOptions): string {
  const zh = app.getLocale().toLowerCase().startsWith('zh')
  const title = zh ? opts.titleZh : opts.titleEn
  const sub = zh ? opts.subtitleZh : opts.subtitleEn
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      background:#1e1e24;color:#e6e6ea;user-select:none;-webkit-user-select:none;overflow:hidden}
    .wrap{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 28px;box-sizing:border-box}
    .title{font-size:15px;font-weight:600;margin-bottom:4px}
    .sub{font-size:12px;color:#9a9aa5;margin-bottom:18px}
    .bar{height:8px;background:#34343c;border-radius:6px;overflow:hidden}
    .fill{height:100%;width:0;background:linear-gradient(90deg,#4f8cff,#a855f7);border-radius:6px;transition:width .15s ease}
    .meta{display:flex;justify-content:space-between;margin-top:10px;font-size:11px;color:#9a9aa5}
    .file{max-width:70%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
  </style></head><body><div class="wrap">
    <div class="title">${title}</div>
    <div class="sub">${sub}</div>
    <div class="bar"><div class="fill" id="fill"></div></div>
    <div class="meta"><span class="file" id="file"></span><span id="pct">0%</span></div>
  </div><script>
    window.__setProgress=function(pct,name){
      document.getElementById('fill').style.width=pct+'%';
      document.getElementById('pct').textContent=pct+'%';
      if(name!=null)document.getElementById('file').textContent=name;
    };
  </script></body></html>`
}

export function createMigrationProgressWindow(opts: MigrationProgressOptions): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 460,
    height: 200,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    center: true,
    show: true,
    backgroundColor: '#1e1e24',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  const html = progressWindowHtml(opts)
  return new Promise((resolve) => {
    win.webContents.once('did-finish-load', () => resolve(win))
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  })
}

export function setMigrationProgress(win: BrowserWindow | null, pct: number, name: string): Promise<unknown> {
  if (!win || win.isDestroyed()) return Promise.resolve()
  const safeName = JSON.stringify(name)
  return win.webContents.executeJavaScript(`window.__setProgress(${pct}, ${safeName})`).catch(() => {})
}
