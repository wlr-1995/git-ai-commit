import { app, BrowserWindow, dialog } from "electron"
import { rmSync } from "node:fs"
import { basename, join, normalize } from "node:path"

import { loadConfig } from "../core/config"
import { findRepoRoot } from "../core/repo"
import { stageRoot } from "../core/winmerge"
import { registerIpc } from "./ipc"

const MIN_WIDTH = 560
const MIN_HEIGHT = 420

/**
 * 取第一个非选项参数作为起始路径；没有则用当前目录。
 *
 * 以 `electron . <dir>` 方式运行时（开发、端到端测试）argv[1] 是应用目录本身
 * （`process.defaultApp === true`），必须跳过，否则会把项目目录当成用户点选的仓库。
 * 打包后 argv[0] 是 exe，右键菜单传入的 `"%V"` 就是 argv[1]。
 */
export function resolveStartPath(argv: string[], isDefaultApp: boolean = Boolean(process.defaultApp)): string {
  for (const arg of argv.slice(isDefaultApp ? 2 : 1)) {
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
    const found = await findRepoRoot(start)
    if (!found) {
      fatal(`该目录不是 Git 仓库：\n${start}`)
      return
    }
    // git 的 --show-toplevel 在 Windows 上返回正斜杠，归一成本平台分隔符再显示/使用
    createWindow(normalize(found))
  } catch (error) {
    // 从资源管理器拉起时没有控制台，启动异常必须弹窗，否则右键菜单看起来「毫无反应」
    const err = error as Error
    fatal(`${err.name}: ${err.message}`)
  }
})

/** GIT_AI_COMMIT_NO_DIALOG=1 时只写 stderr（端到端测试用），否则弹原生错误框。 */
function fatal(message: string): void {
  if (process.env.GIT_AI_COMMIT_NO_DIALOG === "1") {
    console.error(message)
  } else {
    dialog.showErrorBox("AI 提交", message)
  }
  app.exit(1)
}

app.on("window-all-closed", () => app.quit())

// 尽力清理本次运行的临时对比文件；WinMerge 还占着文件时删除会失败，忽略即可
app.on("will-quit", () => {
  try {
    rmSync(stageRoot(process.pid), { recursive: true, force: true })
  } catch {
    /* 占着就下次再说，%TEMP% 由系统收拾 */
  }
})
