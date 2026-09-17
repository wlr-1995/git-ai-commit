import { open } from "node:fs/promises"
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

/** 按 \r\n / \r / \n 切分；输入以换行结尾时丢弃末尾空串（对齐 Python splitlines 的可观察行为）。 */
function splitLines(text: string): string[] {
  if (text === "") return []
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/** 超过 maxLines 时保留前 maxLines 行并标注省略数。 */
export function truncate(text: string, maxLines: number): string {
  if (maxLines <= 0) return text
  const lines = splitLines(text)
  if (lines.length <= maxLines) return text
  const omitted = lines.length - maxLines
  return `${lines.slice(0, maxLines).join("\n")}\n... (已截断，省略 ${omitted} 行)`
}

/**
 * 单路径 diff：先试已跟踪的 diff，再退回「未跟踪文件」的内容预览。
 *
 * 读取时只读上限 +1 字节：既避免超大文件整体读入内存，也用于判断是否超限。
 */
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
    const body = splitLines(data.toString("utf8"))
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
  for (const path of paths) {
    const section = await diffOne(repoRoot, path)
    if (section) sections.push(section)
  }
  return truncate(sections.join("\n"), maxLines)
}

/**
 * 单路径 diff 的读取接口（diff 面板用）。
 *
 * 与 `diffFor` 共用同一条 `diffOne` 路径与同一套省略语义，只是把「是否截断、
 * 省略多少行」显式返回，而不是塞进文本里让渲染层去猜。
 */
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

function splitOnce(text: string, separator: string): [string, string] {
  const index = text.indexOf(separator)
  if (index < 0) return [text, ""]
  return [text.slice(0, index), text.slice(index + separator.length)]
}

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

/**
 * 返回 { 路径: [添加行数, 删除行数] }，键为重命名后的新路径。
 *
 * - 只覆盖已跟踪的变更；未跟踪文件不在结果里（调用方留空即可）。
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
