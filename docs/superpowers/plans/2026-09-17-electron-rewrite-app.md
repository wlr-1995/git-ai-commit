# Electron 重写 M2+M3：应用实现 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 M1 的 `src/core` 之上实现完整的 Electron 应用：主进程 + preload 白名单 + 渲染层（左右分栏列表/diff 面板/设置弹层/主题），并用 Playwright 对真临时仓库跑 5 条端到端验收。

**Architecture:** 三个进程角色严格分离——`src/main` 拥有全部 git/AI 能力（Node），`src/preload` 只做 `contextBridge` 白名单转发，`src/renderer` 是纯 DOM（`contextIsolation` + `sandbox` + 无 Node）。渲染层用「单一 state + 全量重绘」模型：`state.ts` 是纯函数（可在 node 环境单测），`render.ts` 只负责把 state 画成 DOM。IPC 一律返回判别联合 `Result<T>`，不抛异常。

**Tech Stack:** Electron 44.4.1（`contextIsolation`/`sandbox`）、electron-vite 5.0.0（main/preload/renderer 打包 + HMR）、TypeScript 7.0.2 strict、vitest 5.0.1（node 环境）、@playwright/test 1.63.0（`_electron.launch`）、原生 DOM + CSS 变量（无 UI 框架）。

## Global Constraints

- 平台仅 Windows；所有界面文案与注释用中文，逐字对齐设计文档 §6.2 的表格。
- 一切 git/AI 调用只在主进程；渲染层不得出现 `node:` / `electron` 的运行时 import（只允许 `import type`）。
- 渲染层写入仓库内容一律用 `textContent`，禁止 `innerHTML` 拼接数据。
- IPC 通道名只在 `src/shared/ipc.ts` 里出现一次（`CHANNELS` 常量），三端共用。
- 路径校验：`diff:read` 的路径必须是**仓库内相对路径**，经 `resolveInsideRepo`（M1）校验，并拒绝绝对路径。
- diff 面板与 AI 共用 `config.git.max_diff_lines`。
- 忙碌语义：AI 生成可取消，提交不可取消；提交中关窗必须被拦截（文案「正在提交，请稍候…」）。
- 提交按钮可用条件 = `已勾选数 > 0 && 信息非空 && !busy`。
- 设计令牌只存在于 `src/renderer/styles/tokens.css`（唯一颜色来源），组件 CSS 只引用变量。
- 每个任务结束 `npm test` 全绿 + `npm run typecheck` 干净后提交；提交信息中文 `feat(app): ...`。

### 设计令牌（styles/tokens.css，逐值来自设计文档 §6.3）

```css
:root {
  --bg: #ffffff;
  --surface-muted: #f8fafc;
  --border: #e4e7ec;
  --border-strong: #d0d5dd;
  --text: #0f172a;
  --text-muted: #64748b;
  --accent: #2563eb;
  --accent-ink: #ffffff;
  --add-bg: #dcfce7;
  --add-fg: #14532d;
  --del-bg: #fee2e2;
  --del-fg: #7f1d1d;
  --status-modified: #b45309;
  --status-added: #15803d;
  --status-deleted: #b91c1c;
  --status-renamed: #6d28d9;
  --status-untracked: var(--text-muted);
  --status-conflicted: #b91c1c;
  --row-height: 30px;
  --radius: 6px;
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 12px;
  --space-lg: 16px;
  --space-xl: 24px;
  --font-ui: "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif;
  --font-mono: Consolas, "Cascadia Mono", monospace;
  --font-size: 13px;
  --font-size-small: 12px;
}
```

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/shared/ipc.ts` | 通道常量 + `Result<T>` + `IpcApi` 接口 + `DiffView` 类型（三端共用，仅类型与常量） |
| `src/main/index.ts` | 入口：argv 解析、仓库校验、建窗口、生命周期、致命错误弹窗 |
| `src/main/ipc.ts` | 通道注册、入参校验、core 调用、错误→错误码映射、AI 取消控制器 |
| `src/main/themes.ts` | 内置主题 + 外置 `%USERPROFILE%\.git_ai_commit\themes\*.css` 扫描与读取 |
| `src/preload/index.ts` | `contextBridge` 白名单 |
| `src/renderer/index.html` | 结构（无内联样式/脚本） |
| `src/renderer/styles/tokens.css` | 设计令牌 |
| `src/renderer/styles/app.css` | 布局与组件样式 |
| `src/renderer/state.ts` | 纯状态逻辑：勾选策略、过滤、汇总、按钮可用性、可见列表 |
| `src/renderer/render.ts` | `render(state)` → DOM（列表、diff、状态栏、空状态、按钮态） |
| `src/renderer/main.ts` | 启动、事件绑定、IPC 调用、忙碌/错误处理、快捷键、主题应用 |
| `tests/renderer/state.test.ts` | 纯逻辑单测（node 环境） |
| `tests/e2e/app.spec.ts` | 5 条端到端 |
| `playwright.config.ts` | E2E 配置 |

---

### Task 1: 主进程 + IPC + preload

**Files:**
- Create: `src/shared/ipc.ts`、`src/main/index.ts`、`src/main/ipc.ts`、`src/preload/index.ts`、`src/renderer/index.html`（占位，T2 补全）
- Modify: `src/core/paths.ts`（拒绝绝对路径）、`src/core/types.ts`（补 `Result`）、`package.json`（e2e 脚本先构建）
- Test: `tests/core/paths.test.ts`（补一条绝对路径用例）

**Interfaces:**
- Consumes: M1 的 `src/core/*` 全部导出
- Produces（三端契约，后续任务都靠它）:

```ts
// src/shared/ipc.ts
export const CHANNELS = {
  repoLoad: "repo:load",
  diffRead: "diff:read",
  aiGenerate: "ai:generate",
  aiCancel: "ai:cancel",
  commit: "commit",
  configGet: "config:get",
  configSave: "config:save",
  themesList: "themes:list",
} as const

export interface DiffView {
  path: string
  lines: DiffLine[]
  truncated: boolean
  omitted: number
}

export interface CommitInput {
  paths: string[]
  message: string
}

export interface ThemeInfo {
  key: string
  label: string
  css: string
}

export interface IpcApi {
  repoLoad(): Promise<Result<RepoSnapshot>>
  diffRead(path: string): Promise<Result<DiffView>>
  aiGenerate(paths: string[]): Promise<Result<{ message: string }>>
  aiCancel(): Promise<Result<void>>
  commit(input: CommitInput): Promise<Result<{ stdout: string }>>
  configGet(): Promise<Result<AppConfig>>
  configSave(partial: Record<string, unknown>): Promise<Result<AppConfig>>
  themesList(): Promise<Result<ThemeInfo[]>>
}
```

- [ ] **Step 1: 在 `src/core/types.ts` 补 `Result`，在 `src/core/paths.ts` 拒绝绝对路径**

```ts
// types.ts 追加
export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: ErrorCode; message: string } }
```

```ts
// paths.ts：在 NUL 检查之后追加
  if (isAbsolute(relPath)) {
    throw new PathError(`必须是仓库内相对路径: ${relPath}`)
  }
```

- [ ] **Step 2: 补测试并运行**

在 `tests/core/paths.test.ts` 增加：

```ts
  it("拒绝仓库内的绝对路径（只接受相对路径）", () => {
    expect(() => resolveInsideRepo(root, join(root, "a.txt"))).toThrow(PathError)
  })
```

Run: `npx vitest run tests/core/paths.test.ts` → Expected: PASS

- [ ] **Step 3: 写 `src/shared/ipc.ts`**

按上面 Interfaces 的代码，加上 `import type`：

```ts
import type { DiffLine } from "../core/diff"
import type { AppConfig, RepoSnapshot, Result } from "../core/types"

export type { Result }
```

- [ ] **Step 4: 写 `src/main/ipc.ts`**

要点：每个 handler 先做入参校验，再调 core，最后 `toError` 映射；`ai:generate` 用模块级 `AbortController`，`ai:cancel` 中止它。

```ts
import { ipcMain, type BrowserWindow } from "electron"

import { AIError, generateCommitMessage } from "../core/ai"
import { DEFAULT_CONFIG, deepMerge, loadConfig, saveConfig, CONFIG_FILE } from "../core/config"
import { parseDiff } from "../core/diff"
import { GitError } from "../core/gitcmd"
import { PathError, resolveInsideRepo } from "../core/paths"
import { commit, commitPathspecs, currentBranch, diffFor, diffNumstat, listChanges, readDiff, stage } from "../core/repo"
import type { ErrorCode, Result } from "../core/types"
import { CHANNELS, type CommitInput, type DiffView } from "../shared/ipc"
import { listThemes } from "./themes"

function fail(code: ErrorCode, message: string): { ok: false; error: { code: ErrorCode; message: string } } {
  return { ok: false, error: { code, message } }
}

export function toError(error: unknown): { code: ErrorCode; message: string } {
  if (error instanceof GitError) {
    if (error.reason === "not_found") return { code: "GIT_NOT_FOUND", message: error.message }
    if (error.reason === "timeout") return { code: "GIT_TIMEOUT", message: error.message }
    return { code: "GIT_FAILED", message: error.message }
  }
  if (error instanceof PathError) return { code: "PATH_OUTSIDE_REPO", message: error.message }
  if (error instanceof AIError) {
    if (error.message.includes("未配置 api.url")) return { code: "AI_NO_URL", message: error.message }
    if (/^AI 返回 \d+/.test(error.message)) return { code: "AI_HTTP", message: error.message }
    return { code: "AI_BAD_RESPONSE", message: error.message }
  }
  return { code: "UNKNOWN", message: error instanceof Error ? error.message : String(error) }
}

async function guarded<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error: toError(error) }
  }
}

let generation: AbortController | null = null

export function registerIpc(win: BrowserWindow, repoRoot: string): void {
  const handle = (channel: string, listener: (...args: unknown[]) => Promise<Result<unknown>>) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_event, ...args) => listener(...args))
  }

  handle(CHANNELS.repoLoad, () =>
    guarded(async () => ({
      branch: await currentBranch(repoRoot),
      changes: await listChanges(repoRoot),
      stats: await diffNumstat(repoRoot),
    })),
  )

  handle(CHANNELS.diffRead, (rawPath) =>
    guarded<DiffView>(async () => {
      if (typeof rawPath !== "string") throw new PathError("diff:read 需要字符串路径")
      resolveInsideRepo(repoRoot, rawPath)
      const maxLines = loadConfig().git.max_diff_lines
      const result = await readDiff(repoRoot, rawPath, maxLines)
      return { path: rawPath, lines: parseDiff(result.text), truncated: result.truncated, omitted: result.omitted }
    }),
  )

  handle(CHANNELS.aiGenerate, (rawPaths) =>
    guarded(async () => {
      const paths = toStringArray(rawPaths)
      if (paths.length === 0) throw new GitError("请先勾选至少一个文件")
      const config = loadConfig()
      if (!config.api.url.trim()) throw new AIError("未配置 api.url，请编辑配置文件后重试")
      const diffText = await diffFor(repoRoot, paths, config.git.max_diff_lines)
      if (!diffText.trim()) throw new AIError("勾选的文件没有可分析的改动")
      generation = new AbortController()
      try {
        return { message: await generateCommitMessage(diffText, config.api, { signal: generation.signal }) }
      } finally {
        generation = null
      }
    }),
  )

  handle(CHANNELS.aiCancel, async () => {
    generation?.abort()
    return { ok: true, value: undefined }
  })

  handle(CHANNELS.commit, (raw) =>
    guarded(async () => {
      const input = raw as CommitInput
      const paths = toStringArray(input?.paths)
      const message = typeof input?.message === "string" ? input.message.trim() : ""
      if (paths.length === 0) return fail("NO_SELECTION", "请先勾选至少一个文件") as never
      if (!message) return fail("EMPTY_MESSAGE", "提交信息不能为空") as never
      const changes = (await listChanges(repoRoot)).filter((c) => paths.includes(c.path))
      await stage(repoRoot, paths)
      const stdout = await commit(repoRoot, message, commitPathspecs(changes.length ? changes : paths.map((path) => ({ path, status: "", origPath: null }))))
      return { stdout }
    }),
  )

  handle(CHANNELS.configGet, () => guarded(async () => loadConfig()))
  handle(CHANNELS.configSave, (rawPartial) =>
    guarded(async () => {
      const partial = (rawPartial ?? {}) as Record<string, unknown>
      const merged = deepMerge(loadConfig(), partial)
      saveConfig(merged)
      return loadConfig()
    }),
  )
  handle(CHANNELS.themesList, () => guarded(async () => listThemes()))
  win.on("closed", () => {
    for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler(channel)
  })
}

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === "string")
}
```

（`CONFIG_FILE`/`DEFAULT_CONFIG` 在 `config:save` 的失败分支里用于给出可读路径；实施时若未用到则不要 import。`commit` 的 `fail(...) as never` 写法应改成直接 `throw` 语义更清楚：把前置校验改成抛 `GitError`，让 `toError` 统一处理，但错误码需为 `NO_SELECTION`/`EMPTY_MESSAGE` —— 因此保留 `fail` 返回值并由 `guarded` 之外单独返回，实施时写成：

```ts
handle(CHANNELS.commit, async (raw): Promise<Result<{ stdout: string }>> => {
  const input = raw as CommitInput
  const paths = toStringArray(input?.paths)
  const message = typeof input?.message === "string" ? input.message.trim() : ""
  if (paths.length === 0) return fail("NO_SELECTION", "请先勾选至少一个文件")
  if (!message) return fail("EMPTY_MESSAGE", "提交信息不能为空")
  return guarded(async () => {
    const changes = (await listChanges(repoRoot)).filter((c) => paths.includes(c.path))
    await stage(repoRoot, paths)
    return { stdout: await commit(repoRoot, message, commitPathspecs(changes)) }
  })
})
```

- [ ] **Step 5: 写 `src/main/themes.ts`（T6 会再扩，此处先给内置主题与扫描）**

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

import { DEFAULT_STYLE } from "../core/config"
import type { ThemeInfo } from "../shared/ipc"

export const THEMES_DIR = join(homedir(), ".git_ai_commit", "themes")

export const BUILTIN_THEMES: ThemeInfo[] = [{ key: DEFAULT_STYLE, label: "克制工具（浅色）", css: "" }]

const LABEL_RE = /\/\*\s*名称:\s*(.+?)\s*\*\//

/** 内置主题 + `%USERPROFILE%\.git_ai_commit\themes\*.css`；外置同名 key 覆盖内置。 */
export function listThemes(): ThemeInfo[] {
  const themes = new Map(BUILTIN_THEMES.map((theme) => [theme.key, theme]))
  if (existsSync(THEMES_DIR)) {
    for (const name of readdirSync(THEMES_DIR)) {
      if (!name.toLowerCase().endsWith(".css")) continue
      const key = basename(name, ".css")
      if (key.startsWith("_") || key.startsWith(".")) continue
      try {
        const css = readFileSync(join(THEMES_DIR, name), "utf8")
        themes.set(key, { key, label: LABEL_RE.exec(css)?.[1] ?? key, css })
      } catch {
        // 读不了就跳过该主题，不影响其它主题
      }
    }
  }
  return [...themes.values()]
}
```

- [ ] **Step 6: 写 `src/main/index.ts`**

```ts
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
    dialog.showErrorBox("AI 提交 启动失败", `${(error as Error).name}: ${(error as Error).message}`)
    app.exit(1)
  }
})

app.on("window-all-closed", () => app.quit())
```

- [ ] **Step 7: 写 `src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer } from "electron"

import { CHANNELS, type IpcApi } from "../shared/ipc"

const api: IpcApi = {
  repoLoad: () => ipcRenderer.invoke(CHANNELS.repoLoad),
  diffRead: (path: string) => ipcRenderer.invoke(CHANNELS.diffRead, path),
  aiGenerate: (paths: string[]) => ipcRenderer.invoke(CHANNELS.aiGenerate, paths),
  aiCancel: () => ipcRenderer.invoke(CHANNELS.aiCancel),
  commit: (input) => ipcRenderer.invoke(CHANNELS.commit, input),
  configGet: () => ipcRenderer.invoke(CHANNELS.configGet),
  configSave: (partial) => ipcRenderer.invoke(CHANNELS.configSave, partial),
  themesList: () => ipcRenderer.invoke(CHANNELS.themesList),
}

contextBridge.exposeInMainWorld("api", api)
```

- [ ] **Step 8: 写占位 `src/renderer/index.html`（T2 补全结构）**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'" />
    <title>AI 提交</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

- [ ] **Step 9: 构建验证**

Run: `npx electron-vite build`
Expected: `out/main/index.js`、`out/preload/index.js`、`out/renderer/index.html` 均生成；无 TypeScript 报错

- [ ] **Step 10: 提交**

```bash
git add src package.json tests/core/paths.test.ts
git commit -m "feat(app): electron main process, ipc contract and preload whitelist"
```

---

### Task 2: 渲染层骨架（布局、令牌、列表、纯状态逻辑）

**Files:**
- Create: `src/renderer/styles/tokens.css`、`src/renderer/styles/app.css`、`src/renderer/state.ts`、`src/renderer/render.ts`、`src/renderer/main.ts`、`src/renderer/index.html`（补全）
- Test: `tests/renderer/state.test.ts`

**Interfaces:**
- Consumes: `CHANNELS`/`IpcApi`（T1）、M1 的 `FileChange`/`STATUS_TEXT`/`STATUS_LETTER`
- Produces（T3-T7 依赖）:

```ts
// state.ts
export type Busy = null | "refresh" | "generate" | "commit"
export interface UiState {
  branch: string
  changes: FileChange[]
  stats: Record<string, [number | null, number | null]>
  checked: Set<string>
  message: string
  showUntracked: boolean
  checkedByDefault: string
  busy: Busy
  selectedPath: string | null
}
export function visibleChanges(state: UiState): FileChange[]
export function defaultChecked(change: FileChange, policy: string): boolean
export function initialChecked(changes: FileChange[], policy: string): Set<string>
export function summaryText(state: UiState): string
export function actionHint(state: UiState): string
export function commitEnabled(state: UiState): boolean
export function checkedPaths(state: UiState): string[]
export function applyFilter(state: UiState, kind: "all" | "none" | "added" | "deleted" | "modified"): Set<string>
```

- [ ] **Step 1: 写 `tests/renderer/state.test.ts`（先失败）**

```ts
import { describe, expect, it } from "vitest"

import { ADDED, DELETED, MODIFIED, RENAMED, UNTRACKED } from "../../src/core/repo"
import {
  actionHint,
  applyFilter,
  commitEnabled,
  defaultChecked,
  initialChecked,
  summaryText,
  visibleChanges,
  type UiState,
} from "../../src/renderer/state"

export function change(path: string, status: string) {
  return { path, status, origPath: null }
}

function makeState(over: Partial<UiState> = {}): UiState {
  const changes = over.changes ?? [change("a.txt", MODIFIED), change("b.txt", UNTRACKED)]
  return {
    branch: "main",
    changes,
    stats: {},
    checked: initialChecked(changes, over.checkedByDefault ?? "tracked"),
    message: "",
    showUntracked: false,
    checkedByDefault: "tracked",
    busy: null,
    selectedPath: null,
    ...over,
  }
}

describe("defaultChecked / initialChecked", () => {
  it("tracked 策略默认勾选已跟踪、不勾未跟踪", () => {
    expect(defaultChecked(change("a", MODIFIED), "tracked")).toBe(true)
    expect(defaultChecked(change("b", UNTRACKED), "tracked")).toBe(false)
  })

  it("all / none 策略", () => {
    expect(defaultChecked(change("b", UNTRACKED), "all")).toBe(true)
    expect(defaultChecked(change("a", MODIFIED), "none")).toBe(false)
  })

  it("initialChecked 按策略初始化", () => {
    expect([...initialChecked([change("a", MODIFIED), change("b", UNTRACKED)], "tracked")]).toEqual(["a"])
  })
})

describe("visibleChanges", () => {
  it("默认隐藏未跟踪文件", () => {
    const state = makeState()
    expect(visibleChanges(state).map((c) => c.path)).toEqual(["a.txt"])
  })

  it("打开开关后显示未跟踪文件", () => {
    const state = makeState({ showUntracked: true })
    expect(visibleChanges(state).map((c) => c.path)).toEqual(["a.txt", "b.txt"])
  })
})

describe("applyFilter", () => {
  it("all / none 全选全不选", () => {
    const state = makeState()
    expect(applyFilter(state, "all").size).toBe(2)
    expect(applyFilter(state, "none").size).toBe(0)
  })

  it("已添加是累加勾选，不取消已有勾选", () => {
    const state = makeState({ changes: [change("a", MODIFIED), change("n", ADDED)], checked: new Set(["a"]) })
    const next = applyFilter(state, "added")
    expect([...next].sort()).toEqual(["a", "n"])
  })

  it("已修改同时匹配已重命名", () => {
    const state = makeState({ changes: [change("r", RENAMED), change("d", DELETED)], checked: new Set() })
    expect([...applyFilter(state, "modified")]).toEqual(["r"])
    expect([...applyFilter(state, "deleted")]).toEqual(["d"])
  })

  it("过滤只作用于可见行", () => {
    const state = makeState({ showUntracked: false })
    expect([...applyFilter(state, "all")]).toEqual(["a.txt"])
  })
})

describe("summaryText / actionHint / commitEnabled", () => {
  it("汇总文案", () => {
    const state = makeState()
    expect(summaryText(state)).toBe("共 1 个变更 · 已选 1")
  })

  it("有变更未勾选时提示勾选", () => {
    const state = makeState({ checked: new Set() })
    expect(actionHint(state)).toBe("请先勾选要提交的文件")
  })

  it("已勾选但没写信息时提示填信息", () => {
    const state = makeState({ checked: new Set(["a.txt"]) })
    expect(actionHint(state)).toBe("请填写提交信息")
  })

  it("提交按钮可用性矩阵", () => {
    expect(commitEnabled(makeState({ checked: new Set(["a.txt"]), message: "x" }))).toBe(true)
    expect(commitEnabled(makeState({ checked: new Set(["a.txt"]), message: "" }))).toBe(false)
    expect(commitEnabled(makeState({ checked: new Set(), message: "x" }))).toBe(false)
    expect(commitEnabled(makeState({ checked: new Set(["a.txt"]), message: "x", busy: "commit" }))).toBe(false)
  })

  it("工作区干净时提交按钮不可用（回归：曾可点）", () => {
    const state = makeState({ changes: [], checked: new Set(), message: "x" })
    expect(commitEnabled(state)).toBe(false)
    expect(actionHint(state)).toBe("")
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/renderer/state.test.ts` → Expected: FAIL（无法解析 `src/renderer/state`）

- [ ] **Step 3: 写 `src/renderer/state.ts`**

```ts
import { ADDED, DELETED, MODIFIED, RENAMED, UNTRACKED, type FileChange } from "../core/repo"

export type Busy = null | "refresh" | "generate" | "commit"

export interface UiState {
  branch: string
  changes: FileChange[]
  stats: Record<string, [number | null, number | null]>
  checked: Set<string>
  message: string
  showUntracked: boolean
  checkedByDefault: string
  busy: Busy
  selectedPath: string | null
}

export function visibleChanges(state: UiState): FileChange[] {
  if (state.showUntracked) return state.changes
  return state.changes.filter((change) => change.status !== UNTRACKED)
}

export function defaultChecked(change: FileChange, policy: string): boolean {
  if (policy === "all") return true
  if (policy === "none") return false
  return change.status !== UNTRACKED
}

export function initialChecked(changes: FileChange[], policy: string): Set<string> {
  return new Set(changes.filter((change) => defaultChecked(change, policy)).map((change) => change.path))
}

export function checkedPaths(state: UiState): string[] {
  const visible = new Set(visibleChanges(state).map((change) => change.path))
  return [...state.checked].filter((path) => visible.has(path))
}

export function summaryText(state: UiState): string {
  return `共 ${visibleChanges(state).length} 个变更 · 已选 ${checkedPaths(state).length}`
}

export function actionHint(state: UiState): string {
  const total = visibleChanges(state).length
  if (!total) return ""
  if (checkedPaths(state).length === 0) return "请先勾选要提交的文件"
  if (!state.message.trim()) return "请填写提交信息"
  return ""
}

export function commitEnabled(state: UiState): boolean {
  return checkedPaths(state).length > 0 && state.message.trim().length > 0 && state.busy === null
}

const FILTER_STATUS: Record<string, string[]> = {
  added: [ADDED],
  deleted: [DELETED],
  modified: [MODIFIED, RENAMED],
}

/** 过滤按钮：all/none 为全选/全不选；其余三个是累加勾选（不取消已有勾选）。 */
export function applyFilter(state: UiState, kind: "all" | "none" | "added" | "deleted" | "modified"): Set<string> {
  const visible = visibleChanges(state)
  if (kind === "all") return new Set(visible.map((change) => change.path))
  if (kind === "none") return new Set()
  const wanted = FILTER_STATUS[kind] ?? []
  const next = new Set(checkedPaths(state))
  for (const change of visible) {
    if (wanted.includes(change.status)) next.add(change.path)
  }
  return next
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/renderer/state.test.ts` → Expected: PASS（15 用例）

- [ ] **Step 5: 写 `src/renderer/styles/tokens.css`**

按 Global Constraints 里的令牌表逐值抄写。再补一小组派生令牌（供 app.css 用）：

```css
:root {
  --chip-bg: var(--surface-muted);
  --chip-border: var(--border);
  --header-bg: var(--surface-muted);
  --row-selected-bg: #eff6ff;
  --row-hover-bg: #f8fafc;
  --diff-hunk-bg: #f1f5f9;
  --shadow-popover: 0 8px 24px rgba(16, 24, 40, 0.12);
  --splitter-width: 5px;
  --left-column-min: 320px;
  --narrow-breakpoint: 820px;
}
```

- [ ] **Step 6: 写 `src/renderer/styles/app.css`**

要求（逐项可核对）：

- `html, body, #app` 高 100%，`body` 用 `--font-ui` / `--font-size` / `--text` / `--bg`，`margin: 0`
- 顶层栅格：`#app { display: grid; grid-template-rows: auto 1fr auto auto; height: 100% }`（头部 / 主体 / 动作行 / 状态栏）
- 头部：`display: flex`，仓库名 13px 600，路径 12px `--text-muted` 中间省略（`text-overflow: ellipsis; overflow: hidden; white-space: nowrap`），分支胶囊（`--surface-muted` 底、`--border` 1px、`border-radius: 999px`、12px）
- 主体：`display: grid; grid-template-columns: minmax(var(--left-column-min), 380px) var(--splitter-width) 1fr`；左栏内部 `display: flex; flex-direction: column`（提交信息 textarea 3 行最小 72px、列表头、表格滚动区、未跟踪开关）；分隔条 `cursor: col-resize`，`background: var(--border)`，hover 变 `--accent`
- 表格：`border-collapse: collapse; width: 100%`；`thead th` 12px、`--text-muted`、`--surface-muted` 底、下边框 `--border`、`position: sticky; top: 0`；`tbody tr { height: var(--row-height) }`；`tr:hover { background: var(--row-hover-bg) }`；`tr[aria-selected="true"] { background: var(--row-selected-bg) }`；数字列右对齐（`.num { text-align: right; font-variant-numeric: tabular-nums; color: var(--text-muted) }`）；扩展名列 `--text-muted`
- 状态色：`.status-modified/.status-added/.status-deleted/.status-renamed/.status-untracked/.status-conflicted` 分别取对应令牌；冲突加 `font-weight: 600`
- 按钮：基础（白底、`--border-strong` 1px、`--radius`、高 28px、padding 0 12px）；`button.primary`（`--accent` 底、`--accent-ink` 字、无边框）；`button:disabled`（`opacity: .5; cursor: default`）；`button.chip`（胶囊、`--surface-muted` 底、12px）
- diff 面板：`font-family: var(--font-mono)`、12.5px、行高 20px；`.diff-line.add { background: var(--add-bg); color: var(--add-fg) }`、`.del` 同理、`.hunk { background: var(--diff-hunk-bg); color: var(--text-muted) }`、`.meta { color: var(--text-muted) }`、`.note { background: #fffbeb; color: #92400e; font-family: var(--font-ui) }`；行号列 `color: var(--text-muted); text-align: right; width: 3em; user-select: none`
- 空状态：绝对定位居中、`--text-muted`、`white-space: pre-line`
- 弹层（设置/错误）：固定定位全屏遮罩 `rgba(16,24,40,.35)`，卡片白底 `--radius`、`--shadow-popover`、宽 460px
- 窄窗：`@media (max-width: 820px)` 下左栏占满、diff 面板 `display: none`（滑出形态由 JS 加 `.diff-open` 类控制为覆盖层）

- [ ] **Step 7: 写 `src/renderer/render.ts`**

```ts
import { STATUS_TEXT, UNTRACKED } from "../core/repo"
import type { DiffView } from "../shared/ipc"
import { actionHint, checkedPaths, commitEnabled, summaryText, visibleChanges, type UiState } from "./state"

export interface Elements {
  repoName: HTMLElement
  repoPath: HTMLElement
  branch: HTMLElement
  message: HTMLTextAreaElement
  tbody: HTMLTableSectionElement
  table: HTMLTableElement
  empty: HTMLElement
  hint: HTMLElement
  status: HTMLElement
  btnCommit: HTMLButtonElement
  btnGenerate: HTMLButtonElement
  btnCancel: HTMLButtonElement
  showUntracked: HTMLInputElement
  diffTitle: HTMLElement
  diffBody: HTMLElement
  diffEmpty: HTMLElement
  diffPanel: HTMLElement
}

export interface RenderContext {
  repoName: string
  repoPath: string
  diff: DiffView | null
  onToggle: (path: string, checked: boolean) => void
  onSelect: (path: string) => void
}

const NUMBER = new Intl.NumberFormat("zh-CN")

function statText(value: number | null | undefined, has: boolean): string {
  if (!has) return ""
  return value === null ? "-" : NUMBER.format(value)
}

export function render(state: UiState, elements: Elements, ctx: RenderContext): void {
  elements.repoName.textContent = ctx.repoName
  elements.repoName.title = ctx.repoPath
  elements.repoPath.textContent = ctx.repoPath
  elements.repoPath.title = ctx.repoPath
  elements.branch.textContent = state.branch
  elements.branch.title = `当前分支：${state.branch}`

  if (elements.message.value !== state.message) elements.message.value = state.message
  elements.showUntracked.checked = state.showUntracked

  const visible = visibleChanges(state)
  elements.tbody.replaceChildren(
    ...visible.map((change) => {
      const row = document.createElement("tr")
      row.dataset.path = change.path
      row.setAttribute("aria-selected", String(state.selectedPath === change.path))

      const cell = document.createElement("td")
      cell.className = "path-cell"
      const box = document.createElement("input")
      box.type = "checkbox"
      box.checked = state.checked.has(change.path)
      box.setAttribute("aria-label", `选择 ${change.path}`)
      box.addEventListener("change", () => ctx.onToggle(change.path, box.checked))
      const label = document.createElement("span")
      label.className = "path-text"
      label.textContent = change.path
      label.title = change.origPath ? `${change.origPath} → ${change.path}` : change.path
      cell.append(box, label)
      cell.addEventListener("click", (event) => {
        if (event.target === box) return
        ctx.onSelect(change.path)
      })
      row.append(cell)

      const suffix = document.createElement("td")
      suffix.className = "suffix"
      suffix.textContent = change.path.includes(".")
        ? change.path.slice(change.path.lastIndexOf("."))
        : ""
      row.append(suffix)

      const status = document.createElement("td")
      status.className = `status status-${change.status}`
      status.textContent = STATUS_TEXT[change.status] ?? change.status
      row.append(status)

      const has = Object.prototype.hasOwnProperty.call(state.stats, change.path)
      const [added, deleted] = state.stats[change.path] ?? [null, null]
      const addedCell = document.createElement("td")
      addedCell.className = "num"
      addedCell.textContent = statText(added, has)
      const deletedCell = document.createElement("td")
      deletedCell.className = "num"
      deletedCell.textContent = statText(deleted, has)
      row.append(addedCell, deletedCell)
      return row
    }),
  )

  elements.empty.hidden = visible.length > 0
  if (visible.length === 0) {
    elements.empty.textContent =
      state.changes.length === 0 ? "工作区干净\n没有需要提交的改动" : "未显示任何文件\n可勾选「显示未受版本控制的文件」后再看"
  }

  renderDiff(state, elements, ctx)

  elements.hint.textContent = actionHint(state)
  elements.btnCommit.disabled = !commitEnabled(state)
  elements.btnCommit.title = actionHint(state)
  elements.btnGenerate.disabled = state.busy !== null
  elements.btnCancel.disabled = state.busy !== "generate"
  if (state.busy === null) {
    elements.status.textContent = summaryText(state)
  } else {
    elements.status.textContent = state.busy === "generate" ? "正在生成…" : state.busy === "commit" ? "正在提交…" : "正在读取变更…"
  }
}

function renderDiff(state: UiState, elements: Elements, ctx: RenderContext): void {
  const diff = ctx.diff
  const hasDiff = Boolean(diff && state.selectedPath)
  elements.diffEmpty.hidden = hasDiff
  elements.diffBody.hidden = !hasDiff
  elements.diffTitle.hidden = !hasDiff
  if (!hasDiff || !diff) return

  elements.diffTitle.textContent = diff.truncated ? `${diff.path}（已截断，省略 ${diff.omitted} 行）` : diff.path
  let oldLine = 0
  let newLine = 0
  elements.diffBody.replaceChildren(
    ...diff.lines.map((line) => {
      const row = document.createElement("div")
      row.className = `diff-line ${line.kind}`
      const nums = document.createElement("span")
      nums.className = "diff-nums"
      if (line.kind === "del") {
        oldLine += 1
        nums.textContent = `${oldLine}`
      } else if (line.kind === "add") {
        newLine += 1
        nums.textContent = `${newLine}`
      } else if (line.kind === "ctx") {
        oldLine += 1
        newLine += 1
        nums.textContent = `${oldLine}`
      } else if (line.kind === "hunk") {
        const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line.text)
        if (match) {
          oldLine = Number(match[1]) - 1
          newLine = Number(match[2]) - 1
        }
      }
      const text = document.createElement("span")
      text.className = "diff-text"
      text.textContent = line.text === "" ? " " : line.text
      row.append(nums, text)
      return row
    }),
  )
}
```

（`UNTRACKED` 若未使用则不 import。）

- [ ] **Step 8: 写 `src/renderer/index.html`（完整结构）**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" />
    <link rel="stylesheet" href="./styles/tokens.css" />
    <link rel="stylesheet" href="./styles/app.css" />
    <link rel="stylesheet" id="theme" href="./styles/themes/light.css" />
    <title>AI 提交</title>
  </head>
  <body>
    <div id="app">
      <header class="app-header">
        <div class="titles">
          <strong id="repo-name"></strong>
          <span id="repo-path"></span>
        </div>
        <span class="hint">分支</span>
        <span id="branch" class="branch-chip"></span>
      </header>

      <main class="app-body">
        <section class="left-column">
          <label class="section-label" for="message">提交信息</label>
          <textarea id="message" placeholder="填写提交信息，或用「AI 生成」按改动生成"></textarea>

          <div class="list-header">
            <span class="section-label">变更列表</span>
            <span class="hint">选中</span>
            <button class="chip" data-filter="all" title="勾选列表中的全部文件">全部(A)</button>
            <button class="chip" data-filter="none" title="取消全部勾选">无(N)</button>
            <button class="chip" data-filter="added" title="勾选所有「已添加」的文件，不取消其它勾选">已添加</button>
            <button class="chip" data-filter="deleted" title="勾选所有「已删除」的文件，不取消其它勾选">已删除</button>
            <button class="chip" data-filter="modified" title="勾选所有「已修改 / 已重命名」的文件，不取消其它勾选">已修改</button>
            <span class="spacer"></span>
            <span class="hint">F5 刷新</span>
          </div>

          <div class="table-wrap">
            <table id="changes">
              <thead>
                <tr>
                  <th>路径</th>
                  <th>扩展名</th>
                  <th>状态</th>
                  <th class="num">添加行数</th>
                  <th class="num">删除行数</th>
                </tr>
              </thead>
              <tbody id="changes-body"></tbody>
            </table>
            <p id="empty-state" class="empty-state" hidden></p>
          </div>

          <label class="untracked-toggle">
            <input type="checkbox" id="show-untracked" />
            显示未受版本控制的文件(U)
          </label>
        </section>

        <div id="splitter" class="splitter" role="separator" aria-orientation="vertical"></div>

        <section class="diff-panel" id="diff-panel">
          <div class="diff-title" id="diff-title" hidden></div>
          <div class="diff-body" id="diff-body" hidden></div>
          <p class="diff-empty" id="diff-empty">选择左侧文件查看改动</p>
        </section>
      </main>

      <div class="actions">
        <button id="btn-settings">设置</button>
        <button id="btn-generate">AI 生成</button>
        <button id="btn-cancel" disabled>取消</button>
        <span id="action-hint" class="hint"></span>
        <span class="spacer"></span>
        <button id="btn-commit" class="primary">提交</button>
      </div>

      <footer id="status" class="status-bar">就绪</footer>
    </div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

同时创建 `src/renderer/styles/themes/light.css`（T6 会用外置 CSS 覆盖，这里先留一套与 tokens 等价的赋值）：

```css
/* 名称: 克制工具（浅色） */
:root {
  --bg: #ffffff;
  --surface-muted: #f8fafc;
  --border: #e4e7ec;
  --border-strong: #d0d5dd;
  --text: #0f172a;
  --text-muted: #64748b;
  --accent: #2563eb;
  --accent-ink: #ffffff;
}
```

- [ ] **Step 9: 写 `src/renderer/main.ts`（启动 + 事件绑定 + 提交/刷新）**

```ts
import { listChangesOwnedBy, type FileChange } from "../core/repo"
import type { DiffView } from "../shared/ipc"
import { render, type Elements } from "./render"
import { applyFilter, initialChecked, type UiState } from "./state"

const api = window.api

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`缺少元素 #${id}`)
  return node as T
}

const elements: Elements = {
  repoName: el("repo-name"),
  repoPath: el("repo-path"),
  branch: el("branch"),
  message: el<HTMLTextAreaElement>("message"),
  tbody: el("changes-body") as HTMLTableSectionElement,
  table: el("changes") as HTMLTableElement,
  empty: el("empty-state"),
  hint: el("action-hint"),
  status: el("status"),
  btnCommit: el<HTMLButtonElement>("btn-commit"),
  btnGenerate: el<HTMLButtonElement>("btn-generate"),
  btnCancel: el<HTMLButtonElement>("btn-cancel"),
  showUntracked: el<HTMLInputElement>("show-untracked"),
  diffTitle: el("diff-title"),
  diffBody: el("diff-body"),
  diffEmpty: el("diff-empty"),
  diffPanel: el("diff-panel"),
}

const state: UiState = {
  branch: "未知",
  changes: [],
  stats: {},
  checked: new Set(),
  message: "",
  showUntracked: false,
  checkedByDefault: "tracked",
  busy: null,
  selectedPath: null,
}

let diff: DiffView | null = null
let repoPath = ""
let diffRequest = 0

function paint(): void {
  render(state, elements, {
    repoName: repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath,
    repoPath,
    diff,
    onToggle: (path, checked) => {
      if (checked) state.checked.add(path)
      else state.checked.delete(path)
      paint()
    },
    onSelect: (path) => {
      state.selectedPath = path
      paint()
      void loadDiff(path)
    },
  })
}

async function loadDiff(path: string): Promise<void> {
  const request = ++diffRequest
  const result = await api.diffRead(path)
  if (request !== diffRequest) return
  if (!result.ok) {
    diff = null
    showError(result.error.message)
  } else {
    diff = result.value
  }
  paint()
}

async function refresh(): Promise<void> {
  if (state.busy) return
  state.busy = "refresh"
  paint()
  const result = await api.repoLoad()
  state.busy = null
  if (!result.ok) {
    state.changes = []
    state.stats = {}
    showError(`读取变更失败：${result.error.message}`)
  } else {
    state.branch = result.value.branch
    state.changes = result.value.changes
    state.stats = result.value.stats
    state.checked = initialChecked(result.value.changes, state.checkedByDefault)
    state.selectedPath = null
    diff = null
    if (result.value.changes.length === 0) state.message = ""
  }
  paint()
}

function showError(message: string): void {
  elements.status.textContent = `错误：${message.split(/\r?\n/)[0].slice(0, 120)}`
  window.dispatchEvent(new CustomEvent("app-error", { detail: message }))
}

async function submit(): Promise<void> {
  if (state.busy) return
  const paths = [...state.checked]
  state.busy = "commit"
  paint()
  const result = await api.commit({ paths, message: state.message.trim() })
  state.busy = null
  if (!result.ok) {
    showError(result.error.message)
  } else {
    state.message = ""
    await refresh()
    elements.status.textContent = "提交成功"
    window.dispatchEvent(new CustomEvent("app-info", { detail: "提交成功" }))
  }
  paint()
}

function bind(): void {
  elements.message.addEventListener("input", () => {
    state.message = elements.message.value
    paint()
  })
  elements.showUntracked.addEventListener("change", () => {
    state.showUntracked = elements.showUntracked.checked
    paint()
  })
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-filter]")) {
    button.addEventListener("click", () => {
      state.checked = applyFilter(state, button.dataset.filter as "all")
      paint()
    })
  }
  elements.btnCommit.addEventListener("click", () => void submit())
  document.addEventListener("keydown", (event) => {
    if (event.key === "F5") {
      event.preventDefault()
      void refresh()
    }
  })
}

async function start(): Promise<void> {
  const config = await api.configGet()
  if (config.ok) {
    state.showUntracked = config.value.ui.show_untracked
    state.checkedByDefault = config.value.selection.checked_by_default
  }
  bind()
  await refresh()
}

void start()
```

（`listChangesOwnedBy`/`FileChange` 是笔误，实施时不要 import 未使用的东西。）

- [ ] **Step 10: 构建 + 手动冒烟**

Run: `npx electron-vite build && npm run typecheck`
Expected: 构建成功、typecheck 干净

Run: `npx electron out/main/index.js "D:\wlr\ai\git-ai-commit"`（或 `npx electron .`）
Expected: 窗口打开、列出当前仓库的真实变更、分支显示 `electron-rewrite`；关闭窗口后进程退出

- [ ] **Step 11: 提交**

```bash
git add src tests/renderer
git commit -m "feat(app): renderer shell with split layout, list and pure state logic"
```

---

### Task 3: 提交流程端到端打通（M2 验收）

**Files:**
- Create: `playwright.config.ts`、`tests/e2e/app.spec.ts`
- Modify: `package.json`（`e2e` 脚本先构建）、`src/renderer/main.ts`（成功/失败提示接入错误弹层前的占位）

**Interfaces:**
- Consumes: T1/T2 全部
- Produces: 可复用的 E2E 脚手架（`launchApp(repoDir)` 帮助函数），T4-T7 复用

- [ ] **Step 1: 写 `playwright.config.ts`**

```ts
import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  workers: 1,
  use: { trace: "retain-on-failure" },
})
```

- [ ] **Step 2: 写 `tests/e2e/app.spec.ts`（本任务只保留 ② 提交流程，其余 T4-T7 追加）**

```ts
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test"

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败: ${result.stderr}`)
  return result.stdout ?? ""
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gac-e2e-"))
  git(dir, ["init", "-b", "main"])
  git(dir, ["config", "user.name", "t"])
  git(dir, ["config", "user.email", "t@example.com"])
  writeFileSync(join(dir, "tracked.txt"), "v1\n", "utf8")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", "init"])
  writeFileSync(join(dir, "tracked.txt"), "v1\nv2\n", "utf8")
  writeFileSync(join(dir, "new.txt"), "hello\n", "utf8")
  return dir
}

async function launchApp(repoDir: string): Promise<ElectronApplication> {
  return electron.launch({ args: [".", repoDir], env: { ...process.env, NODE_ENV: "test" } })
}

test("② 勾选并提交只包含勾选的文件", async () => {
  const repo = makeRepo()
  const app = await launchApp(repo)
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")

  await expect(window.locator("#branch")).toHaveText("main")
  await expect(window.locator("#status")).toContainText("共 1 个变更 · 已选 1")

  await window.fill("#message", "更新 tracked")
  await expect(window.locator("#btn-commit")).toBeEnabled()
  await window.click("#btn-commit")
  await expect(window.locator("#status")).toContainText("提交成功")

  const files = git(repo, ["ls-tree", "-r", "HEAD", "--name-only"]).split(/\r?\n/).filter(Boolean)
  expect(files).toContain("tracked.txt")
  expect(files).not.toContain("new.txt")
  const log = git(repo, ["log", "-1", "--pretty=%s"]).trim()
  expect(log).toBe("更新 tracked")

  await app.close()
})
```

- [ ] **Step 3: 运行确认失败或通过**

Run: `npx electron-vite build && npx playwright test`
Expected: 首次运行能暴露出真实问题（选择器不匹配、IPC 未注册等）；按报错修到通过

- [ ] **Step 4: 提交**

```bash
git add playwright.config.ts tests/e2e package.json
git commit -m "test(app): end-to-end commit flow against a real temp repo"
```

---

### Task 4: diff 面板（E2E ⑤）

**Files:**
- Modify: `src/renderer/main.ts`（选中即加载 diff、请求序号防乱序）、`src/renderer/render.ts`（若需微调行号）
- Test: `tests/e2e/app.spec.ts`（追加 ⑤）

**Interfaces:**
- Consumes: `api.diffRead`（T1）、`parseDiff`（M1）、`renderDiff`（T2）
- Produces: `#diff-title` / `#diff-body` / `#diff-empty` 的可断言行为

- [ ] **Step 1: 追加 E2E 用例**

```ts
test("⑤ 点某行在右栏显示 diff", async () => {
  const repo = makeRepo()
  const app = await launchApp(repo)
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")

  await expect(window.locator("#diff-empty")).toBeVisible()
  await window.click('#changes-body tr[data-path="tracked.txt"] td.path-cell')
  await expect(window.locator("#diff-title")).toHaveText("tracked.txt")
  await expect(window.locator("#diff-body .diff-line.add")).toContainText("+v2")
  await expect(window.locator('#changes-body tr[data-path="tracked.txt"]')).toHaveAttribute("aria-selected", "true")

  await app.close()
})
```

- [ ] **Step 2: 运行**

Run: `npx electron-vite build && npx playwright test -g "⑤"` → Expected: PASS

- [ ] **Step 3: 人工核对三种提示条**

在同一仓库造出：未跟踪文件（`new.txt`）、超大未跟踪文件（512 KB +）、二进制文件（含 NUL），逐个点击确认分别显示 `### 新增文件:`、`### 新增文件过大，已跳过:`、`### 新增疑似二进制文件，已跳过:`，且 `note` 行有独立底色。

- [ ] **Step 4: 提交**

```bash
git add src/renderer tests/e2e
git commit -m "feat(app): diff panel wired to selection with truncation notice"
```

---

### Task 5: AI 生成 + 取消（E2E ③）

**Files:**
- Modify: `src/renderer/main.ts`（生成/取消按钮接线、忙碌态）、`src/main/ipc.ts`（若取消语义需调整）
- Test: `tests/e2e/app.spec.ts`（追加 ③）

**Interfaces:**
- Consumes: `api.aiGenerate` / `api.aiCancel`、`generateCommitMessage`（M1）
- Produces: 生成按钮行为、`#btn-cancel` 可用性、生成期间界面可交互

- [ ] **Step 1: 写假 AI 服务**

在 E2E 文件里加：

```ts
import { createServer } from "node:http"

function fakeAI(content: string, delayMs = 0) {
  const calls: unknown[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ choices: [{ message: { content } }] }))
      }, delayMs)
    })
  })
  return { server, calls }
}
```

- [ ] **Step 2: 追加 E2E 用例**

```ts
test("③ AI 生成填入提交信息（含 <think> 剥离）", async () => {
  const repo = makeRepo()
  const { server } = fakeAI("<think>内部推理</think>修复 tracked 文件")
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  const configDir = mkdtempSync(join(tmpdir(), "gac-cfg-"))
  const configFile = join(configDir, "config.json")
  writeFileSync(
    configFile,
    JSON.stringify({ api: { url: `http://127.0.0.1:${port}/v1`, api_key: "k", model: "m" } }),
    "utf8",
  )

  const app = await electron.launch({
    args: [".", repo],
    env: { ...process.env, GIT_AI_COMMIT_CONFIG: configFile },
  })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")
  await window.click("#btn-generate")
  await expect(window.locator("#message")).toHaveValue("修复 tracked 文件")
  await expect(window.locator("#status")).toContainText("已生成")
  await app.close()
  server.close()
})
```

**实现要求**：`CONFIG_FILE` 需支持用环境变量 `GIT_AI_COMMIT_CONFIG` 覆盖（测试隔离用，正式运行仍用 `%USERPROFILE%\.git_ai_commit\config.json`）。改动在 `src/core/config.ts`：

```ts
export const CONFIG_FILE = process.env.GIT_AI_COMMIT_CONFIG ?? join(homedir(), ".git_ai_commit", "config.json")
```

并在 `tests/core/config.test.ts` 里补一条注释说明该环境变量仅用于测试。

- [ ] **Step 3: 运行**

Run: `npx electron-vite build && npx playwright test -g "③"` → Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src tests
git commit -m "feat(app): AI message generation with cancel and think-stripping"
```

---

### Task 6: 设置弹层与主题（E2E ④）

**Files:**
- Create: `src/renderer/components/settings.ts`（弹层构建与取值）
- Modify: `src/renderer/main.ts`（打开设置、保存回环、主题应用）、`src/main/themes.ts`（已就绪）、`src/main/ipc.ts`（config:save 白名单）
- Test: `tests/e2e/app.spec.ts`（追加 ④）、`tests/renderer/state.test.ts`（设置取值纯函数）

**Interfaces:**
- Consumes: `api.configGet` / `api.configSave` / `api.themesList`
- Produces: `#btn-settings` → 弹层；`applyTheme(css)`；`settingsValues(root: HTMLElement): { api: {...}; ui: { style: string } }`

- [ ] **Step 1: 写设置弹层组件**

结构：遮罩 `.modal-backdrop` + 卡片 `.modal`，分组「外观」（主题 `<select id="style">`）与「模型」（`#api-url`、`#api-model`、`#api-key` type=password、`#timeout` type=number min=1 max=600），底部 `#settings-cancel` / `#settings-save`。行为：

- 打开时记录 `originalStyle`；`#style` 变化即 `applyTheme(选中主题 css)`（实时预览）
- 取消/Esc/点遮罩 → `applyTheme(originalStyle)`，不改配置
- 保存 → `api.configSave(values())`；失败（`!result.ok`）→ 保持打开 + 提示；成功 → 关闭 + 状态栏「设置已保存」+ 应用新主题
- `#api-url` 为空 → `#settings-save` 禁用 + 提示「接口地址不能为空」

- [ ] **Step 2: 写纯函数测试**

```ts
// tests/renderer/settings.test.ts（node 环境，用最小 DOM 桩或仅测 values 组装）
it("values 只含 api 四键与 ui.style", () => {
  const values = buildSettingsValues({ url: "u", model: "m", apiKey: "k", timeout: 30, style: "light" })
  expect(values).toEqual({ api: { url: "u", model: "m", api_key: "k", timeout: 30 }, ui: { style: "light" } })
})
```

- [ ] **Step 3: 追加 E2E 用例 ④**

```ts
test("④ 设置保存写回配置文件并保留其它键", async () => {
  const repo = makeRepo()
  const configDir = mkdtempSync(join(tmpdir(), "gac-cfg-"))
  const configFile = join(configDir, "config.json")
  writeFileSync(configFile, JSON.stringify({ git: { max_diff_lines: 123 } }), "utf8")

  const app = await electron.launch({ args: [".", repo], env: { ...process.env, GIT_AI_COMMIT_CONFIG: configFile } })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")

  await window.click("#btn-settings")
  await window.fill("#api-url", "http://127.0.0.1:9/v1")
  await window.fill("#api-model", "test-model")
  await window.click("#settings-save")
  await expect(window.locator("#status")).toContainText("设置已保存")

  const saved = JSON.parse(readFileSync(configFile, "utf8"))
  expect(saved.api.url).toBe("http://127.0.0.1:9/v1")
  expect(saved.api.model).toBe("test-model")
  expect(saved.git.max_diff_lines).toBe(123)
  expect(saved.selection.checked_by_default).toBe("tracked")
  await app.close()
})
```

- [ ] **Step 4: 运行 + 人工核对**

Run: `npx electron-vite build && npx playwright test -g "④"` → Expected: PASS

人工：启动后打开设置，改主题下拉 → 界面**当场**变化；取消 → 还原；再保存 → 重启程序仍是保存的主题。

- [ ] **Step 5: 提交**

```bash
git add src tests
git commit -m "feat(app): settings dialog with live theme preview and persisted save"
```

---

### Task 7: 错误弹层、忙碌态、快捷键、窄窗折叠（E2E ①）

**Files:**
- Create: `src/renderer/components/error-dialog.ts`
- Modify: `src/renderer/main.ts`（`app-error`/`app-info` 事件接线、快捷键、分隔条拖拽、窄窗类名）
- Test: `tests/e2e/app.spec.ts`（追加 ①）

**Interfaces:**
- Consumes: T1-T6 全部
- Produces: 完整应用（M3 验收）

- [ ] **Step 1: 错误弹层**

摘要 = 首行截断 120 字符（超出加 `…`，空则「发生未知错误」），下方 `<details>` 展开完整信息，`#error-close` 关闭，Esc 关闭。`app-info` 事件用同一弹层的 info 变体显示「提交成功」等。

- [ ] **Step 2: 快捷键与窄窗**

- `F5` 刷新（已有）；表格聚焦时 `A`/`N` 应用过滤、`U` 切换未跟踪开关
- 分隔条拖拽改左栏宽度（`localStorage` 不存，会话内有效；范围 `min 320px` 到 `50%`）
- `window.matchMedia("(max-width: 820px)")` 变化时给 `#app` 加 `narrow` 类；narrow 下点行给 `#diff-panel` 加 `diff-open`，`Esc` 移除

- [ ] **Step 3: 追加 E2E 用例 ①**

```ts
test("① 启动即列出变更并阻塞界面之外的错误以弹层展示", async () => {
  const repo = makeRepo()
  const app = await launchApp(repo)
  const window = await app.firstWindow()
  await expect(window.locator("#changes-body tr")).toHaveCount(1)
  await expect(window.locator("#repo-name")).toHaveText(/gac-e2e-/)

  // 未勾选任何文件时提交按钮禁用；错误弹层可由退出码非 0 的仓库触发（M4 的右键路径）
  await window.click("#changes-body tr[data-path='tracked.txt'] input[type=checkbox]")
  await window.fill("#message", "x")
  await expect(window.locator("#btn-commit")).toBeEnabled()
  await app.close()
})

test("①b 不是 git 仓库时弹错误框并退出", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gac-notrepo-"))
  const app = await electron.launch({ args: [".", dir] })
  // Electron 会先弹原生错误框；这里断言进程确实退出（退出码非 0）
  const code = await app.process().then((proc) => new Promise<number>((resolve) => proc.on("exit", (c) => resolve(c ?? 0))))
  expect(code).not.toBe(0)
})
```

- [ ] **Step 4: 运行全部 E2E**

Run: `npx electron-vite build && npx playwright test` → Expected: 6 条全绿

- [ ] **Step 5: 人工截图**

生成三张截图（列表 + diff、设置弹层、错误弹层）存到 `%TEMP%\electron-shots\`，人工确认：白底、1px 浅灰描边、行高 30px、diff 红绿淡底、蓝色仅出现在主按钮与选中态。

- [ ] **Step 6: 提交**

```bash
git add src tests
git commit -m "feat(app): error dialog, busy states, shortcuts and narrow-window mode"
```

---

## Self-Review

**1. Spec coverage**

| Spec 章节 | 任务 |
|---|---|
| §4.2 IPC 通道与 `Result` 判别联合、错误码映射 | T1 |
| §4.3 路径校验（相对路径、拒绝绝对） | T1 |
| §4.4 启动/argv/非仓库弹窗退出、窗口尺寸与最小尺寸 | T1 |
| §6.1 布局（左右分栏、分隔条、窄窗折叠） | T2、T7 |
| §6.2 组件行为（头部/提交信息/列表/勾选/过滤/快捷键/未跟踪/空状态/状态栏/动作提示/提交按钮/忙碌/关窗/设置/错误） | T2、T3、T6、T7 |
| §6.3 设计令牌与主题机制（内置 + 外置 CSS） | T2、T6 |
| §6.4 diff 面板（行号、截断、note、乱序丢弃、空选区） | T4 |
| §7 数据流（启动/刷新/勾选/点行/AI/提交/设置保存） | T2、T3、T4、T5、T6 |
| §8 测试策略（E2E 5 条、jsdom/纯逻辑层、人工截图） | T2、T3、T4、T5、T6、T7 |
| 关窗拦截（提交中）与「提交不可取消」 | T7（`beforeunload`/主进程 `close` 事件） |

**2. Placeholder scan**：T1 的 `commit` handler 给出了两种写法并指明取后者；T2 的 `main.ts` 明确指出 `listChangesOwnedBy` 是笔误不可 import；无 TBD。

**3. Type consistency**：`UiState.checked` 是 `Set<string>`（T2 定义，T3-T7 一致）；`DiffView` 字段 `{path, lines, truncated, omitted}`（T1 定义，T4 使用）；`visibleChanges`/`checkedPaths`/`commitEnabled` 在 T2 定义、T7 的快捷键与 E2E 断言一致；`CHANNELS` 常量三端共用，无字符串重复。

## Execution Handoff

M4（打包、`install.ps1` 改指向 exe、删除 Python 版、README 重写）在 M3 完成后单独写计划——它需要 M3 实测出的产物路径与冷启动数据。
