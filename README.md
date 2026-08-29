# LinuxDO WeCom Browser

一个用 Electron 写的轻量单站浏览器，内置 [Blackwindow6/linuxdo-wecom-ui](https://github.com/Blackwindow6/linuxdo-wecom-ui) 的油猴脚本 [`linuxdo-wecom.user.js`](vendor/linuxdo-wecom.user.js)（v0.5.1，把 linux.do 换成企业微信 5.x 桌面端外观），开箱即用，无需安装 Tampermonkey。

## 运行

```bash
npm install
npm start
```

也可以直接带 URL 启动：

```bash
npm start -- https://linux.do/t/topic/12345
```

## 脚本兼容实现

原脚本的运行要求与本项目的对应处理：

| 脚本要求 | 实现 |
| --- | --- |
| `@match https://linux.do/*` | 生成的 preload 内置同款正则守卫，仅 linux.do（含子域）注入，其他站点不受影响 |
| `@run-at document-start` | preload 在页面任何脚本执行前运行，脚本以同步方式注入页面主世界 |
| `@grant none`（页面主世界执行） | 内容区 `contextIsolation: false`，与 Tampermonkey `grant none` 语义一致 |
| 脚本注入内联 `<style>`、data: 水印背景 | `onHeadersReceived` 移除 linux.do 响应的 CSP 头，避免被拦截 |
| 站内接口 `/posts.json`、`/uploads.json`、通知 | 同源 fetch 直接可用；放行通知 / 剪贴板 / 媒体权限 |
| Cloudflare / 站点对 Electron UA 的差异对待 | UA 去除 `Electron/x.y.z` 与应用名标记 |
| 登录态与脚本的 localStorage 设置（主题、视图等） | 会话使用 `persist:linuxdo` 分区，数据保存在系统 userData 目录，跨启动保留 |

生成的 preload 文件位于 `%APPDATA%/LinuxDO WeCom Browser/linuxdo-wecom.preload.js`，由 `main.js` 每次启动时从 `vendor/linuxdo-wecom.user.js` 重建——**更新脚本只需替换 vendor 目录里的 .user.js 文件后重启应用**。

## 浏览器功能

- 顶栏工具条：后退 / 前进 / 刷新（加载中变停止）、地址栏（输入关键词自动转为 linux.do 站内搜索）、在系统浏览器打开当前页
- linux.do 以内的 `window.open` / 新标签在应用内新窗口打开；外部链接调用系统默认浏览器
- 快捷键：`Alt+←/→` 后退前进，`Ctrl+R` / `Ctrl+Shift+R` 刷新，`Ctrl+L` 聚焦地址栏，`Ctrl+= / Ctrl+- / Ctrl+0` 缩放，`F12` 页面 DevTools
- 右键菜单：新窗口打开链接、复制链接 / 图片、复制粘贴
- HTML5 全屏（视频）自动隐藏工具栏
- 单实例运行，重复启动唤起已有窗口

## 打包为 exe

```bash
npm run dist
```

- 产物：`release/LinuxDO-WeCom-Browser-<version>-Portable.exe`（约 95MB，免安装单文件，双击即用）
- 解包目录版（启动更快）在 `release/win-unpacked/LinuxDO WeCom Browser.exe`
- 下载走 npmmirror 镜像：`.npmrc` 里的 `electron_mirror`，以及构建时的环境变量 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
- exe 未做代码签名，第一次在其他电脑上运行可能遇到 SmartScreen 提示，选择"仍要运行"即可
- 打包版与开发版共用同一 userData 目录，登录态互通

## 目录结构

```text
linuxdo-wecom-browser/
├─ main.js                            # 主进程：窗口、注入、会话、权限、快捷键
├─ toolbar/
│  ├─ index.html                      # 顶栏工具条 UI
│  └─ preload.js                      # 工具条与主进程的 IPC 桥
├─ vendor/
│  ├─ linuxdo-wecom.user.js           # 内置的外观脚本（原样未改）
│  └─ linuxdo-wecom-ui-README.md      # 上游项目说明
└─ package.json
```

## 已知取舍

- 为了保证脚本注入的内联样式 / data: 背景图生效，访问 linux.do 时移除了该站的 CSP 响应头（仅限本应用内、仅限 linux.do）。
- 内容区 `contextIsolation: false` 是模拟 Tampermonkey `@grant none` 注入语义的必要条件；生成的 preload 不使用任何 Node API，渲染进程仍保持沙箱开启。
- 本应用仅改变 linux.do 的前端外观，不隶属于腾讯、企业微信或 Linux DO；脚本 MIT © Richy。
