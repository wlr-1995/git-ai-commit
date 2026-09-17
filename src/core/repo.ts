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
 * 使用 -z（NUL 分隔）而非默认格式：默认格式会给含空格的路径加引号
 * （`"a b.txt"`），即使设置了 core.quotepath=false 也一样，会让路径与后续的
 * git add/commit 不匹配。-z 输出原始路径。
 *
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

/** 返回仓库根目录；不是仓库（含路径无效）则返回 null。 */
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
