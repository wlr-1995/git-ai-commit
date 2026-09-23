import { join } from "node:path"

import { ipcMain, type BrowserWindow } from "electron"

import { AIError, generateCommitMessage } from "../core/ai"
import { deepMerge, loadConfig, saveConfig } from "../core/config"
import { parseDiff } from "../core/diff"
import { toError } from "../core/errors"
import { GitError } from "../core/gitcmd"
import { PathError, resolveInsideRepo } from "../core/paths"
import {
  commit,
  commitPathspecs,
  currentBranch,
  diffFor,
  diffNumstat,
  listChanges,
  readDiff,
  stage,
} from "../core/repo"
import type { ErrorCode, Result } from "../core/types"
import {
  WinMergeError,
  comparePlan,
  detectWinMerge,
  launchWinMerge,
  notFoundMessage,
  prepareComparison,
  stageRoot,
} from "../core/winmerge"
import { CHANNELS, type CommitInput, type DiffView } from "../shared/ipc"
import { listThemes } from "./themes"

function fail(code: ErrorCode, message: string): { ok: false; error: { code: ErrorCode; message: string } } {
  return { ok: false, error: { code, message } }
}

async function guarded<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error: toError(error) }
  }
}

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === "string")
}

/** 同一时刻只允许一次 AI 生成；取消按钮中止它。 */
let generation: AbortController | null = null

/** 每次双击递增，保证临时目录互不覆盖 */
let winmergeSeq = 0

export function registerIpc(win: BrowserWindow, repoRoot: string): void {
  const handle = (channel: string, listener: (...args: unknown[]) => Promise<Result<unknown>>): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_event, ...args: unknown[]) => listener(...args))
  }

  handle(CHANNELS.repoLoad, () =>
    guarded(async () => ({
      repoRoot,
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
      return {
        path: rawPath,
        lines: parseDiff(result.text),
        truncated: result.truncated,
        omitted: result.omitted,
      }
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

  handle(CHANNELS.commit, (raw): Promise<Result<{ stdout: string }>> => {
    const input = raw as CommitInput
    const paths = toStringArray(input?.paths)
    const message = typeof input?.message === "string" ? input.message.trim() : ""
    if (paths.length === 0) return Promise.resolve(fail("NO_SELECTION", "请先勾选至少一个文件"))
    if (!message) return Promise.resolve(fail("EMPTY_MESSAGE", "提交信息不能为空"))
    return guarded(async () => {
      // 重命名要带上旧路径，否则旧路径的删除会遗留在暂存区
      const changes = (await listChanges(repoRoot)).filter((change) => paths.includes(change.path))
      await stage(repoRoot, paths)
      return { stdout: await commit(repoRoot, message, commitPathspecs(changes)) }
    })
  })

  handle(CHANNELS.configGet, () => guarded(async () => loadConfig()))

  handle(CHANNELS.configSave, (rawPartial) =>
    guarded(async () => {
      const partial = (rawPartial ?? {}) as Record<string, unknown>
      saveConfig(deepMerge(loadConfig(), partial))
      return loadConfig()
    }),
  )

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

  handle(CHANNELS.themesList, () => guarded(async () => listThemes()))

  win.on("closed", () => {
    for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler(channel)
  })
}
