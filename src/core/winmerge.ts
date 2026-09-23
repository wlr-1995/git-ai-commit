import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
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
  registryInstallLocations(run?: RegRunner): string[]
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
