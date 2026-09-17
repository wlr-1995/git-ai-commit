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

/** git 运行环境：把 pathspec 当作字面量，文件名中的 * ? [ 不再被当作通配。 */
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

/**
 * 先自行校验工作目录。
 *
 * Windows 上「cwd 不存在」与「找不到 git」都会让 spawn 抛 ENOENT，无法区分；
 * 预先 stat 一次才能给出准确的错误文案（对齐 Python 版的 NotADirectoryError 分支）。
 */
function assertCwd(cwd: string | null | undefined): void {
  if (!cwd) return
  let isDirectory = false
  try {
    isDirectory = statSync(cwd).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) {
    throw new GitError(`工作目录无效（不存在或不是目录）: ${cwd}`, "invalid_cwd")
  }
}

/**
 * 执行 git 命令，返回 { code, stdout, stderr }。
 *
 * 用 spawn 而非 execFile：execFile 默认 maxBuffer 只有 1 MB，大仓库的
 * `status --porcelain -z` 会被截断；这里自行收集 chunk，不设上限。
 * stdout/stderr 先按字节收集、最后一次性解码，避免多字节字符跨 chunk 被截断。
 */
export async function runGit(args: string[], options: RunGitOptions = {}): Promise<GitResult> {
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
