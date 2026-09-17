import { app, BrowserWindow, dialog } from "electron"
import { basename, join } from "node:path"

import { loadConfig } from "../core/config"
import { findRepoRoot } from "../core/repo"
import { registerIpc } from "./ipc"

const MIN_WIDTH = 560
const MIN_HEIGHT = 420

/** 取第一个非选项参数作为起始路径；没有则用当前目录。 */
export function resolveStartPath(argv: string[]): string {
  for (const arg of argv.slice(1)) {
    if (!arg.startsWith("-")) return arg
  }
  return process.cwd()
}

function createWindow(repoRoot: string): BrowserWindow {
  const config = loadConfig()
  const win = new BrowserWindow({
    title: `${basename(repoRoot) || repoRoot} — AI 提交`,
    width: config.ui.window_width,
    height: config.ui.window_height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: "#ffffff",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.once("ready-to-show", () => win.show())
  registerIpc(win, repoRoot)

  const devServer = process.env.ELECTRON_RENDERER_URL
  if (devServer) {
    void win.loadURL(devServer)
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"))
  }
  return win
}

app.whenReady().then(async () => {
  try {
    const start = resolveStartPath(process.argv)
    const repoRoot = await findRepoRoot(start)
    if (!repoRoot) {
      dialog.showErrorBox("AI 提交", `该目录不是 Git 仓库：\n${start}`)
      app.exit(1)
      return
    }
    createWindow(repoRoot)
  } catch (error) {
    // 从资源管理器拉起时没有控制台，启动异常必须弹窗，否则右键菜单看起来「毫无反应」
    const err = error as Error
    dialog.showErrorBox("AI 提交 启动失败", `${err.name}: ${err.message}`)
    app.exit(1)
  }
})

app.on("window-all-closed", () => app.quit())
