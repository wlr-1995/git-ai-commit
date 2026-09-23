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
