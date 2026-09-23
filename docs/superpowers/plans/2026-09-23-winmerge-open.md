# 双击用 WinMerge 打开 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在变更列表里双击一个文件，用 WinMerge 并排对比该文件的 HEAD 版本与工作区版本。

**Architecture:** 逻辑放 `src/core/winmerge.ts`（零运行时依赖，只用 node 内置模块 + `runGit`）：`comparePlan` 纯函数算「左右各落什么」，`prepareComparison` 负责把 HEAD 版按字节写到临时目录，`detectWinMerge` 定位 `WinMergeU.exe`，`launchWinMerge` 以 `/s /e /u` 参数 detached 拉起。主进程 `ipc.ts` 只做编排（校验路径 → 重查变更 → 落盘 → 定位 → 启动），渲染层只传仓库内相对路径并显示错误。

**Tech Stack:** Electron 44 + TypeScript 7 + vitest 5（单测）+ Playwright `_electron`（E2E）。沿用现有 `runGit`、`resolveInsideRepo`、`listChanges`、`Result<T>`/`ErrorCode`、`CHANNELS`/`IpcApi`。

## Global Constraints

- 平台仅 Windows；界面与提示文案一律中文。
- 渲染层拿不到 Node：一切文件系统/进程操作都在主进程；渲染层只传**仓库内相对路径**，主进程必须过 `resolveInsideRepo`。
- `src/core/**` 不得 import electron；不得 import `src/renderer/**`；可以 import `src/shared/**`。
- 所有 git 调用走 `runGit`（参数列表，无 shell）。
- 不阻塞界面：启动 WinMerge 必须 detached、不等待。
- 代码注释用中文，只在「为什么」不明显处写；不写无意义注释。
- 测试命令：`npx vitest run tests/core/<file>.test.ts`（单测）、`npm run e2e`（E2E）、`npm run typecheck`。
- 提交信息用 Conventional Commits（本仓库风格：`feat(core): …` / `feat(winmerge): …`）。
- 覆盖率门：`src/core/**` 行覆盖 ≥ 90%（`vitest.config.ts`），新文件会被计入。

---

### Task 1: `runGit` 提供原始字节

二进制文件（图片、压缩包）的 HEAD 版必须**按字节**写盘，而 `runGit` 目前把 stdout 解码成 utf8 字符串，会改坏二进制。给 `GitResult` 增加 `stdoutBuffer`（保留现有 `stdout` 字段，向后兼容）。

**Files:**
- Modify: `src/core/gitcmd.ts:29-33`（`GitResult` 接口）、`src/core/gitcmd.ts:102-109`（`close` 回调）
- Test: `tests/core/gitcmd.test.ts`（追加用例）

**Interfaces:**
- Consumes: 现有 `runGit(args, { cwd, check })`
- Produces: `GitResult` 新增字段 `stdoutBuffer: Buffer`（后续 Task 2 用它落盘二进制）

- [ ] **Step 1: 写失败测试**

追加到 `tests/core/gitcmd.test.ts` 末尾（该文件用 `makeTempDir` + 裸 `spawnSync("git", …)` 造环境，并整体包在 `maybe` 里以在无 git 时跳过；照此风格写）：

```ts
maybe("gitcmd 原始字节", () => {
  it("stdoutBuffer 保留原始字节（二进制不被 utf8 解码改坏）", async () => {
    const repo = makeTempDir()
    spawnSync("git", ["init"], { cwd: repo })
    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01])
    writeFileSync(join(repo, "blob.bin"), raw)
    spawnSync("git", ["add", "-A"], { cwd: repo })
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "bin"], { cwd: repo })

    const result = await runGit(["show", "HEAD:blob.bin"], { cwd: repo })
    expect(result.stdoutBuffer.equals(raw)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/gitcmd.test.ts -t "stdoutBuffer"`
Expected: FAIL —— `result.stdoutBuffer` 是 `undefined`，`.equals` 抛异常。

- [ ] **Step 3: 实现**

`src/core/gitcmd.ts` 的 `GitResult`：

```ts
export interface GitResult {
  code: number
  stdout: string
  /** 原始字节：二进制内容（图片、压缩包）必须用它写盘，不能用 utf8 解码后的 stdout */
  stdoutBuffer: Buffer
  stderr: string
}
```

`close` 回调里把解码与 resolve 改成：

```ts
    child.on("close", (code) => {
      clearTimeout(timer)
      if (spawnFailed) return
      if (timedOut) {
        reject(new GitError(`git 命令超时: ${args.join(" ")}`, "timeout"))
        return
      }
      const stdoutBuffer = Buffer.concat(out)
      const stdout = stdoutBuffer.toString("utf8")
      const stderr = Buffer.concat(err).toString("utf8")
      const exitCode = code ?? 1
      if (check && exitCode !== 0) {
        reject(new GitError(stderr.trim() || `git 退出码 ${exitCode}: ${args.join(" ")}`, "exit"))
        return
      }
      resolve({ code: exitCode, stdout, stdoutBuffer, stderr })
    })
```

- [ ] **Step 4: 跑测试确认通过（含既有用例不回归）**

Run: `npx vitest run tests/core/gitcmd.test.ts`
Expected: PASS（新用例 + 既有全部通过）

- [ ] **Step 5: 提交**

```bash
git add src/core/gitcmd.ts tests/core/gitcmd.test.ts
git commit -m "feat(core): expose raw stdout bytes from runGit"
```

---

### Task 2: `comparePlan` + `prepareComparison`

**Files:**
- Create: `src/core/winmerge.ts`
- Test: `tests/core/winmerge.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `runGit(...).stdoutBuffer`；`tests/helpers/repo.ts` 的 `makeTempDir/initRepo/git/commitAll`
- Produces:
  - `interface ChangeLike { path: string; status: string; origPath: string | null }`
  - `interface StagePlan { leftPath: string; leftFromHead: string | null; rightPath: string; rightEmpty: boolean }`
  - `comparePlan(change: ChangeLike, worktreePath: string, stageDir: string): StagePlan`
  - `prepareComparison(repoRoot: string, plan: StagePlan): Promise<{ left: string; right: string }>`
  - `export class WinMergeError extends Error { readonly reason: "not_found" | "launch_failed" }`

- [ ] **Step 1: 写失败测试**

创建 `tests/core/winmerge.test.ts`：

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { comparePlan, prepareComparison } from "../../src/core/winmerge"
import { ADDED, DELETED, MODIFIED, RENAMED, UNTRACKED } from "../../src/shared/changes"
import { commitAll, git, initRepo, makeTempDir, writeFile } from "../helpers/repo"

function stage(): string {
  return makeTempDir("gac-stage-")
}

describe("comparePlan", () => {
  it("已修改：左取自 HEAD，右为工作区真实路径", () => {
    const worktree = join("C:", "repo", "src", "core", "ai.ts")
    const plan = comparePlan({ path: "src/core/ai.ts", status: MODIFIED, origPath: null }, worktree, stage())
    expect(plan.leftFromHead).toBe("HEAD:src/core/ai.ts")
    expect(plan.rightEmpty).toBe(false)
    expect(plan.rightPath).toBe(worktree)
    expect(plan.leftPath.endsWith("ai.ts")).toBe(true)
    expect(plan.leftPath).not.toBe(plan.rightPath)
  })

  it("已重命名：左取自 HEAD 的旧路径", () => {
    const plan = comparePlan(
      { path: "new.txt", status: RENAMED, origPath: "old.txt" },
      join("C:", "repo", "new.txt"),
      stage(),
    )
    expect(plan.leftFromHead).toBe("HEAD:old.txt")
  })

  it("已添加/未跟踪：左为空（不给 HEAD 引用）", () => {
    for (const status of [ADDED, UNTRACKED]) {
      const plan = comparePlan({ path: "新 文件.txt", status, origPath: null }, join("C:", "repo", "新 文件.txt"), stage())
      expect(plan.leftFromHead).toBeNull()
      expect(plan.rightEmpty).toBe(false)
    }
  })

  it("已删除：右为空占位（给不存在的路径 WinMerge 会弹选择框）", () => {
    const plan = comparePlan({ path: "gone.txt", status: DELETED, origPath: null }, join("C:", "repo", "gone.txt"), stage())
    expect(plan.rightEmpty).toBe(true)
    expect(plan.rightPath).not.toContain("repo")
    expect(plan.rightPath.endsWith("gone.txt")).toBe(true)
  })

  it("反斜杠路径归一为正斜杠（git 只认正斜杠）", () => {
    const plan = comparePlan({ path: "src\\a.ts", status: MODIFIED, origPath: null }, "C:\\repo\\src\\a.ts", stage())
    expect(plan.leftFromHead).toBe("HEAD:src/a.ts")
  })
})

describe("prepareComparison", () => {
  it("左值是 HEAD 版，右值仍是工作区真实文件（不被改写）", async () => {
    const repo = makeTempDir("gac-cmp-")
    initRepo(repo)
    writeFile(repo, "a.txt", "HEAD 内容\n")
    commitAll(repo)
    writeFile(repo, "a.txt", "工作区内容\n")

    const worktree = join(repo, "a.txt")
    const plan = comparePlan({ path: "a.txt", status: MODIFIED, origPath: null }, worktree, stage())
    const { left, right } = await prepareComparison(repo, plan)

    expect(readFileSync(left, "utf8")).toBe("HEAD 内容\n")
    expect(right).toBe(worktree)
    expect(readFileSync(right, "utf8")).toBe("工作区内容\n")
  })

  it("二进制按字节落盘，不被 utf8 改坏", async () => {
    const repo = makeTempDir("gac-cmp-bin-")
    initRepo(repo)
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x41])
    writeFileSync(join(repo, "blob.bin"), raw)
    commitAll(repo)

    const plan = comparePlan({ path: "blob.bin", status: MODIFIED, origPath: null }, join(repo, "blob.bin"), stage())
    const { left } = await prepareComparison(repo, plan)
    expect(readFileSync(left).equals(raw)).toBe(true)
  })

  it("已添加的文件：左侧是 0 字节文件", async () => {
    const repo = makeTempDir("gac-cmp-add-")
    initRepo(repo)
    writeFile(repo, "seed.txt", "s")
    commitAll(repo)
    writeFile(repo, "new.txt", "新内容\n")

    const plan = comparePlan({ path: "new.txt", status: UNTRACKED, origPath: null }, join(repo, "new.txt"), stage())
    const { left } = await prepareComparison(repo, plan)
    expect(existsSync(left)).toBe(true)
    expect(readFileSync(left).length).toBe(0)
  })

  it("已删除的文件：右侧是 0 字节占位（工作区那份不存在）", async () => {
    const repo = makeTempDir("gac-cmp-del-")
    initRepo(repo)
    writeFile(repo, "gone.txt", "将被删除\n")
    commitAll(repo)
    git(repo, ["rm", "-q", "gone.txt"])

    const plan = comparePlan({ path: "gone.txt", status: DELETED, origPath: null }, join(repo, "gone.txt"), stage())
    const { left, right } = await prepareComparison(repo, plan)
    expect(readFileSync(left, "utf8")).toBe("将被删除\n")
    expect(existsSync(right)).toBe(true)
    expect(readFileSync(right).length).toBe(0)
  })

  it("HEAD 里没有该路径时左侧降级为空文件，不报错", async () => {
    const repo = makeTempDir("gac-cmp-miss-")
    initRepo(repo)
    writeFile(repo, "seed.txt", "s")
    commitAll(repo)
    writeFile(repo, "spoke.txt", "x")

    const plan = comparePlan({ path: "spoke.txt", status: MODIFIED, origPath: null }, join(repo, "spoke.txt"), stage())
    const { left } = await prepareComparison(repo, plan)
    expect(readFileSync(left).length).toBe(0)
  })

  it("两次计划落在不同 stageDir，同名文件不互相覆盖", async () => {
    const repo = makeTempDir("gac-cmp-two-")
    initRepo(repo)
    writeFile(repo, "a.txt", "v1\n")
    commitAll(repo)
    writeFile(repo, "a.txt", "v2\n")

    const first = await prepareComparison(
      repo,
      comparePlan({ path: "a.txt", status: MODIFIED, origPath: null }, join(repo, "a.txt"), stage()),
    )
    const second = await prepareComparison(
      repo,
      comparePlan({ path: "a.txt", status: MODIFIED, origPath: null }, join(repo, "a.txt"), stage()),
    )
    expect(first.left).not.toBe(second.left)
    expect(readFileSync(first.left, "utf8")).toBe("v1\n")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/winmerge.test.ts`
Expected: FAIL —— `Cannot find module '../../src/core/winmerge'`

- [ ] **Step 3: 实现 `src/core/winmerge.ts`**

```ts
import { mkdirSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

import { ADDED, DELETED, RENAMED, UNTRACKED } from "../shared/changes"
import { runGit } from "./gitcmd"

export class WinMergeError extends Error {
  readonly reason: "not_found" | "launch_failed"

  constructor(message: string, reason: "not_found" | "launch_failed") {
    super(message)
    this.name = "WinMergeError"
    this.reason = reason
  }
}

export interface ChangeLike {
  path: string
  status: string
  origPath: string | null
}

export interface StagePlan {
  /** 左值临时文件（HEAD 版，或占位空文件） */
  leftPath: string
  /** `HEAD:<路径>`；null 表示左侧留空（新增/未跟踪） */
  leftFromHead: string | null
  /** 右值：工作区真实文件，或（仅已删除）占位空文件 */
  rightPath: string
  rightEmpty: boolean
}

/** git 的 revision:path 语法只认正斜杠 */
function gitPath(raw: string): string {
  return raw.replace(/\\/g, "/")
}

/**
 * 算一次对比该落哪些文件（纯函数，不碰磁盘）。
 *
 * 只有「已删除」的右侧是占位空文件：WinMerge 在路径不存在时会打开
 * 「选择文件或文件夹」对话框，多出一个窗口；空文件能让它正常显示整文件删除。
 */
export function comparePlan(change: ChangeLike, worktreePath: string, stageDir: string): StagePlan {
  const normalized = gitPath(change.path)
  const name = basename(normalized) || "file.txt"
  const rightEmpty = change.status === DELETED
  const fromHead = (): string | null => {
    if (change.status === ADDED || change.status === UNTRACKED) return null
    if (change.status === RENAMED && change.origPath) return `HEAD:${gitPath(change.origPath)}`
    return `HEAD:${normalized}`
  }
  return {
    leftPath: join(stageDir, "left", name),
    leftFromHead: fromHead(),
    rightPath: rightEmpty ? join(stageDir, "right", name) : worktreePath,
    rightEmpty,
  }
}

/**
 * 把计划落成真实文件：左侧按字节写（二进制不能被 utf8 解码改坏），右侧**不动**工作区。
 *
 * `git show` 失败（该路径其实不在 HEAD 里）时左侧降级为 0 字节文件，不报错：
 * 宁可少一边内容，也不拦着用户看 diff。
 */
export async function prepareComparison(
  repoRoot: string,
  plan: StagePlan,
): Promise<{ left: string; right: string }> {
  mkdirSync(dirname(plan.leftPath), { recursive: true })
  let bytes: Buffer = Buffer.alloc(0)
  if (plan.leftFromHead) {
    const result = await runGit(["show", plan.leftFromHead], { cwd: repoRoot, check: false })
    if (result.code === 0) bytes = result.stdoutBuffer
  }
  writeFileSync(plan.leftPath, bytes)

  if (plan.rightEmpty) {
    mkdirSync(dirname(plan.rightPath), { recursive: true })
    writeFileSync(plan.rightPath, Buffer.alloc(0))
  }
  return { left: plan.leftPath, right: plan.rightPath }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core/winmerge.test.ts`
Expected: PASS（11 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/core/winmerge.ts tests/core/winmerge.test.ts
git commit -m "feat(core): plan and materialize HEAD-vs-worktree comparison files"
```

---

### Task 3: 定位与启动 WinMerge

**Files:**
- Modify: `src/core/winmerge.ts`（追加）
- Test: `tests/core/winmerge.test.ts`（追加）

**Interfaces:**
- Produces:
  - `interface WinMergeProbe { exists(path: string): boolean; registryInstallLocations(run?: RegRunner): string[]; commonPaths(): string[] }`
  - `const defaultProbe: WinMergeProbe`
  - `type RegRunner = (key: string) => string | null`
  - `parseRegQueryInstallLocation(output: string): string | null`
  - `detectWinMerge(configured: string, probe?: WinMergeProbe): string | null`
  - `WINMERGE_ARGS(left: string, right: string): string[]`
  - `launchWinMerge(exe: string, left: string, right: string, spawnImpl?: typeof spawn): Promise<void>`
  - `notFoundMessage(configured: string): string`
  - `stageRoot(pid: number): string`

- [ ] **Step 1: 写失败测试**

追加到 `tests/core/winmerge.test.ts`：

```ts
describe("detectWinMerge", () => {
  const probe = (existing: string[], registry: string[], common: string[]): WinMergeProbe => ({
    exists: (path) => existing.includes(path),
    registryInstallLocations: () => registry,
    commonPaths: () => common,
  })

  it("配置了 exe 路径且存在 → 直接用配置值", () => {
    const configured = "D:\\Tools\\WinMerge\\WinMergeU.exe"
    expect(detectWinMerge(configured, probe([configured], [], []))).toBe(configured)
  })

  it("配置了目录 → 补上 WinMergeU.exe", () => {
    const dir = "D:\\Tools\\WinMerge"
    const exe = join(dir, "WinMergeU.exe")
    expect(detectWinMerge(dir, probe([exe], [], []))).toBe(exe)
  })

  it("配置了但不存在 → 直接失败，不再往下探测（避免悄悄换成别的安装）", () => {
    const common = ["C:\\Program Files\\WinMerge\\WinMergeU.exe"]
    expect(detectWinMerge("C:\\nope\\WinMergeU.exe", probe(common, [], common))).toBeNull()
  })

  it("未配置 → 注册表 InstallLocation 优先于常见路径", () => {
    const fromRegistry = "D:\\Green\\WinMerge\\WinMergeU.exe"
    const common = "C:\\Program Files\\WinMerge\\WinMergeU.exe"
    expect(detectWinMerge("", probe([fromRegistry, common], ["D:\\Green\\WinMerge"], [common]))).toBe(fromRegistry)
  })

  it("未配置且注册表没有 → 用常见路径", () => {
    const common = "C:\\Program Files\\WinMerge\\WinMergeU.exe"
    expect(detectWinMerge("", probe([common], [], [common]))).toBe(common)
  })

  it("都没有 → null", () => {
    expect(detectWinMerge("", probe([], [], []))).toBeNull()
  })

  it("parseRegQueryInstallLocation 能从 reg query 输出里取值，无匹配返回 null", () => {
    const output = [
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WinMerge",
      "    InstallLocation    REG_SZ    C:\\Program Files\\WinMerge\\",
      "",
    ].join("\r\n")
    expect(parseRegQueryInstallLocation(output)).toBe("C:\\Program Files\\WinMerge\\")
    expect(parseRegQueryInstallLocation("错误: 系统找不到指定的注册表项或值。")).toBeNull()
  })

  it("notFoundMessage 带上配置过的路径", () => {
    expect(notFoundMessage("")).toContain("未找到 WinMerge")
    expect(notFoundMessage("C:\\nope\\WinMergeU.exe")).toContain("C:\\nope\\WinMergeU.exe")
  })
})

describe("WINMERGE_ARGS / launchWinMerge", () => {
  it("参数顺序：/s /e /u 在路径之前，左在右之前", () => {
    expect(WINMERGE_ARGS("L.txt", "R.txt")).toEqual(["/s", "/e", "/u", "L.txt", "R.txt"])
  })

  it("detached 启动、不等待，且把参数原样传给 exe", async () => {
    const calls: { exe: string; args: string[]; options: unknown }[] = []
    const fakeSpawn = ((exe: string, args: string[], options: unknown) => {
      calls.push({ exe, args, options })
      return {
        once(event: string, handler: () => void) {
          if (event === "spawn") handler()
          return this
        },
        unref() {},
      }
    }) as unknown as typeof spawn

    await launchWinMerge("C:\\W\\WinMergeU.exe", "L", "R", fakeSpawn)
    expect(calls[0].exe).toBe("C:\\W\\WinMergeU.exe")
    expect(calls[0].args).toEqual(["/s", "/e", "/u", "L", "R"])
    expect((calls[0].options as { detached: boolean }).detached).toBe(true)
  })

  it("spawn 报错 → WinMergeError(launch_failed)", async () => {
    const fakeSpawn = (() => ({
      once(event: string, handler: (error: Error) => void) {
        if (event === "error") handler(new Error("拒绝访问"))
        return this
      },
      unref() {},
    })) as unknown as typeof spawn

    await expect(launchWinMerge("C:\\W\\W.exe", "L", "R", fakeSpawn)).rejects.toThrow(/拒绝访问/)
  })
})
```

同时把顶部 import 补全为：

```ts
import { spawn } from "node:child_process"
import {
  WINMERGE_ARGS,
  WinMergeError,
  comparePlan,
  detectWinMerge,
  launchWinMerge,
  notFoundMessage,
  parseRegQueryInstallLocation,
  prepareComparison,
  type WinMergeProbe,
} from "../../src/core/winmerge"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/winmerge.test.ts -t "detectWinMerge"`
Expected: FAIL —— `detectWinMerge is not a function`

- [ ] **Step 3: 实现（追加到 `src/core/winmerge.ts`）**

顶部 import 增加：

```ts
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
```

文件末尾追加：

```ts
/** 读注册表 InstallLocation 的方式，注入以便单测 */
export type RegRunner = (key: string) => string | null

const REG_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WinMerge",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WinMerge",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WinMerge",
  "HKLM\\SOFTWARE\\WinMerge",
  "HKCU\\SOFTWARE\\WinMerge",
]

/** 从 `reg query <key> /v InstallLocation` 的输出里取路径。 */
export function parseRegQueryInstallLocation(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*InstallLocation\s+REG_SZ\s+(.+?)\s*$/.exec(line)
    if (match) return match[1]
  }
  return null
}

const defaultRegRunner: RegRunner = (key) => {
  const result = spawnSync("reg", ["query", key, "/v", "InstallLocation"], {
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.status !== 0 || !result.stdout) return null
  return parseRegQueryInstallLocation(result.stdout)
}

export interface WinMergeProbe {
  exists(path: string): boolean
  registryInstallLocations(): string[]
  commonPaths(): string[]
}

export const defaultProbe: WinMergeProbe = {
  exists: (path) => existsSync(path),
  registryInstallLocations: (run: RegRunner = defaultRegRunner) => {
    const found: string[] = []
    for (const key of REG_KEYS) {
      const location = run(key)
      if (location) found.push(location)
    }
    return found
  },
  commonPaths: () => {
    const list: string[] = []
    const programFiles = process.env.ProgramFiles
    const programFilesX86 = process.env["ProgramFiles(x86)"]
    const localAppData = process.env.LOCALAPPDATA
    if (programFiles) list.push(join(programFiles, "WinMerge", "WinMergeU.exe"))
    if (programFilesX86) list.push(join(programFilesX86, "WinMerge", "WinMergeU.exe"))
    if (localAppData) list.push(join(localAppData, "Programs", "WinMerge", "WinMergeU.exe"))
    return list
  },
}

/**
 * 定位 WinMergeU.exe。
 *
 * 配置了就用配置值，**存在才认**、不存在直接返回 null（不悄悄切到别的安装，
 * 否则用户改错了路径会更迷惑）；没配置才依次看注册表与常见安装位置。
 */
export function detectWinMerge(configured: string, probe: WinMergeProbe = defaultProbe): string | null {
  const value = configured.trim()
  if (value) {
    const direct = value.toLowerCase().endsWith(".exe") ? value : join(value, "WinMergeU.exe")
    return probe.exists(direct) ? direct : null
  }
  const candidates = [
    ...probe.registryInstallLocations().map((dir) => join(dir, "WinMergeU.exe")),
    ...probe.commonPaths(),
  ]
  return candidates.find((candidate) => probe.exists(candidate)) ?? null
}

/** WinMerge 命令行参数：单实例复用窗口、Esc 一次关闭、不写它的最近文件列表。 */
export function WINMERGE_ARGS(left: string, right: string): string[] {
  return ["/s", "/e", "/u", left, right]
}

/**
 * 拉起 WinMerge：detached + 不等待（界面不阻塞），只等「真的启动了」这件事。
 *
 * detached 后 WinMerge 的生命周期与本程序无关；`/s` 让它复用同一个窗口。
 */
export function launchWinMerge(
  exe: string,
  left: string,
  right: string,
  spawnImpl: typeof spawn = spawn,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(exe, WINMERGE_ARGS(left, right), { detached: true, stdio: "ignore" })
    child.once("error", (error: Error) => {
      reject(new WinMergeError(`WinMerge 启动失败：${error.message}`, "launch_failed"))
    })
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
}

export function notFoundMessage(configured: string): string {
  const base = "未找到 WinMerge。装一个，或在设置里填写 WinMergeU.exe 的路径。"
  const value = configured.trim()
  return value ? `${base}\n当前配置的路径：${value}` : base
}

/** 本进程的临时对比文件根目录：按 pid 隔离，避免多开实例互删。 */
export function stageRoot(pid: number): string {
  return join(tmpdir(), "git-ai-commit", String(pid))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core/winmerge.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add src/core/winmerge.ts tests/core/winmerge.test.ts
git commit -m "feat(core): locate and launch WinMerge non-blocking"
```

---

### Task 4: 配置项 `tools.winmerge_path`

**Files:**
- Modify: `src/core/types.ts:29-43`（`AppConfig`）、`src/core/config.ts:10-23`（`DEFAULT_CONFIG`）
- Test: `tests/core/config.test.ts`（追加）

**Interfaces:**
- Produces: `AppConfig.tools.winmerge_path: string`（默认 `""`），供 Task 5 / Task 7 使用

- [ ] **Step 1: 写失败测试**

追加到 `tests/core/config.test.ts`：

```ts
it("默认配置含 tools.winmerge_path 且为空（表示自动探测）", () => {
  expect(DEFAULT_CONFIG.tools.winmerge_path).toBe("")
})

it("旧配置文件没有 tools 键时回落为空字符串", () => {
  const cfgFile = join(makeTempDir(), "config.json")
  writeFileSync(cfgFile, JSON.stringify({ api: { url: "http://x/v1" } }), "utf8")
  expect(loadConfig(cfgFile).tools.winmerge_path).toBe("")
})

it("tools.winmerge_path 能被读回", () => {
  const cfgFile = join(makeTempDir(), "config.json")
  writeFileSync(cfgFile, JSON.stringify({ tools: { winmerge_path: "D:\\W\\WinMergeU.exe" } }), "utf8")
  expect(loadConfig(cfgFile).tools.winmerge_path).toBe("D:\\W\\WinMergeU.exe")
})
```

（若 `DEFAULT_CONFIG`、`makeTempDir` 未在 import 里，按文件现有风格补齐。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/config.test.ts -t "winmerge_path"`
Expected: FAIL —— `Cannot read properties of undefined (reading 'winmerge_path')`

- [ ] **Step 3: 实现**

`src/core/types.ts` 的 `AppConfig` 里，在 `git` 之后插入一行：

```ts
  git: { max_diff_lines: number }
  tools: { winmerge_path: string }
  ui: { window_width: number; window_height: number; show_untracked: boolean; style: string }
```

`src/core/config.ts` 的 `DEFAULT_CONFIG` 里，同样在 `git` 之后插入：

```ts
  git: { max_diff_lines: 200 },
  tools: { winmerge_path: "" },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core/config.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/types.ts src/core/config.ts tests/core/config.test.ts
git commit -m "feat(config): add tools.winmerge_path"
```

---

### Task 5: IPC 接线

**Files:**
- Create: `src/core/errors.ts`（把 `toError` 从 `src/main/ipc.ts` 搬过来）
- Modify: `src/shared/ipc.ts`（`CHANNELS`、`IpcApi`）
- Modify: `src/preload/index.ts`（**接口与它的唯一实现必须同一次提交**，否则这一步过后 `npm run typecheck` 会因 `IpcApi` 缺实现而失败，留下一个 typecheck 过不了的提交）
- Modify: `src/core/types.ts:12-24`（`ErrorCode` 加两个码）
- Modify: `src/main/ipc.ts`（`toError` 映射 + 新 handler）
- Test: `tests/core/errors.test.ts`（新建，只测纯函数 `toError`；handler 由 Task 9 的 E2E 覆盖）

**Interfaces:**
- Consumes: Task 2/3 的 `comparePlan`、`prepareComparison`、`detectWinMerge`、`launchWinMerge`、`stageRoot`、`notFoundMessage`、`WinMergeError`；Task 4 的 `config.tools.winmerge_path`
- Produces: `CHANNELS.winmergeOpen = "winmerge:open"`、`IpcApi.winmergeOpen(path: string): Promise<Result<void>>`、错误码 `WINMERGE_NOT_FOUND` / `WINMERGE_LAUNCH_FAILED`

- [ ] **Step 1: 写失败测试**

把 `toError` 从 `src/main/ipc.ts` **搬到** `src/core/errors.ts`（它是纯映射逻辑、依赖的都是 core 的错误类，放在 core 里测试不必 import electron —— `src/main/ipc.ts` 一 import 就会碰到 `electron` 模块）。

创建 `tests/core/errors.test.ts`：

```ts
import { describe, expect, it } from "vitest"

import { AIError } from "../../src/core/ai"
import { toError } from "../../src/core/errors"
import { GitError } from "../../src/core/gitcmd"
import { PathError } from "../../src/core/paths"
import { WinMergeError } from "../../src/core/winmerge"

describe("toError", () => {
  it("找不到 WinMerge → WINMERGE_NOT_FOUND", () => {
    expect(toError(new WinMergeError("未找到 WinMerge。", "not_found")).code).toBe("WINMERGE_NOT_FOUND")
  })

  it("WinMerge 启动失败 → WINMERGE_LAUNCH_FAILED，且保留原始文案", () => {
    const mapped = toError(new WinMergeError("WinMerge 启动失败：拒绝访问", "launch_failed"))
    expect(mapped.code).toBe("WINMERGE_LAUNCH_FAILED")
    expect(mapped.message).toContain("拒绝访问")
  })

  it("既有映射不回归", () => {
    expect(toError(new PathError("越界")).code).toBe("PATH_OUTSIDE_REPO")
    expect(toError(new GitError("超时", "timeout")).code).toBe("GIT_TIMEOUT")
    expect(toError(new AIError("AI 返回 500：boom")).code).toBe("AI_HTTP")
    expect(toError(new Error("随便")).code).toBe("UNKNOWN")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/errors.test.ts`
Expected: FAIL —— `Cannot find module '../../src/core/errors'`

- [ ] **Step 3: 实现**

创建 `src/core/errors.ts`（内容＝原 `toError` 整体搬过来，只把 `WinMergeError` 分支加进 `AIError` 之后）：

```ts
import { AIError } from "./ai"
import { GitError } from "./gitcmd"
import { PathError } from "./paths"
import type { ErrorCode } from "./types"
import { WinMergeError } from "./winmerge"

/** core 的异常 → IPC 错误码。 */
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
  if (error instanceof WinMergeError) {
    if (error.reason === "not_found") return { code: "WINMERGE_NOT_FOUND", message: error.message }
    return { code: "WINMERGE_LAUNCH_FAILED", message: error.message }
  }
  return { code: "UNKNOWN", message: error instanceof Error ? error.message : String(error) }
}
```

`src/main/ipc.ts`：删掉本文件里的 `toError` 函数体，import 改为从 core 取：

```ts
import { toError } from "../core/errors"
```

并把 `import { AIError, generateCommitMessage } from "../core/ai"` 等**已不再使用的 import 清掉**（`AIError` 仍在 handler 里用到则保留），`import type { ErrorCode, Result }` 里的 `ErrorCode` 若不再使用一并去掉 —— 最后以 `npm run typecheck` 为准。

`src/core/types.ts` 的 `ErrorCode` 末尾追加两个成员：

```ts
  | "CONFIG_WRITE"
  | "WINMERGE_NOT_FOUND"
  | "WINMERGE_LAUNCH_FAILED"
  | "UNKNOWN"
```

`src/shared/ipc.ts`：`CHANNELS` 增加一行、`IpcApi` 增加一个方法：

```ts
export const CHANNELS = {
  repoLoad: "repo:load",
  diffRead: "diff:read",
  aiGenerate: "ai:generate",
  aiCancel: "ai:cancel",
  commit: "commit",
  configGet: "config:get",
  configSave: "config:save",
  themesList: "themes:list",
  winmergeOpen: "winmerge:open",
} as const
```

```ts
  winmergeOpen(path: string): Promise<Result<void>>
```

`src/preload/index.ts` 的 `api` 对象里追加一行（**必须在这一次提交里**，否则 typecheck 会报 `Property 'winmergeOpen' is missing in type '{...}' but required in type 'IpcApi'`）：

```ts
  winmergeOpen: (path: string) => ipcRenderer.invoke(CHANNELS.winmergeOpen, path),
```

`src/main/ipc.ts`：import 增加

```ts
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  WinMergeError,
  comparePlan,
  detectWinMerge,
  launchWinMerge,
  notFoundMessage,
  prepareComparison,
  stageRoot,
} from "../core/winmerge"
```

`registerIpc` 里，模块级加计数器（与 `generation` 并列）：

```ts
/** 每次双击递增，保证临时目录互不覆盖 */
let winmergeSeq = 0
```

在 `themesList` handler 之前加入：

```ts
  handle(CHANNELS.winmergeOpen, (rawPath) =>
    guarded(async () => {
      if (typeof rawPath !== "string") throw new PathError("winmerge:open 需要字符串路径")
      const worktreePath = resolveInsideRepo(repoRoot, rawPath)
      const changes = await listChanges(repoRoot)
      const change = changes.find((item) => item.path === rawPath)
      if (!change) throw new PathError("变更列表已过期，请按 F5 刷新后重试。")

      const config = loadConfig()
      const exe = detectWinMerge(config.tools.winmerge_path)
      if (!exe) throw new WinMergeError(notFoundMessage(config.tools.winmerge_path), "not_found")

      const stageDir = join(stageRoot(process.pid), String(++winmergeSeq))
      const files = await prepareComparison(repoRoot, comparePlan(change, worktreePath, stageDir))
      await launchWinMerge(exe, files.left, files.right)
      return undefined
    }),
  )
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core/ipc-errors.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/types.ts src/shared/ipc.ts src/main/ipc.ts tests/core/ipc-errors.test.ts
git commit -m "feat(ipc): winmerge:open channel"
```

---

### Task 6: 渲染层双击接线

**Files:**
- Modify: `src/renderer/render.ts:24-30`（`RenderContext`）、`src/renderer/render.ts:77-80`（行事件）
- Modify: `src/renderer/main.ts:57-74`（`paint` 传回调）、`src/renderer/main.ts`（新增 `openInWinMerge`）
- Test: `tests/renderer/` 无（双击行为由 Task 9 的 E2E 覆盖）

**Interfaces:**
- Consumes: Task 5 的 `api.winmergeOpen`（preload 已在 Task 5 里一并接好，本任务不再碰 preload）
- Produces: `RenderContext.onOpenInWinMerge: (path: string) => void`

- [ ] **Step 1: 渲染层加双击回调**

`src/renderer/render.ts` 的 `RenderContext` 接口追加：

```ts
  onOpenInWinMerge: (path: string) => void
```

行事件那里（`row.addEventListener("click", …)` 之后）追加：

```ts
      // 双击 = 用 WinMerge 对比（点勾选框不算，否则会和勾选打架）
      row.addEventListener("dblclick", (event) => {
        if (event.target === box) return
        ctx.onOpenInWinMerge(change.path)
      })
```

- [ ] **Step 2: main.ts 接线**

`src/renderer/main.ts` 的 `paint()` 里，`onSelect` 之后追加：

```ts
    onOpenInWinMerge: (path) => void openInWinMerge(path),
```

`loadDiff` 函数之后新增：

```ts
async function openInWinMerge(path: string): Promise<void> {
  const result = await api.winmergeOpen(path)
  if (!result.ok) showError(result.error.message)
}
```

- [ ] **Step 3: 类型检查确认没有漏接线**

Run: `npm run typecheck`
Expected: 无输出（exit 0）。若报 `Property 'onOpenInWinMerge' is missing`，说明还有别处构造 `RenderContext`（目前只有 `paint()` 一处）。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/render.ts src/renderer/main.ts
git commit -m "feat(ui): double-click a row to open WinMerge"
```

---

### Task 7: 设置弹层「工具」组

**Files:**
- Modify: `src/renderer/components/settings.ts`（`SettingsValues`、`buildSettingsValues`、`SettingsDialogOptions.config`、弹层 HTML、`currentValues`）
- Modify: `src/renderer/main.ts:191-200`（`openSettings` 传 `tools`）
- Test: `tests/renderer/settings.test.ts`（若不存在则创建）

**Interfaces:**
- Consumes: Task 4 的 `tools.winmerge_path`
- Produces: 保存时落盘 `tools: { winmerge_path }`

- [ ] **Step 1: 写失败测试**

创建 `tests/renderer/settings.test.ts`（该目录现有 `state.test.ts`，import 风格照它：`../../src/renderer/...` + vitest 的 `describe/expect/it`）：

```ts
import { describe, expect, it } from "vitest"

import { buildSettingsValues } from "../../src/renderer/components/settings"

describe("buildSettingsValues", () => {
  it("包含 tools.winmerge_path（留空也落盘，表示自动探测）", () => {
    const values = buildSettingsValues({
      url: "http://x/v1",
      model: "m",
      apiKey: "k",
      timeout: 60,
      style: "light",
      winmergePath: "",
    }) as { tools: { winmerge_path: string } }
    expect(values.tools.winmerge_path).toBe("")
  })

  it("去掉首尾空格", () => {
    const values = buildSettingsValues({
      url: "http://x/v1",
      model: "m",
      apiKey: "k",
      timeout: 60,
      style: "light",
      winmergePath: "  D:\\W\\WinMergeU.exe  ",
    }) as { tools: { winmerge_path: string } }
    expect(values.tools.winmerge_path).toBe("D:\\W\\WinMergeU.exe")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/renderer/settings.test.ts`
Expected: FAIL —— `winmergePath` 不在 `SettingsValues` 类型里 / `values.tools` 是 `undefined`

- [ ] **Step 3: 实现**

`src/renderer/components/settings.ts`：

```ts
export interface SettingsValues {
  url: string
  model: string
  apiKey: string
  timeout: number
  style: string
  winmergePath: string
}

/** 只组装要落盘的键：api 四键 + ui.style + tools（其余配置由主进程 deepMerge 保留）。 */
export function buildSettingsValues(input: SettingsValues): Record<string, unknown> {
  return {
    api: { url: input.url, model: input.model, api_key: input.apiKey, timeout: input.timeout },
    ui: { style: input.style },
    tools: { winmerge_path: input.winmergePath.trim() },
  }
}
```

`SettingsDialogOptions.config` 增加 `tools`：

```ts
  config: {
    api: { url: string; model: string; api_key: string; timeout: number }
    ui: { style: string }
    tools: { winmerge_path: string }
  }
```

弹层 HTML：在「外观」组之后插入一组（用现有的 `.group` / `.field` 样式，不引入新样式）：

```html
      <div class="group">
        <div class="group-title">工具</div>
        <div class="field">
          <label for="winmerge-path">WinMerge 路径</label>
          <input id="winmerge-path" type="text" placeholder="留空自动查找，如 C:\Program Files\WinMerge\WinMergeU.exe"
                 value="${escapeHtml(options.config.tools.winmerge_path)}" />
        </div>
      </div>
```

元素引用与取值：

```ts
  const winmergeInput = backdrop.querySelector<HTMLInputElement>("#winmerge-path")!
```

```ts
  const currentValues = (): Record<string, unknown> =>
    buildSettingsValues({
      url: urlInput.value.trim(),
      model: modelInput.value.trim(),
      apiKey: keyInput.value,
      timeout: parseTimeout(timeoutInput.value),
      style: styleSelect.value,
      winmergePath: winmergeInput.value,
    })
```

`src/renderer/main.ts` 的 `openSettings` 里，给 `config` 增加：

```ts
      tools: { winmerge_path: config.value.tools.winmerge_path },
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/renderer/settings.test.ts && npm run typecheck`
Expected: PASS 且 typecheck 干净

- [ ] **Step 5: 提交**

```bash
git add src/renderer/components/settings.ts src/renderer/main.ts tests/renderer/settings.test.ts
git commit -m "feat(ui): WinMerge path field in settings"
```

---

### Task 8: 退出时清临时目录

**Files:**
- Modify: `src/main/index.ts`（`app.on("will-quit")`）
- Test: 退出清理由 Task 9 的 E2E ⑪ 做端到端断言；`stageRoot` 本身已在 Task 3 单测覆盖

**Interfaces:**
- Consumes: Task 3 的 `stageRoot(pid)`

- [ ] **Step 1: 实现退出清理**

`src/main/index.ts` 顶部 import 增加：

```ts
import { rmSync } from "node:fs"

import { stageRoot } from "../core/winmerge"
```

文件末尾（`app.on("window-all-closed", …)` 之后）追加：

```ts
// 尽力清理本次运行的临时对比文件；WinMerge 还占着文件时删除会失败，忽略即可
app.on("will-quit", () => {
  try {
    rmSync(stageRoot(process.pid), { recursive: true, force: true })
  } catch {
    /* 占着就下次再说，%TEMP% 由系统收拾 */
  }
})
```

- [ ] **Step 2: 类型检查 + 既有测试不回归**

Run: `npm run typecheck && npx vitest run tests/core/winmerge.test.ts`
Expected: typecheck 干净、单测通过

- [ ] **Step 3: 提交**

```bash
git add src/main/index.ts
git commit -m "feat(app): clean WinMerge temp files on quit"
```

---

### Task 9: E2E 四条

**Files:**
- Modify: `tests/e2e/app.spec.ts`（追加用例 + 一个造仓库的辅助函数）

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 端到端证据（真 Electron 进程 + 真临时仓库 + 假 WinMerge）

- [ ] **Step 1: 写 E2E**

在 `tests/e2e/app.spec.ts` 末尾追加（顶部 import 需补 `existsSync`、`mkdirSync`）：

```ts
/** 造一个含 probe.js 的仓库：HEAD 版写 "HEAD"，工作区版写 "WORKTREE"。 */
function makeProbeRepo(marker: string): string {
  const dir = makeRepo()
  const body = (tag: string): string =>
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(tag)})\n`
  writeFileSync(join(dir, "probe.js"), body("HEAD"), "utf8")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", "probe"])
  writeFileSync(join(dir, "probe.js"), body("WORKTREE"), "utf8")
  return dir
}

test("⑧ 双击行用 WinMerge 打开：左值取自 HEAD（假 WinMerge = node.exe）", async () => {
  const markerDir = mkdtempSync(join(tmpdir(), "gac-mark-"))
  const marker = join(markerDir, "marker.txt")
  const repo = makeProbeRepo(marker)
  const configFile = makeConfig({ tools: { winmerge_path: process.execPath } })

  const app = await launchApp({ repo, configFile })
  const window = await app.firstWindow()
  await window.waitForSelector('#changes-body tr[data-path="probe.js"]')

  await window.dblclick('#changes-body tr[data-path="probe.js"]')

  await expect.poll(() => (existsSync(marker) ? readFileSync(marker, "utf8") : ""), {
    timeout: 15_000,
  }).toBe("HEAD")

  await app.close()
})

test("⑨ 双击不改变勾选状态", async () => {
  const repo = makeRepo() // tracked.txt 默认勾选、new.txt 未跟踪默认不显示
  const app = await launchApp({ repo, configFile: makeConfig({ tools: { winmerge_path: process.execPath } }) })
  const window = await app.firstWindow()
  const box = window.locator('#changes-body tr[data-path="tracked.txt"] input[type=checkbox]')

  await expect(box).toBeChecked()
  await window.dblclick('#changes-body tr[data-path="tracked.txt"]')
  await expect(box).toBeChecked()

  await app.close()
})

test("⑩ 找不到 WinMerge 时弹错误弹层，且不动其它状态", async () => {
  const repo = makeRepo()
  const configFile = makeConfig({ tools: { winmerge_path: "C:\\definitely-missing\\WinMergeU.exe" } })
  const app = await launchApp({ repo, configFile })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")

  await window.fill("#message", "别动我")
  await window.dblclick('#changes-body tr[data-path="tracked.txt"]')

  await expect(window.locator(".modal-backdrop")).toBeVisible()
  await expect(window.locator("#message-detail")).toContainText("未找到 WinMerge")
  await expect(window.locator("#message")).toHaveValue("别动我")

  await app.close()
})

test("⑪ 退出后临时目录被清理", async () => {
  const markerDir = mkdtempSync(join(tmpdir(), "gac-mark2-"))
  const repo = makeProbeRepo(join(markerDir, "m.txt"))
  const app = await launchApp({
    repo,
    configFile: makeConfig({ tools: { winmerge_path: process.execPath } }),
  })
  const window = await app.firstWindow()
  await window.waitForSelector('#changes-body tr[data-path="probe.js"]')
  await window.dblclick('#changes-body tr[data-path="probe.js"]')

  const pid = app.process().pid!
  const dir = join(tmpdir(), "git-ai-commit", String(pid))
  await expect.poll(() => existsSync(dir), { timeout: 15_000 }).toBe(true)

  await app.close()
  await expect.poll(() => existsSync(dir), { timeout: 15_000 }).toBe(false)
})
```

> 说明：`#message-detail` 是错误弹层里那个「详细信息」的可展开 `<pre>`（见 `src/renderer/components/error-dialog.ts:45`），未找到 WinMerge 时完整文案会显示在那里；快捷摘要（`#message-summary`）只取首行。

- [ ] **Step 2: 跑 E2E**

Run: `npm run build && npm run e2e`
Expected: 全部通过（含既有 10 条 + 新增 4 条 = 14 条）

- [ ] **Step 3: 提交**

```bash
git add tests/e2e/app.spec.ts
git commit -m "test(e2e): double-click opens WinMerge (fake exe, HEAD left side)"
```

---

### Task 10: 全量验证、文档、打包

**Files:**
- Modify: `README.md`（「使用」加双击说明；「配置」表加 `tools.winmerge_path`）
- Modify: `docs/superpowers/specs/2026-09-23-winmerge-open-design.md`（把 `detectWinMerge` 的「配置不存在则继续探测」改成「配置了就只认配置值」，并把验收标准 7 的描述对齐）

- [ ] **Step 1: 跑全量验证**

```bash
npm test
npm run typecheck
npm run build
npm run e2e
```

Expected: 单测全绿（含新增）且 `src/core` 行覆盖 ≥ 90%；`tsc --noEmit` 无输出；E2E 14 条通过。

- [ ] **Step 2: 更新 README**

「使用」小节加一条：

```markdown
- **双击文件**：用 WinMerge 对比该文件的 HEAD 版与工作区版（左 = HEAD，右 = 工作区真实文件）；同一时刻只占一个 WinMerge 窗口，`Esc` 一次关闭。已删除的文件右侧显示为空。找不到 WinMerge 时弹提示，可在设置里填路径
```

「配置」表的 `git.max_diff_lines` 那一行之后插入：

```markdown
| `tools.winmerge_path` | `""` | WinMergeU.exe 的路径；留空则自动查注册表与常见安装位置 |
```

- [ ] **Step 3: 对齐 spec（本计划已与 spec 对齐，这一步只是核对）**

确认 `docs/superpowers/specs/2026-09-23-winmerge-open-design.md` 里 `detectWinMerge` 与 `WINMERGE_NOT_FOUND` 的描述是「配置了就只认配置值，不存在直接报错」（本轮开工前已改好）。若发现仍有「继续走探测」之类旧措辞，改掉后一并提交。

- [ ] **Step 4: 重新打包并真机复验**

```bash
npm run package
```

然后按老流程验证右键链路仍然通（`install\verify.ps1` + `install\verify-launch.ps1 -Repo <临时仓库>`），确认新界面里双击不报错、单击行为不变。

- [ ] **Step 5: 提交**

```bash
git add README.md docs/superpowers/specs/2026-09-23-winmerge-open-design.md
git commit -m "docs: document double-click WinMerge"
```

---

## 覆盖检查（对照 spec 逐条）

| spec 要求 | 落点 |
|---|---|
| HEAD ↔ 工作区对比 | Task 2（`comparePlan` + `prepareComparison`）、Task 9 ⑧（左值取自 HEAD 的实证） |
| 仅双击触发，单击不变 | Task 6、Task 9 ⑨ |
| `tools.winmerge_path` + 自动探测 + 设置项 | Task 3、Task 4、Task 7 |
| `/s /e /u` 参数 | Task 3（`WINMERGE_ARGS` + 单测）、Task 3 spawn 单测 |
| detached 不阻塞 | Task 3（`detached: true` + `unref`）、Task 3 单测断言 detached |
| 已删除 → 右侧空占位（不弹选择框） | Task 2 单测、Task 2 实现注释 |
| 重命名取旧路径 HEAD | Task 2 单测 |
| 二进制按字节 | Task 1、Task 2 单测 |
| 按 pid/seq 隔离临时目录 | Task 2 单测、Task 3 `stageRoot`、Task 8 |
| 退出尽力清理 | Task 8、Task 9 ⑪ |
| 错误码与文案 | Task 5（映射单测）、Task 9 ⑩ |
| 路径安全（复用 resolveInsideRepo） | Task 5 |
| 列表过期 → 提示刷新 | Task 5 |
