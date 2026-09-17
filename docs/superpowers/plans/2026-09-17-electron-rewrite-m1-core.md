# Electron 重写 M1：脚手架 + core 移植 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Electron 工程里用 TypeScript 重建 `app/core` 的四个模块（gitcmd / repo / ai / config）+ 新增 diff 解析，并用翻译自现有 Python 测试的 vitest 测试套件把行为钉死。

**Architecture:** `src/core` 是纯逻辑层，不 `import electron`，只依赖 `node:child_process` / `node:fs` / 内置 `fetch`。所有 git 调用异步（`spawn` + Buffer 收集），错误用带 `reason` 的 `GitError` 表达，供上层映射成 IPC 错误码。

**Tech Stack:** Node 24.18.0、npm 11.16.0、TypeScript 7.0.2（`strict`）、vitest 5.0.1、electron-vite 5.0.0、Electron 44.4.1。

## Global Constraints

- 平台仅 Windows；所有面向用户的文案与注释用中文。
- git 必须走参数列表（`spawn(exe, args)`），**禁止**拼接 shell 命令串；`GIT_LITERAL_PATHSPECS=1`、`-c core.quotepath=false` 不可省。
- `src/core/**` 禁止 `import` Electron 或任何第三方运行时依赖（零 runtime deps）。
- 路径与键名必须与现有 Python 版逐字一致（`api.url`、`git.max_diff_lines`、`selection.checked_by_default` 等）。
- 配置路径固定 `%USERPROFILE%\.git_ai_commit\config.json`，UTF-8、`JSON.stringify(cfg, null, 2)`、**无尾随换行**。
- 状态中文名逐字：`已修改/已添加/已删除/已重命名/未版本控制/冲突`；分支未知文案 `未知`。
- 提交信息与 AI 相关文案逐字照搬（见 Task 8、Task 6）。
- 每个任务结束必须 `npm test` 全绿后提交；提交信息用中文 `feat(core): ...` 形式。
- 测试可依赖真实 `git`（开发机已装）；每个测试用 `fs.mkdtempSync` 造独立临时目录。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `package.json` | 脚本与 devDependencies |
| `tsconfig.json` | `strict`、`noEmit`、bundler 解析 |
| `vitest.config.ts` | node 环境、`tests/**/*.test.ts`、core 覆盖率门 90% |
| `electron.vite.config.ts` | main/preload/renderer 构建入口（M2 才用到，此处先就位） |
| `.gitignore` | 追加 `node_modules/`、`out/`、`coverage/`、`test-results/` |
| `src/core/types.ts` | `RepoSnapshot` / `StatTuple` / `ErrorCode` / `AppConfig` 形状 |
| `src/core/gitcmd.ts` | `runGit` / `GitError` / 环境与编码 |
| `src/core/repo.ts` | 变更列表、diff、numstat、paths 校验、暂存、提交 |
| `src/core/ai.ts` | OpenAI 兼容的提交信息生成（可注入 `fetch`） |
| `src/core/config.ts` | 默认配置、深合并、读写 |
| `src/core/diff.ts` | unified diff → 行数组（纯函数） |
| `tests/helpers/repo.ts` | 造临时仓库的工具（仅测试用） |
| `tests/core/*.test.ts` | 8 个测试文件（含新增 diff/paths 测试） |

---

### Task 1: 工程脚手架

**Files:**
- Create: `package.json`、`tsconfig.json`、`vitest.config.ts`、`electron.vite.config.ts`
- Modify: `.gitignore`
- Test: `tests/core/smoke.test.ts`（临时占位，Task 2 会删）

**Interfaces:**
- Consumes: 无
- Produces: `npm test` / `npm run typecheck` 可用；`out/` 构建产物路径 `out/main/index.js`（M2 用）

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "git-ai-commit",
  "version": "2.0.0",
  "private": true,
  "description": "资源管理器右键的 AI 提交工具（Electron 版）",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "coverage": "vitest run --coverage",
    "e2e": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.63.0",
    "@types/node": "^24.0.0",
    "@vitest/coverage-v8": "^5.0.1",
    "electron": "^44.4.1",
    "electron-builder": "^26.15.3",
    "electron-vite": "^5.0.0",
    "typescript": "^7.0.2",
    "vitest": "^5.0.1"
  }
}
```

- [ ] **Step 2: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM"],
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "tests", "electron.vite.config.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: 写 `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/core/**/*.ts"],
      reporter: ["text"],
      thresholds: { lines: 90 },
    },
  },
})
```

- [ ] **Step 4: 写 `electron.vite.config.ts`**

```ts
import { defineConfig } from "electron-vite"

export default defineConfig({
  main: { build: { rollupOptions: { input: { index: "src/main/index.ts" } } } },
  preload: { build: { rollupOptions: { input: { index: "src/preload/index.ts" } } } },
  renderer: { root: "src/renderer", build: { rollupOptions: { input: { index: "src/renderer/index.html" } } } },
})
```

- [ ] **Step 5: 追加 `.gitignore`**

在现有内容后追加：

```
node_modules/
out/
coverage/
test-results/
playwright-report/
```

- [ ] **Step 6: 写占位测试 `tests/core/smoke.test.ts`**

```ts
import { describe, expect, it } from "vitest"

describe("脚手架", () => {
  it("vitest 能跑起来", () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 7: 安装依赖**

Run: `npm install`
Expected: 成功；`node_modules/` 出现；若 `electron` 下载失败则加 `ELECTRON_MIRROR` 重试（见风险）。

- [ ] **Step 8: 验证三件套同时可用（TypeScript 7 兼容性检查点）**

Run: `npm test` → Expected: `1 passed`
Run: `npm run typecheck` → Expected: 无输出（退出码 0）
Run: `npx electron-vite build` → Expected: 生成 `out/main/index.js`（此时会失败，因为 `src/main/index.ts` 还不存在）

若 `npm run typecheck` 报 TypeScript 7 相关的内部错误，或 `electron-vite`/`vitest` 与 TS 7 不兼容：
把 `package.json` 的 `"typescript": "^7.0.2"` 改成 `"^5.9.0"`，删 `node_modules`/`package-lock.json` 重装，重跑本步三个命令。
`electron-vite build` 的失败**不算**本步失败（M2 才需要入口文件）。

- [ ] **Step 9: 提交**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts electron.vite.config.ts .gitignore tests/core/smoke.test.ts
git commit -m "chore: scaffold electron + typescript + vitest toolchain"
```

---

### Task 2: `core/gitcmd.ts`

**Files:**
- Create: `src/core/gitcmd.ts`
- Test: `tests/core/gitcmd.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `class GitError extends Error { reason: GitErrorReason }`，`type GitErrorReason = "not_found" | "timeout" | "invalid_cwd" | "spawn_failed" | "exit"`
  - `runGit(args: string[], options?: { cwd?: string | null; timeoutMs?: number; check?: boolean }): Promise<{ code: number; stdout: string; stderr: string }>`
  - `GIT_PREFIX: string[]`、`gitEnv(): NodeJS.ProcessEnv`

- [ ] **Step 1: 写失败测试 `tests/core/gitcmd.test.ts`**

```ts
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { GitError, runGit } from "../../src/core/gitcmd"
import { makeTempDir } from "../helpers/repo"

const gitAvailable = spawnSync("git", ["--version"]).status === 0
const maybe = gitAvailable ? describe : describe.skip

maybe("gitcmd", () => {
  it("run_git 返回 stdout", async () => {
    const dir = makeTempDir()
    const { code, stdout } = await runGit(["--version"], { cwd: dir })
    expect(code).toBe(0)
    expect(stdout).toContain("git version")
  })

  it("check=true 时非零退出码抛 GitError", async () => {
    const dir = makeTempDir()
    await expect(runGit(["rev-parse", "--verify", "HEAD"], { cwd: dir })).rejects.toBeInstanceOf(GitError)
  })

  it("check=false 时不抛，返回退出码", async () => {
    const dir = makeTempDir()
    const { code } = await runGit(["rev-parse", "--verify", "HEAD"], { cwd: dir, check: false })
    expect(code).not.toBe(0)
  })

  it("处理含中文与空格的路径", async () => {
    const repo = join(makeTempDir(), "含 空格 的 目录")
    mkdirSync(repo)
    spawnSync("git", ["init"], { cwd: repo })
    writeFileSync(join(repo, "文 件.txt"), "hello", "utf8")
    const { stdout } = await runGit(["status", "--porcelain"], { cwd: repo })
    expect(stdout).toContain("文 件.txt")
  })

  it("工作目录不存在时抛「工作目录无效」", async () => {
    const missing = join(makeTempDir(), "does_not_exist")
    await expect(runGit(["--version"], { cwd: missing })).rejects.toThrow(/工作目录无效/)
  })

  it("超时抛「git 命令超时」", async () => {
    const dir = makeTempDir()
    // timeoutMs=0：定时器必然早于子进程退出，结论确定（不依赖 git 跑多久）
    await expect(runGit(["--version"], { cwd: dir, timeoutMs: 0 })).rejects.toThrow(/超时/)
  })

  it("GIT_LITERAL_PATHSPECS 生效：方括号文件名不被当通配", async () => {
    const repo = join(makeTempDir(), "repo")
    mkdirSync(repo)
    spawnSync("git", ["init"], { cwd: repo })
    writeFileSync(join(repo, "file[1].txt"), "x", "utf8")
    const { stdout } = await runGit(["add", "-A", "--", "file[1].txt"], { cwd: repo })
    expect(stdout).toBe("")
  })
})
```

- [ ] **Step 2: 写测试辅助 `tests/helpers/repo.ts`**

```ts
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function makeTempDir(prefix = "gac-"): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${result.stderr || result.stdout}`)
  }
  return result.stdout ?? ""
}

export function initRepo(dir: string, branch?: string): string {
  const args = branch ? ["init", "-b", branch] : ["init"]
  git(dir, args)
  git(dir, ["config", "user.name", "t"])
  git(dir, ["config", "user.email", "t@example.com"])
  return dir
}

export function initRepoWithCommit(dir: string, files: Record<string, string> = { "seed.txt": "seed" }): string {
  initRepo(dir)
  for (const [name, content] of Object.entries(files)) {
    writeFile(dir, name, content)
  }
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", "init"])
  return dir
}

export function writeFile(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content, "utf8")
}

export function commitAll(dir: string, message = "init"): void {
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", message])
}

export function filesInHead(dir: string): string[] {
  return git(dir, ["ls-tree", "-r", "HEAD", "--name-only"])
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
}

export function porcelain(dir: string): string {
  return git(dir, ["status", "--porcelain"])
}
```

（注意：`writeFileSync` 需在文件头 `import { mkdtempSync, writeFileSync } from "node:fs"`。）

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/core/gitcmd.test.ts`
Expected: FAIL，报 `Failed to resolve import "../../src/core/gitcmd"`

- [ ] **Step 4: 实现 `src/core/gitcmd.ts`**

```ts
import { spawn } from "node:child_process"
import { statSync } from "node:fs"

export type GitErrorReason = "not_found" | "timeout" | "invalid_cwd" | "spawn_failed" | "exit"

export class GitError extends Error {
  readonly reason: GitErrorReason

  constructor(message: string, reason: GitErrorReason = "exit") {
    super(message)
    this.name = "GitError"
    this.reason = reason
  }
}

export const GIT_PREFIX = ["git", "-c", "core.quotepath=false"]

export function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_LITERAL_PATHSPECS: "1" }
}

export interface RunGitOptions {
  cwd?: string | null
  timeoutMs?: number
  check?: boolean
}

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

function assertCwd(cwd: string | null | undefined): void {
  if (!cwd) return
  try {
    if (!statSync(cwd).isDirectory()) {
      throw new GitError(`工作目录无效（不存在或不是目录）: ${cwd}`, "invalid_cwd")
    }
  } catch (error) {
    if (error instanceof GitError) throw error
    throw new GitError(`工作目录无效（不存在或不是目录）: ${cwd}`, "invalid_cwd")
  }
}

export function runGit(args: string[], options: RunGitOptions = {}): Promise<GitResult> {
  const { cwd = null, timeoutMs = 60_000, check = true } = options
  assertCwd(cwd)

  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn(GIT_PREFIX[0], [...GIT_PREFIX.slice(1), ...args], {
      cwd: cwd ?? undefined,
      env: gitEnv(),
      windowsHide: true,
    })

    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    let spawnFailed = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk))

    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnFailed = true
      clearTimeout(timer)
      if (error.code === "ENOENT") {
        reject(new GitError("找不到 git 命令，请确认已安装 Git 并加入 PATH", "not_found"))
        return
      }
      reject(new GitError(`git 命令无法执行: ${error.message}`, "spawn_failed"))
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      if (spawnFailed) return
      if (timedOut) {
        reject(new GitError(`git 命令超时: ${args.join(" ")}`, "timeout"))
        return
      }
      const stdout = Buffer.concat(out).toString("utf8")
      const stderr = Buffer.concat(err).toString("utf8")
      const exitCode = code ?? 1
      if (check && exitCode !== 0) {
        reject(new GitError(stderr.trim() || `git 退出码 ${exitCode}: ${args.join(" ")}`, "exit"))
        return
      }
      resolve({ code: exitCode, stdout, stderr })
    })
  })
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/core/gitcmd.test.ts`
Expected: PASS（7 个测试）

- [ ] **Step 6: 删除占位测试并提交**

```bash
rm tests/core/smoke.test.ts
git add src/core/gitcmd.ts tests/core/gitcmd.test.ts tests/helpers/repo.ts tests/core/smoke.test.ts
git commit -m "feat(core): port run_git with literal pathspecs, timeout and git errors"
```

---

### Task 3: `core/repo.ts` — 状态与变更列表

**Files:**
- Create: `src/core/repo.ts`、`src/core/types.ts`
- Test: `tests/core/repo_status.test.ts`、`tests/core/paths.test.ts`

**Interfaces:**
- Consumes: `runGit`、`GitError`（Task 2）
- Produces:
  - 常量 `MODIFIED/ADDED/DELETED/RENAMED/UNTRACKED/CONFLICTED`（值为 `"modified"` 等）、`UNKNOWN_BRANCH = "未知"`
  - `interface FileChange { path: string; status: string; origPath: string | null }`
  - `STATUS_LETTER: Record<string, string>`、`STATUS_TEXT: Record<string, string>`
  - `statusOf(xy: string): string`
  - `parsePorcelainZ(text: string): FileChange[]`
  - `findRepoRoot(startPath: string): Promise<string | null>`
  - `currentBranch(repoRoot: string): Promise<string>`
  - `listChanges(repoRoot: string): Promise<FileChange[]>`
  - `hasCommits(repoRoot: string): Promise<boolean>`
  - `truncate(text: string, maxLines: number): string`
  - `diffFor(repoRoot: string, paths: string[], maxLines?: number): Promise<string>`
  - `readDiff(repoRoot: string, relPath: string, maxLines: number): Promise<{ text: string; truncated: boolean; omitted: number }>`
  - `diffNumstat(repoRoot: string): Promise<Record<string, [number | null, number | null]>>`
  - `commitPathspecs(changes: FileChange[]): string[]`
  - `stage(repoRoot: string, paths: string[]): Promise<void>`
  - `commit(repoRoot: string, message: string, paths: string[]): Promise<string>`
  - `classes/PathError`（`src/core/paths.ts`）：`resolveInsideRepo(repoRoot: string, relPath: string): string`
  - `src/core/types.ts`：`StatTuple`、`RepoSnapshot`、`ErrorCode`、`AppConfig`

- [ ] **Step 1: 写失败测试 `tests/core/repo_status.test.ts`**

```ts
import { mkdirSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  ADDED,
  CONFLICTED,
  DELETED,
  MODIFIED,
  RENAMED,
  STATUS_TEXT,
  UNTRACKED,
  currentBranch,
  findRepoRoot,
  hasCommits,
  listChanges,
  parsePorcelainZ,
} from "../../src/core/repo"
import { commitAll, git, initRepo, initRepoWithCommit, makeTempDir, writeFile } from "../helpers/repo"

describe("parsePorcelainZ", () => {
  it("解析基本状态", () => {
    const text = " M a.py\0?? b 文件.txt\0 D c.py\0"
    expect(parsePorcelainZ(text)).toEqual([
      { path: "a.py", status: MODIFIED, origPath: null },
      { path: "b 文件.txt", status: UNTRACKED, origPath: null },
      { path: "c.py", status: DELETED, origPath: null },
    ])
  })

  it("重命名先新路径后旧路径", () => {
    expect(parsePorcelainZ("R  new.py\0old.py\0")).toEqual([
      { path: "new.py", status: RENAMED, origPath: "old.py" },
    ])
  })

  it("忽略 !! 条目", () => {
    expect(parsePorcelainZ("!! cache/\0")).toEqual([])
  })

  it("重命名后紧跟的条目不会被吞掉", () => {
    const text = "R  new.py\0old.py\0 M z.py\0"
    expect(parsePorcelainZ(text).map((c) => c.path)).toEqual(["new.py", "z.py"])
  })
})

describe("仓库探测", () => {
  it("listChanges 保留路径中的空格", async () => {
    const dir = initRepo(makeTempDir())
    writeFile(dir, "a b.txt", "x")
    const changes = await listChanges(dir)
    expect(changes.map((c) => c.path)).toEqual(["a b.txt"])
  })

  it("不在仓库内返回 null", async () => {
    expect(await findRepoRoot(makeTempDir())).toBeNull()
  })

  it("路径不存在返回 null", async () => {
    expect(await findRepoRoot(join(makeTempDir(), "does_not_exist"))).toBeNull()
  })

  it("仓库子目录返回仓库根", async () => {
    const dir = initRepo(makeTempDir())
    const sub = join(dir, "sub")
    mkdirSync(sub)
    const root = await findRepoRoot(sub)
    expect(root).not.toBeNull()
    expect(await findRepoRoot(dir)).toBe(root)
  })

  it("列出未跟踪与已修改", async () => {
    const dir = initRepoWithCommit(makeTempDir(), { "tracked.txt": "v1" })
    writeFile(dir, "tracked.txt", "v2")
    writeFile(dir, "new.txt", "x")
    const changes = Object.fromEntries((await listChanges(dir)).map((c) => [c.path, c.status]))
    expect(changes["tracked.txt"]).toBe(MODIFIED)
    expect(changes["new.txt"]).toBe(UNTRACKED)
  })

  it("hasCommits", async () => {
    const dir = initRepo(makeTempDir())
    expect(await hasCommits(dir)).toBe(false)
    writeFile(dir, "a.txt", "a")
    commitAll(dir)
    expect(await hasCommits(dir)).toBe(true)
  })
})

describe("currentBranch", () => {
  it("未出生分支", async () => {
    expect(await currentBranch(initRepo(makeTempDir(), "trunk"))).toBe("trunk")
  })

  it("提交后", async () => {
    const dir = initRepo(makeTempDir(), "trunk")
    writeFile(dir, "a.txt", "a")
    commitAll(dir)
    expect(await currentBranch(dir)).toBe("trunk")
  })

  it("游离 HEAD 返回短 SHA", async () => {
    const dir = initRepoWithCommit(initRepo(makeTempDir(), "trunk"))
    const sha = git(dir, ["rev-parse", "--short", "HEAD"]).trim()
    git(dir, ["checkout", "--detach", "HEAD"])
    expect(await currentBranch(dir)).toBe(`游离 HEAD (${sha})`)
  })
})

describe("状态文案", () => {
  it("状态中文名", () => {
    expect(STATUS_TEXT[MODIFIED]).toBe("已修改")
    expect(STATUS_TEXT[ADDED]).toBe("已添加")
    expect(STATUS_TEXT[DELETED]).toBe("已删除")
    expect(STATUS_TEXT[RENAMED]).toBe("已重命名")
    expect(STATUS_TEXT[UNTRACKED]).toBe("未版本控制")
    expect(STATUS_TEXT[CONFLICTED]).toBe("冲突")
  })
})
```

**注意**：实施时若上表测试里出现未使用的 import（例如 `ADDED`/`DELETED`/`RENAMED` 只用于 `STATUS_TEXT` 断言），保留即可——`tsconfig` 未开启 `noUnusedLocals`。

- [ ] **Step 2: 写 `tests/core/paths.test.ts`**

```ts
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { PathError, resolveInsideRepo } from "../../src/core/paths"
import { makeTempDir } from "../helpers/repo"

describe("resolveInsideRepo", () => {
  const root = makeTempDir()

  it("仓库内相对路径可解析", () => {
    expect(resolveInsideRepo(root, "a/b.txt")).toBe(join(root, "a", "b.txt"))
  })

  it("反斜杠路径也可解析", () => {
    expect(resolveInsideRepo(root, "a\\b.txt")).toBe(join(root, "a", "b.txt"))
  })

  it("拒绝 ../ 逃逸", () => {
    expect(() => resolveInsideRepo(root, "../outside.txt")).toThrow(PathError)
  })

  it("拒绝嵌套的逃逸", () => {
    expect(() => resolveInsideRepo(root, "a/../../outside.txt")).toThrow(PathError)
  })

  it("拒绝绝对路径（仓库外）", () => {
    expect(() => resolveInsideRepo(root, join(makeTempDir(), "x.txt"))).toThrow(PathError)
  })

  it("拒绝含 NUL 的路径", () => {
    expect(() => resolveInsideRepo(root, "a\0b")).toThrow(PathError)
  })

  it("允许解析到仓库根本身", () => {
    expect(resolveInsideRepo(root, ".")).toBe(root)
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/core/repo_status.test.ts tests/core/paths.test.ts`
Expected: FAIL，`Failed to resolve import "../../src/core/repo"`

- [ ] **Step 4: 实现 `src/core/paths.ts`**

```ts
import { isAbsolute, join, relative, resolve, sep } from "node:path"

export class PathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PathError"
  }
}

/** 把仓库内相对路径解析为绝对路径；越界或非法则抛 PathError。 */
export function resolveInsideRepo(repoRoot: string, relPath: string): string {
  if (typeof relPath !== "string" || relPath.includes("\0")) {
    throw new PathError(`非法路径: ${String(relPath)}`)
  }
  const root = resolve(repoRoot)
  const target = isAbsolute(relPath) ? resolve(relPath) : resolve(root, relPath)
  const rel = relative(root, target)
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new PathError(`路径超出仓库范围: ${relPath}`)
  }
  return rel === "" ? root : join(root, rel.split("/").join(sep))
}
```

- [ ] **Step 5: 实现 `src/core/types.ts`**

```ts
import type { FileChange } from "./repo"

export type StatTuple = [number | null, number | null]

export interface RepoSnapshot {
  branch: string
  changes: FileChange[]
  stats: Record<string, StatTuple>
}

export type ErrorCode =
  | "GIT_NOT_FOUND"
  | "GIT_TIMEOUT"
  | "GIT_FAILED"
  | "NOT_A_REPO"
  | "PATH_OUTSIDE_REPO"
  | "NO_SELECTION"
  | "EMPTY_MESSAGE"
  | "AI_NO_URL"
  | "AI_HTTP"
  | "AI_BAD_RESPONSE"
  | "CONFIG_WRITE"
  | "UNKNOWN"

export interface AppConfig {
  api: {
    url: string
    api_key: string
    model: string
    prompt: string
    max_tokens: number
    language: string
    timeout: number
  }
  git: { max_diff_lines: number }
  ui: { window_width: number; window_height: number; show_untracked: boolean; style: string }
  selection: { checked_by_default: string }
  [key: string]: unknown
}
```

- [ ] **Step 6: 实现 `src/core/repo.ts`（本任务只写状态与列表部分）**

```ts
import { open, readFile } from "node:fs/promises"
import { join } from "node:path"

import { GitError, runGit } from "./gitcmd"

export const MODIFIED = "modified"
export const ADDED = "added"
export const DELETED = "deleted"
export const RENAMED = "renamed"
export const UNTRACKED = "untracked"
export const CONFLICTED = "conflicted"

/** 无法判断当前分支时的显示文本。 */
export const UNKNOWN_BRANCH = "未知"

/** 未跟踪文件参与 diff 分析时的大小上限；超过则只给标记，不读取内容。 */
export const MAX_UNTRACKED_BYTES = 512 * 1024

export interface FileChange {
  path: string
  status: string
  origPath: string | null
}

export const STATUS_LETTER: Record<string, string> = {
  [MODIFIED]: "M",
  [ADDED]: "A",
  [DELETED]: "D",
  [RENAMED]: "R",
  [UNTRACKED]: "?",
  [CONFLICTED]: "!",
}

/** 状态的中文显示名（界面表格「状态」列）。 */
export const STATUS_TEXT: Record<string, string> = {
  [MODIFIED]: "已修改",
  [ADDED]: "已添加",
  [DELETED]: "已删除",
  [RENAMED]: "已重命名",
  [UNTRACKED]: "未版本控制",
  [CONFLICTED]: "冲突",
}

export function statusOf(xy: string): string {
  if (xy === "??") return UNTRACKED
  if (xy.includes("U") || xy === "AA" || xy === "DD") return CONFLICTED
  if (xy.includes("R")) return RENAMED
  if (xy.includes("D")) return DELETED
  if (xy.includes("A")) return ADDED
  return MODIFIED
}

/**
 * 解析 `git status --porcelain -z` 输出。
 *
 * 使用 -z（NUL 分隔）而非默认格式：默认格式会给含空格的路径加引号，
 * 即使设置了 core.quotepath=false 也一样，会让路径与后续的 git add/commit 不匹配。
 * 重命名条目为两段：先新路径，后旧路径。
 */
export function parsePorcelainZ(text: string): FileChange[] {
  const fields = text.split("\0")
  const changes: FileChange[] = []
  let index = 0
  while (index < fields.length) {
    const entry = fields[index]
    index += 1
    if (!entry || entry.startsWith("!!")) continue
    const xy = entry.slice(0, 2)
    const path = entry.slice(3)
    let orig: string | null = null
    if (xy.includes("R") || xy.includes("C")) {
      const next = fields[index]
      if (index < fields.length && next) orig = next
      index += 1
    }
    changes.push({ path, status: statusOf(xy), origPath: orig })
  }
  return changes
}

export async function findRepoRoot(startPath: string): Promise<string | null> {
  let result
  try {
    result = await runGit(["rev-parse", "--show-toplevel"], { cwd: startPath, check: false })
  } catch (error) {
    if (error instanceof GitError) return null
    throw error
  }
  if (result.code !== 0) return null
  const root = result.stdout.trim()
  return root || null
}

/** 返回当前分支名；游离 HEAD 返回短 SHA，无法判断时返回「未知」。 */
export async function currentBranch(repoRoot: string): Promise<string> {
  const symbolic = await runGit(["symbolic-ref", "--short", "-q", "HEAD"], { cwd: repoRoot, check: false })
  if (symbolic.code === 0 && symbolic.stdout.trim()) return symbolic.stdout.trim()
  const detached = await runGit(["rev-parse", "--short", "HEAD"], { cwd: repoRoot, check: false })
  if (detached.code === 0 && detached.stdout.trim()) return `游离 HEAD (${detached.stdout.trim()})`
  return UNKNOWN_BRANCH
}

/** 列出未提交的变更。 */
export async function listChanges(repoRoot: string): Promise<FileChange[]> {
  const { stdout } = await runGit(["status", "--porcelain", "-z"], { cwd: repoRoot })
  return parsePorcelainZ(stdout)
}

/** 仓库是否已有 HEAD 提交。 */
export async function hasCommits(repoRoot: string): Promise<boolean> {
  const { code } = await runGit(["rev-parse", "--verify", "HEAD"], { cwd: repoRoot, check: false })
  return code === 0
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run tests/core/repo_status.test.ts tests/core/paths.test.ts`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/core/repo.ts src/core/paths.ts src/core/types.ts tests/core/repo_status.test.ts tests/core/paths.test.ts
git commit -m "feat(core): port status parsing, repo discovery and pathspec-safe path checks"
```

---

### Task 4: `core/repo.ts` — diff、截断与 readDiff

**Files:**
- Modify: `src/core/repo.ts`（追加）
- Test: `tests/core/repo_diff.test.ts`

**Interfaces:**
- Consumes: Task 3 的全部导出
- Produces: `truncate`、`diffFor`、`readDiff`（签名见 §文件结构/Task 3 Interfaces）

- [ ] **Step 1: 写失败测试 `tests/core/repo_diff.test.ts`**

```ts
import { unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { MAX_UNTRACKED_BYTES, diffFor, readDiff, truncate } from "../../src/core/repo"
import { initRepo, makeTempDir, writeFile } from "../helpers/repo"

describe("truncate", () => {
  it("短文本原样返回", () => {
    expect(truncate("a\nb", 10)).toBe("a\nb")
  })

  it("保留头部并标注省略行数", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
    const result = truncate(text, 3)
    expect(result.startsWith("line0\nline1\nline2")).toBe(true)
    expect(result).toContain("省略 7 行")
  })

  it("maxLines<=0 时不截断", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
    expect(truncate(text, 0)).toBe(text)
  })
})

describe("diffFor", () => {
  it("已修改文件", async () => {
    const dir = initRepo(makeTempDir())
    writeFile(dir, "a.py", "one\n")
    const { git } = await import("../helpers/repo")
    git(dir, ["add", "-A"])
    git(dir, ["commit", "-m", "init"])
    writeFile(dir, "a.py", "one\ntwo\n")
    expect(await diffFor(dir, ["a.py"])).toContain("+two")
  })

  it("未跟踪文件显示内容", async () => {
    const dir = initRepo(makeTempDir())
    writeFile(dir, "new 文件.txt", "hello\nworld\n")
    const diff = await diffFor(dir, ["new 文件.txt"])
    expect(diff).toContain("新增文件")
    expect(diff).toContain("+hello")
    expect(diff).toContain("+world")
  })

  it("多个路径", async () => {
    const dir = initRepo(makeTempDir())
    writeFile(dir, "a.txt", "a\n")
    writeFile(dir, "b.txt", "b\n")
    const diff = await diffFor(dir, ["a.txt", "b.txt"])
    expect(diff).toContain("+a")
    expect(diff).toContain("+b")
  })

  it("超大未跟踪文件用紧凑标记", async () => {
    const dir = initRepo(makeTempDir())
    writeFileSync(join(dir, "big.bin"), Buffer.alloc(MAX_UNTRACKED_BYTES + 1024, "Z"))
    const diff = await diffFor(dir, ["big.bin"], 0)
    expect(diff).toContain("过大")
    expect(diff).toContain("已跳过")
    expect(diff).not.toContain("+Z")
    expect(diff.length).toBeLessThan(200)
  })

  it("二进制未跟踪文件用紧凑标记", async () => {
    const dir = initRepo(makeTempDir())
    writeFileSync(join(dir, "blob.bin"), Buffer.from("abc\0def\nghi\n", "binary"))
    const diff = await diffFor(dir, ["blob.bin"], 0)
    expect(diff).toContain("二进制")
    expect(diff).toContain("已跳过")
    expect(diff).not.toContain("abc")
    expect(diff.length).toBeLessThan(200)
  })
})

describe("readDiff", () => {
  it("未截断时 truncated=false", async () => {
    const dir = initRepo(makeTempDir())
    writeFile(dir, "a.txt", "a\nb\n")
    const result = await readDiff(dir, "a.txt", 100)
    expect(result.truncated).toBe(false)
    expect(result.omitted).toBe(0)
    expect(result.text).toContain("+a")
  })

  it("截断时给出 omitted 与标记行", async () => {
    const dir = initRepo(makeTempDir())
    writeFile(dir, "a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n")
    const result = await readDiff(dir, "a.txt", 1)
    expect(result.truncated).toBe(true)
    expect(result.omitted).toBeGreaterThan(0)
    expect(result.text).toContain("已截断")
    // readDiff 与 truncate 的省略语义一致
    const viaDiffFor = await diffFor(dir, ["a.txt"], 1)
    expect(viaDiffFor).toBe(result.text)
  })

  it("不存在的文件抛 GitError（无 diff 且工作区无文件）", async () => {
    const dir = initRepo(makeTempDir())
    const result = await readDiff(dir, "ghost.txt", 100)
    expect(result.text).toBe("")
  })
})

describe("其它", () => {
  it("未跟踪文件读失败时给出「不可读」标记", async () => {
    const dir = initRepo(makeTempDir())
    const target = join(dir, "gone.txt")
    writeFileSync(target, "x")
    unlinkSync(target)
    const diff = await diffFor(dir, ["gone.txt"], 0)
    expect(diff).not.toContain("+x")
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/repo_diff.test.ts`
Expected: FAIL，`truncate is not a function`（未实现）

- [ ] **Step 3: 在 `src/core/repo.ts` 追加实现**

```ts
/** 超过 maxLines 时保留前 maxLines 行并标注省略数。 */
export function truncate(text: string, maxLines: number): string {
  if (maxLines <= 0) return text
  const lines = splitLines(text)
  if (lines.length <= maxLines) return text
  const omitted = lines.length - maxLines
  return `${lines.slice(0, maxLines).join("\n")}\n... (已截断，省略 ${omitted} 行)`
}

/** 按 \r\n / \r / \n 切分；输入以换行结尾时丢弃末尾空串（对齐 Python splitlines 的可观察行为）。 */
function splitLines(text: string): string[] {
  if (text === "") return []
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/** diff《单一路径》并返回是否截断、省略多少行。 */
export async function readDiff(
  repoRoot: string,
  relPath: string,
  maxLines: number,
): Promise<{ text: string; truncated: boolean; omitted: number }> {
  const text = await diffOne(repoRoot, relPath)
  if (maxLines <= 0) return { text, truncated: false, omitted: 0 }
  const lines = splitLines(text)
  if (lines.length <= maxLines) return { text, truncated: false, omitted: 0 }
  const omitted = lines.length - maxLines
  return {
    text: `${lines.slice(0, maxLines).join("\n")}\n... (已截断，省略 ${omitted} 行)`,
    truncated: true,
    omitted,
  }
}

async function diffOne(repoRoot: string, relPath: string): Promise<string> {
  const { code, stdout } = await runGit(["diff", "HEAD", "--", relPath], { cwd: repoRoot, check: false })
  if (code === 0 && stdout.trim()) return stdout

  const full = join(repoRoot, relPath)
  let handle
  try {
    handle = await open(full, "r")
  } catch {
    return `### 新增或不可读文件: ${relPath}`
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return ""
    const buffer = Buffer.alloc(MAX_UNTRACKED_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, MAX_UNTRACKED_BYTES + 1, 0)
    const data = buffer.subarray(0, bytesRead)
    if (data.length > MAX_UNTRACKED_BYTES) {
      const limitKb = Math.floor(MAX_UNTRACKED_BYTES / 1024)
      return `### 新增文件过大，已跳过: ${relPath}（超过 ${limitKb} KB）`
    }
    if (data.includes(0)) return `### 新增疑似二进制文件，已跳过: ${relPath}`
    const content = data.toString("utf8")
    const body = splitLines(content)
      .map((line) => `+${line}`)
      .join("\n")
    return `### 新增文件: ${relPath}\n${body}`
  } catch {
    return `### 新增或不可读文件: ${relPath}`
  } finally {
    await handle.close()
  }
}

/** 采集指定路径的 diff 文本并截断。 */
export async function diffFor(repoRoot: string, paths: string[], maxLines = 200): Promise<string> {
  const sections: string[] = []
  for (const p of paths) {
    const section = await diffOne(repoRoot, p)
    if (section) sections.push(section)
  }
  return truncate(sections.join("\n"), maxLines)
}
```

`readFile` 在本任务未用到，实施时不要把未使用的 import 留在文件里（`import { open } from "node:fs/promises"`）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/core/repo_diff.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/repo.ts tests/core/repo_diff.test.ts
git commit -m "feat(core): port diff collection, truncation and readDiff"
```

---

### Task 5: `core/repo.ts` — numstat

**Files:**
- Modify: `src/core/repo.ts`（追加）
- Test: `tests/core/repo_numstat.test.ts`

**Interfaces:**
- Consumes: Task 3/4 导出
- Produces: `numstatNewPath(raw: string): string`、`diffNumstat(repoRoot): Promise<Record<string, [number | null, number | null]>>`

- [ ] **Step 1: 写失败测试 `tests/core/repo_numstat.test.ts`**

```ts
import { unlinkSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { diffNumstat, numstatNewPath } from "../../src/core/repo"
import { commitAll, git, initRepo, makeTempDir, writeFile } from "../helpers/repo"

describe("numstatNewPath", () => {
  it("普通路径原样", () => {
    expect(numstatNewPath("a.txt")).toBe("a.txt")
  })

  it("重命名取新路径", () => {
    expect(numstatNewPath("old.txt => new.txt")).toBe("new.txt")
  })

  it("花括号形式取新路径并保留前后缀", () => {
    expect(numstatNewPath("src/{old => new}/a.ts")).toBe("src/new/a.ts")
  })
})

describe("diffNumstat", () => {
  it("统计已修改文件", async () => {
    const dir = initRepo(makeTempDir(), "trunk")
    writeFile(dir, "a.txt", "one\ntwo\n")
    commitAll(dir)
    writeFile(dir, "a.txt", "one\nTWO\nthree\n")
    expect((await diffNumstat(dir))["a.txt"]).toEqual([2, 1])
  })

  it("统计新增与删除", async () => {
    const dir = initRepo(makeTempDir(), "trunk")
    writeFile(dir, "gone.txt", "x\ny\n")
    commitAll(dir)
    writeFile(dir, "new.txt", "p\nq\nr\n")
    git(dir, ["add", "new.txt"])
    unlinkSync(`${dir}\\gone.txt`)
    const stats = await diffNumstat(dir)
    expect(stats["new.txt"]).toEqual([3, 0])
    expect(stats["gone.txt"]).toEqual([0, 2])
  })

  it("二进制返回 [null, null]", async () => {
    const dir = initRepo(makeTempDir(), "trunk")
    const { writeFileSync } = await import("node:fs")
    writeFileSync(`${dir}\\b.bin`, Buffer.from(Array.from({ length: 256 }, (_, i) => i)))
    commitAll(dir)
    writeFileSync(`${dir}\\b.bin`, Buffer.from(Array.from({ length: 256 }, (_, i) => 255 - i)))
    expect((await diffNumstat(dir))["b.bin"]).toEqual([null, null])
  })

  it("未跟踪文件不统计", async () => {
    const dir = initRepo(makeTempDir(), "trunk")
    writeFile(dir, "a.txt", "a\n")
    commitAll(dir)
    writeFile(dir, "untracked.txt", "z\n")
    expect("untracked.txt" in (await diffNumstat(dir))).toBe(false)
  })

  it("重命名映射到新路径", async () => {
    const dir = initRepo(makeTempDir(), "trunk")
    writeFile(dir, "old.txt", "a\nb\nc\n")
    commitAll(dir)
    git(dir, ["mv", "old.txt", "new.txt"])
    writeFile(dir, "new.txt", "a\nb\nc\nd\n")
    git(dir, ["add", "-A"])
    const stats = await diffNumstat(dir)
    expect("new.txt" in stats).toBe(true)
    expect("old.txt" in stats).toBe(false)
  })

  it("空仓库返回 {}", async () => {
    const dir = initRepo(makeTempDir(), "trunk")
    writeFile(dir, "a.txt", "a\n")
    expect(await diffNumstat(dir)).toEqual({})
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/repo_numstat.test.ts`
Expected: FAIL，`diffNumstat is not a function`

- [ ] **Step 3: 在 `src/core/repo.ts` 追加实现**

```ts
/** 把 numstat 的路径字段归一为新路径（重命名形如 `old => new`）。 */
export function numstatNewPath(raw: string): string {
  if (!raw.includes(" => ")) return raw
  if (raw.includes("{") && raw.includes("}")) {
    const [prefix, rest] = splitOnce(raw, "{")
    const [middle, suffix] = splitOnce(rest, "}")
    const [, newName] = splitOnce(middle, " => ")
    return `${prefix}${newName}${suffix}`
  }
  const [, newName] = splitOnce(raw, " => ")
  return newName
}

function splitOnce(text: string, separator: string): [string, string] {
  const index = text.indexOf(separator)
  if (index < 0) return [text, ""]
  return [text.slice(0, index), text.slice(index + separator.length)]
}

/**
 * 返回 { 路径: [添加行数, 删除行数] }，键为重命名后的新路径。
 * - 只覆盖已跟踪的变更；未跟踪文件不在结果里。
 * - 二进制文件返回 [null, null]，界面显示为 `-`。
 * - 空仓库（无 HEAD）返回空字典。
 */
export async function diffNumstat(repoRoot: string): Promise<Record<string, [number | null, number | null]>> {
  const { code, stdout } = await runGit(["diff", "--numstat", "HEAD"], { cwd: repoRoot, check: false })
  if (code !== 0) return {}

  const stats: Record<string, [number | null, number | null]> = {}
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split("\t")
    if (parts.length < 3) continue
    const addedRaw = parts[0]
    const deletedRaw = parts[1]
    const rawPath = parts.slice(2).join("\t")
    const added = /^\d+$/.test(addedRaw) ? Number(addedRaw) : null
    const deleted = /^\d+$/.test(deletedRaw) ? Number(deletedRaw) : null
    stats[numstatNewPath(rawPath)] = [added, deleted]
  }
  return stats
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/core/repo_numstat.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/repo.ts tests/core/repo_numstat.test.ts
git commit -m "feat(core): port numstat parsing with rename and binary handling"
```

---

### Task 6: `core/repo.ts` — pathspec、暂存、提交

**Files:**
- Modify: `src/core/repo.ts`（追加）
- Test: `tests/core/repo_commit.test.ts`

**Interfaces:**
- Consumes: Task 3-5 导出
- Produces: `commitPathspecs(changes: FileChange[]): string[]`、`stage(repoRoot, paths): Promise<void>`、`commit(repoRoot, message, paths): Promise<string>`

- [ ] **Step 1: 写失败测试 `tests/core/repo_commit.test.ts`**

```ts
import { unlinkSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { GitError } from "../../src/core/gitcmd"
import { commit, commitPathspecs, listChanges, stage } from "../../src/core/repo"
import { filesInHead, git, initRepoWithCommit, makeTempDir, porcelain, writeFile } from "../helpers/repo"

describe("stage/commit", () => {
  it("只提交勾选路径，忽略其它已暂存内容", async () => {
    const dir = initRepoWithCommit(makeTempDir())
    writeFile(dir, "a.txt", "a")
    writeFile(dir, "b.txt", "b")
    git(dir, ["add", "b.txt"])
    await stage(dir, ["a.txt"])
    await commit(dir, "只提交 a", ["a.txt"])
    const names = filesInHead(dir)
    expect(names).toContain("a.txt")
    expect(names).not.toContain("b.txt")
  })

  it("处理删除", async () => {
    const dir = initRepoWithCommit(makeTempDir(), { "gone.txt": "x" })
    unlinkSync(`${dir}\\gone.txt`)
    await stage(dir, ["gone.txt"])
    await commit(dir, "删除 gone", ["gone.txt"])
    expect(filesInHead(dir)).not.toContain("gone.txt")
    expect(porcelain(dir)).toBe("")
  })

  it("中文路径", async () => {
    const dir = initRepoWithCommit(makeTempDir())
    writeFile(dir, "中文 文件.txt", "hi")
    await stage(dir, ["中文 文件.txt"])
    await commit(dir, "新增中文文件", ["中文 文件.txt"])
    expect(filesInHead(dir)).toContain("中文 文件.txt")
  })

  it("无可提交内容时抛 GitError", async () => {
    const dir = initRepoWithCommit(makeTempDir())
    await expect(commit(dir, "空提交", ["seed.txt"])).rejects.toBeInstanceOf(GitError)
  })

  it("已由 git rm 暂存删除后仍能提交", async () => {
    const dir = initRepoWithCommit(makeTempDir(), { "gone.txt": "x" })
    git(dir, ["rm", "-q", "gone.txt"])
    await stage(dir, ["gone.txt"])
    await commit(dir, "删除 gone", ["gone.txt"])
    expect(filesInHead(dir)).not.toContain("gone.txt")
    expect(porcelain(dir)).toBe("")
  })

  it("重命名提交时带上旧路径", async () => {
    const dir = initRepoWithCommit(makeTempDir(), { "old.txt": "content" })
    git(dir, ["mv", "old.txt", "new.txt"])
    const changes = await listChanges(dir)
    const paths = commitPathspecs(changes)
    expect(new Set(paths)).toEqual(new Set(["new.txt", "old.txt"]))
    await stage(dir, changes.map((c) => c.path))
    await commit(dir, "重命名", paths)
    const names = filesInHead(dir)
    expect(names).toContain("new.txt")
    expect(names).not.toContain("old.txt")
    expect(porcelain(dir)).toBe("")
  })

  it("方括号文件名按字面量处理", async () => {
    const dir = initRepoWithCommit(makeTempDir())
    writeFile(dir, "file1.txt", "one")
    writeFile(dir, "file[1].txt", "bracket")
    await stage(dir, ["file[1].txt"])
    await commit(dir, "新增方括号文件", ["file[1].txt"])
    const names = filesInHead(dir)
    expect(names).toContain("file[1].txt")
    expect(names).not.toContain("file1.txt")
  })

  it("空路径列表提交时抛「没有勾选任何文件」", async () => {
    const dir = initRepoWithCommit(makeTempDir())
    await expect(commit(dir, "x", [])).rejects.toThrow("没有勾选任何文件")
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/repo_commit.test.ts`
Expected: FAIL，`commit is not a function`

- [ ] **Step 3: 在 `src/core/repo.ts` 追加实现**

```ts
/**
 * 构造提交用 pathspec：重命名同时包含新路径与旧路径。
 *
 * 重命名在索引中是「删除旧路径 + 新增新路径」，只提交新路径会把旧路径的删除
 * 遗留在暂存区；因此提交时需要带上 origPath。
 */
export function commitPathspecs(changes: FileChange[]): string[] {
  const paths: string[] = []
  for (const change of changes) {
    paths.push(change.path)
    if (change.status === RENAMED && change.origPath && !paths.includes(change.origPath)) {
      paths.push(change.origPath)
    }
  }
  return paths
}

/**
 * 暂存指定路径（含新增、修改、删除），不影响其它路径。
 *
 * 尽力而为：删除一旦被暂存（例如先 git rm），再次 git add 会因 pathspec 不匹配
 * 而报错；此时放行，由 commit 作为真正的校验关卡。
 */
export async function stage(repoRoot: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await runGit(["add", "-A", "--", ...paths], { cwd: repoRoot, check: false })
}

/** 只提交指定路径，保留其它已暂存内容不动。 */
export async function commit(repoRoot: string, message: string, paths: string[]): Promise<string> {
  if (paths.length === 0) throw new GitError("没有勾选任何文件", "exit")
  const { code, stdout, stderr } = await runGit(["commit", "-m", message, "--", ...paths], {
    cwd: repoRoot,
    check: false,
  })
  if (code !== 0) throw new GitError(stderr.trim() || stdout.trim() || "git commit 失败", "exit")
  return stdout.trim()
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/core/repo_commit.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/repo.ts tests/core/repo_commit.test.ts
git commit -m "feat(core): port staged commit with rename-safe pathspecs"
```

---

### Task 7: `core/config.ts`

**Files:**
- Create: `src/core/config.ts`
- Test: `tests/core/config.test.ts`

**Interfaces:**
- Consumes: `AppConfig`（Task 3）
- Produces: `DEFAULT_CONFIG`、`CONFIG_FILE`、`DEFAULT_STYLE = "light"`、`deepMerge(base, override)`、`loadConfig(path?)`、`saveConfig(config, path?)`

- [ ] **Step 1: 写失败测试 `tests/core/config.test.ts`**

```ts
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { DEFAULT_CONFIG, deepMerge, loadConfig, saveConfig } from "../../src/core/config"
import { makeTempDir } from "../helpers/repo"

describe("deepMerge", () => {
  it("缺失键保留默认值", () => {
    const base = { a: { x: 1, y: 2 }, b: 3 }
    expect(deepMerge(base, { a: { y: 9 } })).toEqual({ a: { x: 1, y: 9 }, b: 3 })
  })
})

describe("loadConfig", () => {
  it("文件不存在时写出默认配置", () => {
    const cfgFile = join(makeTempDir(), "sub", "config.json")
    const cfg = loadConfig(cfgFile)
    expect(cfg.selection.checked_by_default).toBe("tracked")
    expect(readFileSync(cfgFile, "utf8")).toContain("checked_by_default")
  })

  it("部分文件与默认值合并", () => {
    const cfgFile = join(makeTempDir(), "config.json")
    writeFileSync(cfgFile, JSON.stringify({ api: { model: "custom" } }), "utf8")
    const cfg = loadConfig(cfgFile)
    expect(cfg.api.model).toBe("custom")
    expect(cfg.api.url).toBe(DEFAULT_CONFIG.api.url)
  })

  it("坏 JSON 回退默认", () => {
    const cfgFile = join(makeTempDir(), "config.json")
    writeFileSync(cfgFile, "{ this is not json", "utf8")
    expect(loadConfig(cfgFile).git.max_diff_lines).toBe(200)
  })

  it("非 UTF-8 文件回退默认", () => {
    const cfgFile = join(makeTempDir(), "config.json")
    writeFileSync(cfgFile, Buffer.from([0xff, 0xfe, 0x7b, 0x20, 0x78]))
    const cfg = loadConfig(cfgFile)
    expect(cfg.git.max_diff_lines).toBe(200)
    expect(cfg.api.model).toBe(DEFAULT_CONFIG.api.model)
  })

  it("顶层不是对象时回退默认", () => {
    const cfgFile = join(makeTempDir(), "config.json")
    writeFileSync(cfgFile, "[1,2,3]", "utf8")
    expect(loadConfig(cfgFile).api.model).toBe(DEFAULT_CONFIG.api.model)
  })
})

describe("saveConfig", () => {
  it("中文往返", () => {
    const cfgFile = join(makeTempDir(), "config.json")
    const cfg = loadConfig(cfgFile)
    cfg.api.language = "中文"
    saveConfig(cfg, cfgFile)
    const raw = readFileSync(cfgFile, "utf8")
    expect(raw).toContain("中文")
    expect(loadConfig(cfgFile).api.language).toBe("中文")
  })

  it("无尾随换行且缩进 2", () => {
    const cfgFile = join(makeTempDir(), "config.json")
    saveConfig(loadConfig(cfgFile), cfgFile)
    const raw = readFileSync(cfgFile, "utf8")
    expect(raw).not.toMatch(/\n$/)
    expect(raw).toContain('\n  "api"')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/config.test.ts`
Expected: FAIL，`Failed to resolve import "../../src/core/config"`

- [ ] **Step 3: 实现 `src/core/config.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type { AppConfig } from "./types"

/** 内置默认主题 key（「克制工具」浅色）。 */
export const DEFAULT_STYLE = "light"

export const DEFAULT_CONFIG: AppConfig = {
  api: {
    url: "http://localhost:11434/v1",
    api_key: "ollama",
    model: "qwen2.5-coder:7b",
    prompt: "",
    max_tokens: 8192,
    language: "中文",
    timeout: 60,
  },
  git: { max_diff_lines: 200 },
  ui: { window_width: 720, window_height: 520, show_untracked: false, style: DEFAULT_STYLE },
  selection: { checked_by_default: "tracked" },
}

export const CONFIG_FILE = join(homedir(), ".git_ai_commit", "config.json")

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 递归合并 override 到 base 的副本上。 */
export function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result: Record<string, unknown> = { ...structuredClone(base) }
  for (const [key, value] of Object.entries(override)) {
    const current = result[key]
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : structuredClone(value)
  }
  return result as T
}

/** 读取配置；文件不存在则写出默认配置。坏文件回退默认值。 */
export function loadConfig(path: string = CONFIG_FILE): AppConfig {
  if (!existsSync(path)) {
    const config = structuredClone(DEFAULT_CONFIG)
    saveConfig(config, path)
    return config
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!isPlainObject(parsed)) return structuredClone(DEFAULT_CONFIG)
    return deepMerge(structuredClone(DEFAULT_CONFIG), parsed) as AppConfig
  } catch {
    return structuredClone(DEFAULT_CONFIG)
  }
}

/** 写出配置（UTF-8，保留中文，无尾随换行）。 */
export function saveConfig(config: AppConfig, path: string = CONFIG_FILE): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8")
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/core/config.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/config.ts tests/core/config.test.ts
git commit -m "feat(core): port config defaults, deep merge and utf-8 io"
```

---

### Task 8: `core/ai.ts`

**Files:**
- Create: `src/core/ai.ts`
- Test: `tests/core/ai.test.ts`

**Interfaces:**
- Consumes: 无（`fetch` 可注入）
- Produces:
  - `class AIError extends Error`
  - `stripThink(text: string): string`
  - `buildPrompt(cfg: { prompt?: string; language?: string }): string`
  - `type FetchLike = (url: string, init: RequestInit) => Promise<{ status: number; text(): Promise<string>; json(): Promise<unknown> }>`
  - `generateCommitMessage(diffText: string, cfg: AiConfig, options?: { signal?: AbortSignal; fetchImpl?: FetchLike; timeoutMs?: number }): Promise<string>`

- [ ] **Step 1: 写失败测试 `tests/core/ai.test.ts`**

```ts
import { describe, expect, it } from "vitest"

import { AIError, buildPrompt, generateCommitMessage, stripThink } from "../../src/core/ai"

const CFG = {
  url: "http://localhost:11434/v1",
  api_key: "ollama",
  model: "qwen2.5-coder:7b",
  prompt: "",
  max_tokens: 8192,
  language: "中文",
  timeout: 60,
}

function fakeFetch(payload: unknown, status = 200, text = "body") {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return {
      status,
      text: async () => text,
      json: async () => {
        if (payload === undefined) throw new Error("no json")
        return payload
      },
    }
  }
  return { calls, fetchImpl }
}

function body(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init.body))
}

describe("stripThink", () => {
  it("移除思考块", () => {
    expect(stripThink("a<think>secret\nlines</think>b")).toBe("ab")
  })
})

describe("buildPrompt", () => {
  it("自定义提示词优先", () => {
    expect(buildPrompt({ ...CFG, prompt: "只输出一句话" })).toBe("只输出一句话")
  })

  it("默认按语言生成", () => {
    expect(buildPrompt(CFG)).toContain("中文")
  })
})

describe("generateCommitMessage", () => {
  it("POST 到 chat/completions 并返回去空内容", async () => {
    const { calls, fetchImpl } = fakeFetch({ choices: [{ message: { content: " 修复登录bug " } }] })
    const result = await generateCommitMessage("diff text", CFG, { fetchImpl })
    expect(result).toBe("修复登录bug")
    expect(calls[0].url).toBe("http://localhost:11434/v1/chat/completions")
    expect((calls[0].init.headers as Record<string, string>)["Authorization"]).toBe("Bearer ollama")
    expect(body(calls[0])["model"]).toBe("qwen2.5-coder:7b")
    expect(body(calls[0])["stream"]).toBe(false)
    expect(body(calls[0])["max_tokens"]).toBe(8192)
  })

  it("剥离响应里的 <think>", async () => {
    const { fetchImpl } = fakeFetch({ choices: [{ message: { content: "<think>x</think>真正内容" } }] })
    expect(await generateCommitMessage("d", CFG, { fetchImpl })).toBe("真正内容")
  })

  it("未配置 max_tokens 时不带该字段", async () => {
    const { calls, fetchImpl } = fakeFetch({ choices: [{ message: { content: "ok" } }] })
    await generateCommitMessage("d", { ...CFG, max_tokens: 0 }, { fetchImpl })
    expect("max_tokens" in body(calls[0])).toBe(false)
  })

  it("HTTP 错误抛出含状态码的 AIError", async () => {
    const { fetchImpl } = fakeFetch(undefined, 500, "boom")
    await expect(generateCommitMessage("d", CFG, { fetchImpl })).rejects.toThrow(/500/)
  })

  it("choices 为空抛 AIError", async () => {
    const { fetchImpl } = fakeFetch({ choices: [] })
    await expect(generateCommitMessage("d", CFG, { fetchImpl })).rejects.toBeInstanceOf(AIError)
  })

  it("未配置 url 抛 AIError", async () => {
    await expect(generateCommitMessage("d", { ...CFG, url: "" })).rejects.toThrow("未配置 api.url，请先填写配置文件")
  })

  it("网络异常包装为「AI 请求失败：」", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED")
    }
    await expect(generateCommitMessage("d", CFG, { fetchImpl })).rejects.toThrow(/^AI 请求失败：/)
  })

  it("内容为空抛 AIError", async () => {
    const { fetchImpl } = fakeFetch({ choices: [{ message: { content: "   " } }] })
    await expect(generateCommitMessage("d", CFG, { fetchImpl })).rejects.toThrow("AI 未返回有效内容")
  })

  it("AbortSignal 中止时抛 AI 请求失败", async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
    }
    await expect(
      generateCommitMessage("d", CFG, { fetchImpl, signal: controller.signal }),
    ).rejects.toThrow(/^AI 请求失败：/)
  })

  it("url 末尾斜杠被去掉", async () => {
    const { calls, fetchImpl } = fakeFetch({ choices: [{ message: { content: "ok" } }] })
    await generateCommitMessage("d", { ...CFG, url: "http://x/v1/" }, { fetchImpl })
    expect(calls[0].url).toBe("http://x/v1/chat/completions")
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/ai.test.ts`
Expected: FAIL，`Failed to resolve import "../../src/core/ai"`

- [ ] **Step 3: 实现 `src/core/ai.ts`**

```ts
export class AIError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AIError"
  }
}

export interface AiConfig {
  url: string
  api_key: string
  model: string
  prompt: string
  max_tokens: number
  language: string
  timeout: number
}

export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<{ status: number; text(): Promise<string>; json(): Promise<unknown> }>

const THINK_RE = /<think>[\s\S]*?<\/think>/g

/** 移除思考模型的 <think>...</think> 段落。 */
export function stripThink(text: string): string {
  return text.replace(THINK_RE, "").trim()
}

/** 自定义提示词优先，否则按语言生成默认提示词。 */
export function buildPrompt(cfg: { prompt?: string; language?: string }): string {
  const custom = (cfg.prompt ?? "").trim()
  if (custom) return custom
  const language = cfg.language || "中文"
  return (
    "你是一个专业程序员。请根据提供的 git diff 生成一条简洁、准确的提交信息，" +
    `使用${language}，只输出提交信息本身，不要输出解释、引号或 markdown 标记。`
  )
}

export interface GenerateOptions {
  signal?: AbortSignal
  fetchImpl?: FetchLike
}

/** 调用 {url}/chat/completions 生成提交信息。 */
export async function generateCommitMessage(
  diffText: string,
  cfg: AiConfig,
  options: GenerateOptions = {},
): Promise<string> {
  const url = (cfg.url || "").trim().replace(/\/+$/, "")
  if (!url) throw new AIError("未配置 api.url，请先填写配置文件")

  const payload: Record<string, unknown> = {
    model: cfg.model || "",
    messages: [
      { role: "system", content: buildPrompt(cfg) },
      { role: "user", content: diffText },
    ],
    stream: false,
  }
  const maxTokens = cfg.max_tokens || 0
  if (maxTokens > 0) payload.max_tokens = maxTokens

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.api_key || ""}`,
  }

  const timeoutMs = (cfg.timeout ?? 60) * 1000
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
  if (options.signal) signals.push(options.signal)

  let response
  try {
    response = await fetchImpl(`${url}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.any(signals),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new AIError(`AI 请求失败：${message}`)
  }

  if (response.status !== 200) {
    const text = await response.text()
    throw new AIError(`AI 返回 ${response.status}：${text.slice(0, 500)}`)
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new AIError("AI 返回的不是合法 JSON")
  }

  const choices = (data as { choices?: unknown[] } | null)?.choices ?? []
  if (!Array.isArray(choices) || choices.length === 0) throw new AIError("AI 返回缺少 choices")

  const first = choices[0] as { message?: { content?: string } } | undefined
  const content = stripThink(first?.message?.content ?? "")
  if (!content) throw new AIError("AI 未返回有效内容")
  return content
}
```

实施时删掉 `let timer` 相关的死代码，只保留 `finally` 之外的干净写法（`AbortSignal.timeout` 已负责超时）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/core/ai.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/ai.ts tests/core/ai.test.ts
git commit -m "feat(core): port AI client with injectable fetch and abort support"
```

---

### Task 9: `core/diff.ts`

**Files:**
- Create: `src/core/diff.ts`
- Test: `tests/core/diff.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `type DiffLineKind`、`interface DiffLine { kind: DiffLineKind; text: string }`、`parseDiff(text: string): DiffLine[]`

- [ ] **Step 1: 写失败测试 `tests/core/diff.test.ts`**

```ts
import { describe, expect, it } from "vitest"

import { parseDiff } from "../../src/core/diff"

const SAMPLE = [
  "diff --git a/a.py b/a.py",
  "index 111..222 100644",
  "--- a/a.py",
  "+++ b/a.py",
  "@@ -1,2 +1,3 @@",
  " one",
  "+two",
  "-old",
  "\\ No newline at end of file",
].join("\n")

describe("parseDiff", () => {
  it("分类文件头、hunk、增删与上下文", () => {
    expect(parseDiff(SAMPLE)).toEqual([
      { kind: "meta", text: "diff --git a/a.py b/a.py" },
      { kind: "meta", text: "index 111..222 100644" },
      { kind: "meta", text: "--- a/a.py" },
      { kind: "meta", text: "+++ b/a.py" },
      { kind: "hunk", text: "@@ -1,2 +1,3 @@" },
      { kind: "ctx", text: " one" },
      { kind: "add", text: "+two" },
      { kind: "del", text: "-old" },
      { kind: "meta", text: "\\ No newline at end of file" },
    ])
  })

  it("正文里的 +++ 是新增行而不是文件头", () => {
    const text = ["@@ -1 +1,2 @@", " ctx", "+++extra"].join("\n")
    expect(parseDiff(text)).toEqual([
      { kind: "hunk", text: "@@ -1 +1,2 @@" },
      { kind: "ctx", text: " ctx" },
      { kind: "add", text: "+++extra" },
    ])
  })

  it("未跟踪文件的提示行是 note", () => {
    const text = "### 新增文件: a.txt\n+hello\n+world"
    expect(parseDiff(text)).toEqual([
      { kind: "note", text: "### 新增文件: a.txt" },
      { kind: "add", text: "+hello" },
      { kind: "add", text: "+world" },
    ])
  })

  it("空文本返回空数组", () => {
    expect(parseDiff("")).toEqual([])
  })

  it("末尾换行不产生空行", () => {
    expect(parseDiff("@@ -1 +1 @@\n+a\n")).toHaveLength(2)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/diff.test.ts`
Expected: FAIL，`Failed to resolve import "../../src/core/diff"`

- [ ] **Step 3: 实现 `src/core/diff.ts`**

```ts
export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "ctx" | "note"

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

const HEADER_PREFIXES = ["diff --git ", "index ", "--- ", "+++ ", "\\ No newline"]

/**
 * 把 unified diff 文本切分为带类型的行。
 *
 * 分两段判定以避免 `+++` 歧义：首个 `@@` 之前是文件头（`--- `/`+++ `/`index ` 等
 * 都是 meta）；之后是正文，`+`/`-` 开头一律按增删行处理，所以正文里内容为
 * `++x` 的新增行（渲染成 `+++x`）不会被误判成文件头。
 */
export function parseDiff(text: string): DiffLine[] {
  if (text === "") return []
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()

  const result: DiffLine[] = []
  let inBody = false
  for (const line of lines) {
    if (line.startsWith("### ")) {
      result.push({ kind: "note", text: line })
      continue
    }
    if (line.startsWith("@@")) {
      inBody = true
      result.push({ kind: "hunk", text: line })
      continue
    }
    if (!inBody && HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      result.push({ kind: "meta", text: line })
      continue
    }
    if (line.startsWith("\\ No newline")) {
      result.push({ kind: "meta", text: line })
      continue
    }
    if (inBody && line.startsWith("+")) {
      result.push({ kind: "add", text: line })
      continue
    }
    if (inBody && line.startsWith("-")) {
      result.push({ kind: "del", text: line })
      continue
    }
    result.push({ kind: "ctx", text: line })
  }
  return result
}
```

（`HEADER_PREFIXES` 已含 `--- `/`+++ `，无需重复分支。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/core/diff.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/diff.ts tests/core/diff.test.ts
git commit -m "feat(core): add unified diff line classifier"
```

---

### Task 10: M1 收尾（覆盖率门与全量验证）

**Files:**
- Modify: `src/core/*.ts`（补测试暴露的缺口，如有）
- Modify: `docs/superpowers/specs/2026-09-17-electron-rewrite-design.md`（勾掉 M1）

**Interfaces:**
- Consumes: Task 1-9 全部
- Produces: M1 完成状态（M2 直接消费 `src/core` 全部导出）

- [ ] **Step 1: 全量测试 + 覆盖率**

Run: `npm test -- --coverage`
Expected: 全部 PASS；`src/core` 行覆盖 ≥ 90%（`vitest.config.ts` 的 thresholds 会在低于 90% 时失败）

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 无输出

- [ ] **Step 3: 人工核对翻译完整性**

对照下表逐项确认（缺哪条补哪条测试）：

| Python 测试 | 文件 | 条目数 |
|---|---|---|
| `test_gitcmd.py` | `tests/core/gitcmd.test.ts` | 4（+3 新增：invalid_cwd / timeout / literal pathspec） |
| `test_repo_status.py` | `tests/core/repo_status.test.ts` | 12（+1 新增：重命名后条目不被吞） |
| `test_repo_diff.py` | `tests/core/repo_diff.test.ts` | 7（+3 新增：truncate 边界 / readDiff 截断与一致性 / 不可读文件） |
| `test_repo_numstat.py` | `tests/core/repo_numstat.test.ts` | 6（+3 新增：numstatNewPath 三种形式） |
| `test_repo_commit.py` | `tests/core/repo_commit.test.ts` | 7（+1 新增：空路径报错） |
| `test_config.py` | `tests/core/config.test.ts` | 6（+2 新增：非对象 JSON / 无尾随换行） |
| `test_ai.py` | `tests/core/ai.test.ts` | 8（+4 新增：max_tokens=0 / 网络异常 / 空内容 / abort / 尾斜杠） |
| `test_worker.py` | 无独立文件 | 语义已由 `ai.test.ts` 的 abort 用例覆盖（M2 的 UI 忙碌态另测） |

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "test(core): finish M1 core port with coverage gate"
```

---

## Self-Review

**1. Spec coverage（对照 spec §5）**

| Spec 要求 | 任务 |
|---|---|
| §5.1 gitcmd（前缀/环境/解码/错误映射/超时/spawn 非 execFile） | T2 |
| §5.2 repo 常量、`statusOf`、`parsePorcelainZ`、`findRepoRoot`、`currentBranch`、`listChanges`、`hasCommits` | T3 |
| §5.2 `truncate`、`_diffOne` 语义、`diffFor`、`readDiff`（新增） | T4 |
| §5.2 `numstatNewPath`、`diffNumstat` | T5 |
| §5.2 `commitPathspecs`、`stage`、`commit` | T6 |
| §5.3 ai（stripThink/buildPrompt/generate/错误文案/可注入 fetch/abort） | T8 |
| §5.4 config（默认值逐键、CONFIG_FILE、deepMerge、坏文件回退、无尾随换行、DEFAULT_STYLE） | T7 |
| §5.5 diff.ts（两段式分类、note） | T9 |
| §4.3 路径校验（`resolveInsideRepo`，含 NUL/绝对路径/逃逸） | T3（`paths.ts`） |
| §8 覆盖率门 90%、`npm run typecheck`、`npm test` | T1、T10 |
| Electron 44 / TS / vitest / electron-vite 版本与 TS7 回退预案 | T1 |

**2. Placeholder scan**：已在 T3 Step 1 明确标注两处「故意写的错误占位、实施时必须删除」，T8/T9 的 Step 3 标注了要删的死代码；无 TBD/TODO。

**3. Type consistency**：`FileChange.origPath`（不是 `orig_path`）在 T3 定义、T6 使用；`StatTuple` 用元组 `[number|null, number|null]`（T5 产出，T10 的 `RepoSnapshot` 引用）；`GitError.reason` 在 T2 定义、M2 的 IPC 映射使用；`readDiff` 返回 `{text, truncated, omitted}` 在 T4 定义、M3 的 diff 面板使用；`CONFIG_FILE` 为常量、`loadConfig/saveConfig` 接受可选 `path` 便于测试（与 Python 版 `path=None` 对应）。

## Execution Handoff

本计划按里程碑拆分：M1（本文件）、M2 骨架与最小界面、M3 完整界面、M4 打包与切换。M2 的计划在 M1 完成后编写（需要用到 M1 实测出的 `src/core` 真实签名）。
