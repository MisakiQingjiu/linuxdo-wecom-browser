/**
 * LinuxDO WeCom Browser
 * 内置 linuxdo-wecom.user.js（Linux DO · 企业微信 IM 外观）的 Electron 轻量浏览器。
 *
 * 与脚本的兼容要点：
 *  - 脚本声明 @run-at document-start + @grant none：这里用 contextIsolation:false 的
 *    preload 在页面主世界、任何站点脚本执行之前注入，等价于 Tampermonkey 的注入时机。
 *  - 只对 linux.do（含子域）注入，等价 @match https://linux.do/*，其他站点不受影响。
 *  - 移除 linux.do 响应中的 CSP 头，保证脚本注入的内联 <style>、data: 背景图不被拦截。
 *  - UA 去除 Electron / 应用名标记，避免被站点与 Cloudflare 差异化对待。
 *  - 会话使用 persist:linuxdo 分区：登录态与脚本的 localStorage 设置跨启动保留。
 */

const { app, BrowserWindow, WebContentsView, session, shell, ipcMain, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

const HOME_URL = 'https://linux.do/';
const TOOLBAR_HEIGHT = 44;
// 锁定企微 IM 视图：注入时强制回 IM 模式（防止误入原生视图），并把脚本聊天头部的
// 「切换原生视图」按钮改造为「复制当前链接」。想恢复脚本原始行为改为 false 后重启即可。
const LOCK_IM_VIEW = true;

app.setName('LinuxDO WeCom Browser');
app.setAppUserModelId('com.linuxdo.wecom.browser');

let mainWin = null;
let contentView = null;
let htmlFullscreen = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    }
  });
}

function isLinuxDoUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && (x.hostname === 'linux.do' || x.hostname.endsWith('.linux.do'));
  } catch {
    return false;
  }
}

function normalizeAddress(input) {
  const t = String(input || '').trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^([\w-]+\.)+[a-z]{2,}([/?#:]|$)/i.test(t)) return 'https://' + t;
  // 其余输入当作 linux.do 站内搜索关键词
  return 'https://linux.do/search?q=' + encodeURIComponent(t);
}

// --- UA 清理：去掉 Electron 与应用名标记 ---
function cleanUserAgent(ua) {
  const nameEsc = app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(ua)
    .replace(/\s*Electron\/[\d.]+/i, '')
    .replace(new RegExp('\\s*' + nameEsc + '\\/[\\d.]+', 'i'), '');
}

/**
 * 生成 userscript preload：把 vendor/linuxdo-wecom.user.js 原样包进 @match 守卫。
 * 生成文件放在 userData（打包后 __dirname 只读），每次启动按当前脚本内容重建。
 */
function buildUserscriptPreload() {
  const src = fs.readFileSync(path.join(__dirname, 'vendor', 'linuxdo-wecom.user.js'), 'utf8');
  const file = path.join(app.getPath('userData'), 'linuxdo-wecom.preload.js');
  const match = '/^https:\\/\\/([a-z0-9-]+\\.)*linux\\.do(:\\d+)?(\\/|$)/i';
  // 集成层补丁：跟随 userscript 在同一守卫内执行。
  // 点击拦截用 document 捕获阶段，先于脚本绑定在会话面板上的冒泡处理（setViewMode+reload）。
  const patch = LOCK_IM_VIEW
    ? `
/* ---- 集成层补丁：锁定 IM 视图；「切换原生视图」按钮改为复制当前链接 ---- */
(function () {
  try { localStorage.setItem('linuxdo-wecom-view', 'im'); } catch (e) { /* ignore */ }
  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:20%;transform:translateX(-50%);padding:8px 18px;border-radius:8px;background:rgba(20,22,25,.82);color:#fff;font-size:13px;pointer-events:none;transition:opacity .4s';
    document.body.appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; }, 900);
    setTimeout(function () { t.remove(); }, 1400);
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
  }
  document.addEventListener('click', function (e) {
    var target = e.target;
    var btn = target && target.closest ? target.closest('.wecom-chat-native') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    var url = location.href;
    var ok = function () { toast('链接已复制'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(ok, function () { fallbackCopy(url); ok(); });
    } else {
      fallbackCopy(url);
      ok();
    }
  }, true);
  function fixTitles() {
    var list = document.querySelectorAll('.wecom-chat-native');
    for (var i = 0; i < list.length; i++) list[i].title = '复制当前链接';
  }
  function startTitleFix() {
    fixTitles();
    setInterval(fixTitles, 2500);
  }
  if (document.body) startTitleFix();
  else document.addEventListener('DOMContentLoaded', startTitleFix);
})();
`
    : '';
  const code = `/* 由 main.js 在启动时从 vendor/linuxdo-wecom.user.js 自动生成，请勿手工修改。 */
if (${match}.test(location.href) && !window.__LINUXDO_WECOM_INJECTED__) {
  window.__LINUXDO_WECOM_INJECTED__ = true;
${src}
${patch}
}
`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, code, 'utf8');
  return file;
}

function setupSession() {
  const ses = session.fromPartition('persist:linuxdo');
  ses.setUserAgent(app.userAgentFallback);

  // 放行 linux.do 的 CSP：脚本需要注入内联样式与 data: 水印背景
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (isLinuxDoUrl(details.url)) {
      const headers = { ...details.responseHeaders };
      for (const key of Object.keys(headers)) {
        const lk = key.toLowerCase();
        if (lk === 'content-security-policy' || lk === 'content-security-policy-report-only') {
          delete headers[key];
        }
      }
      callback({ responseHeaders: headers });
    } else {
      callback({});
    }
  });

  // 权限：linux.do 上放行通知 / 全屏 / 剪贴板 / 媒体，其余拒绝
  const ALLOWED = new Set([
    'notifications', 'fullscreen', 'pointerLock',
    'clipboard-sanitized-write', 'clipboard-read', 'media',
  ]);
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    cb(isLinuxDoUrl(wc.getURL?.() || '') && ALLOWED.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission) => {
    return isLinuxDoUrl(wc?.getURL?.() || '') && ALLOWED.has(permission);
  });

  return ses;
}

function contentWebPreferences(ses, preloadFile) {
  return {
    session: ses,
    preload: preloadFile,
    // userscript 需要运行在页面主世界（等价 @grant none）；
    // 生成的 preload 不使用任何 Node API，因此仍保持沙箱开启。
    contextIsolation: false,
    sandbox: true,
  };
}

function layout() {
  if (!mainWin || mainWin.isDestroyed() || !contentView) return;
  const [w, h] = mainWin.getContentSize();
  const top = htmlFullscreen ? 0 : TOOLBAR_HEIGHT;
  contentView.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
}

function pushState(wc) {
  if (!mainWin || mainWin.isDestroyed() || !contentView) return;
  if (wc !== contentView.webContents) return;
  mainWin.webContents.send('state', {
    url: wc.getURL(),
    title: wc.getTitle(),
    canBack: wc.navigationHistory.canGoBack(),
    canForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
  });
  const t = wc.getTitle();
  mainWin.setTitle(t || 'Linux DO · 企业微信外观');
}

function wireWebContents(wc) {
  const push = () => pushState(wc);
  wc.on('did-start-loading', push);
  wc.on('did-stop-loading', push);
  wc.on('did-navigate', push);
  wc.on('did-navigate-in-page', push);
  wc.on('page-title-updated', push);

  wc.setWindowOpenHandler(({ url }) => {
    if (isLinuxDoUrl(url)) createPopupWindow(url);
    else shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.on('context-menu', (_event, p) => {
    const items = [];
    if (p.linkURL) {
      items.push({
        label: '在新窗口打开链接',
        click: () => (isLinuxDoUrl(p.linkURL) ? createPopupWindow(p.linkURL) : shell.openExternal(p.linkURL)),
      });
      items.push({ label: '复制链接地址', click: () => clipboard.writeText(p.linkURL) });
      items.push({ type: 'separator' });
    }
    if (p.mediaType === 'image') {
      items.push({ label: '复制图片', click: () => wc.copyImageAt(p.x, p.y) });
    }
    if (p.selectionText) items.push({ role: 'copy', label: '复制' });
    if (p.isEditable) {
      items.push({ role: 'paste', label: '粘贴' });
      items.push({ role: 'selectAll', label: '全选' });
    }
    if (items.length) {
      const win = BrowserWindow.fromWebContents(wc);
      if (win) Menu.buildFromTemplate(items).popup({ window: win });
    }
  });
}

function createMainWindow(startUrl, ses, preloadFile) {
  mainWin = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#f2f3f5',
    autoHideMenuBar: true,
    // 隐藏系统标题栏（页面标题不再显示在左上角），保留右上角原生窗口控制按钮
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f7f8fa',
      symbolColor: '#4e5969',
      height: TOOLBAR_HEIGHT,
    },
    webPreferences: {
      preload: path.join(__dirname, 'toolbar', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // 窗口标题由 pushState 根据页面标题维护，屏蔽工具栏页自身的标题更新
  mainWin.webContents.on('page-title-updated', (e) => e.preventDefault());

  contentView = new WebContentsView({ webPreferences: contentWebPreferences(ses, preloadFile) });
  mainWin.contentView.addChildView(contentView);
  wireWebContents(contentView.webContents);
  layout();

  mainWin.on('resize', layout);
  mainWin.on('maximize', layout);
  mainWin.on('unmaximize', layout);
  mainWin.on('enter-full-screen', layout);
  mainWin.on('leave-full-screen', layout);
  mainWin.on('closed', () => {
    mainWin = null;
    contentView = null;
  });

  contentView.webContents.on('enter-html-full-screen', () => { htmlFullscreen = true; layout(); });
  contentView.webContents.on('leave-html-full-screen', () => { htmlFullscreen = false; layout(); });

  mainWin.loadFile(path.join(__dirname, 'toolbar', 'index.html'));
  contentView.webContents.loadURL(startUrl);
  mainWin.once('ready-to-show', () => mainWin.show());
}

function createPopupWindow(url, ses, preloadFile) {
  const win = new BrowserWindow({
    width: 1120,
    height: 840,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: contentWebPreferences(ses, preloadFile),
  });
  wireWebContents(win.webContents);
  win.loadURL(url);
  return win;
}

function registerIpc() {
  ipcMain.on('nav', (_e, input) => {
    const url = normalizeAddress(input);
    if (url && contentView) contentView.webContents.loadURL(url).catch(() => {});
  });
  ipcMain.on('back', () => contentView?.webContents.navigationHistory.goBack());
  ipcMain.on('forward', () => contentView?.webContents.navigationHistory.goForward());
  ipcMain.on('reload', () => contentView?.webContents.reload());
  ipcMain.on('stop', () => contentView?.webContents.stop());
  ipcMain.on('open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

function buildMenu() {
  const wc = () => contentView?.webContents;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '导航',
      submenu: [
        { label: '后退', accelerator: 'Alt+Left', click: () => wc()?.navigationHistory.goBack() },
        { label: '前进', accelerator: 'Alt+Right', click: () => wc()?.navigationHistory.goForward() },
        { type: 'separator' },
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => wc()?.reload() },
        { label: '强制刷新（忽略缓存）', accelerator: 'CmdOrCtrl+Shift+R', click: () => wc()?.reloadIgnoringCache() },
        { type: 'separator' },
        {
          label: '聚焦地址栏',
          accelerator: 'CmdOrCtrl+L',
          click: () => mainWin?.webContents
            .executeJavaScript("var el=document.getElementById('url');el&&(el.focus(),el.select());")
            .catch(() => {}),
        },
        {
          label: '在系统浏览器打开当前页',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => { const u = wc()?.getURL(); if (u) shell.openExternal(u); },
        },
        { type: 'separator' },
        { label: '开发者工具（页面）', accelerator: 'F12', click: () => wc()?.toggleDevTools() },
        { label: '开发者工具（工具栏）', accelerator: 'CmdOrCtrl+Shift+F12', click: () => mainWin?.webContents.toggleDevTools() },
      ],
    },
    { role: 'editMenu' },
    {
      label: '缩放',
      submenu: [
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => { const w = wc(); if (w) w.setZoomLevel(Math.min(4.5, w.getZoomLevel() + 0.5)); } },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => { const w = wc(); if (w) w.setZoomLevel(Math.max(-3, w.getZoomLevel() - 0.5)); } },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => wc()?.setZoomLevel(0) },
      ],
    },
  ]));
}

app.whenReady().then(() => {
  app.userAgentFallback = cleanUserAgent(app.userAgentFallback);

  const ses = setupSession();
  const preloadFile = buildUserscriptPreload();
  registerIpc();
  buildMenu();

  // 支持命令行直接带一个 URL 启动：npm start -- https://linux.do/t/...（打包后为 exe 路径后的第一个参数）
  const argSource = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2);
  const argUrl = argSource.find((a) => /^https?:\/\//i.test(a));
  createMainWindow(argUrl || HOME_URL, ses, preloadFile);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(HOME_URL, ses, preloadFile);
  });
});

app.on('window-all-closed', () => app.quit());
