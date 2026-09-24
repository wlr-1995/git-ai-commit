import type { DiffLine } from "../core/diff"
import type { AiDelta, AppConfig, RepoSnapshot, Result } from "../core/types"

export type { AiDelta, Result }

export const CHANNELS = {
  repoLoad: "repo:load",
  diffRead: "diff:read",
  aiGenerate: "ai:generate",
  aiDelta: "ai:delta",
  aiCancel: "ai:cancel",
  commit: "commit",
  configGet: "config:get",
  configSave: "config:save",
  themesList: "themes:list",
  winmergeOpen: "winmerge:open",
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

/** preload 通过 contextBridge 暴露给渲染层的全部能力（白名单，无 Node）。 */
export interface IpcApi {
  repoLoad(): Promise<Result<RepoSnapshot>>
  diffRead(path: string): Promise<Result<DiffView>>
  aiGenerate(paths: string[]): Promise<Result<{ message: string; truncated: boolean; thinking: string }>>
  /** 主进程推来的流式增量；整程序只订阅一次，不提供取消订阅 */
  onAiDelta(cb: (delta: AiDelta) => void): void
  aiCancel(): Promise<Result<void>>
  commit(input: CommitInput): Promise<Result<{ stdout: string }>>
  configGet(): Promise<Result<AppConfig>>
  configSave(partial: Record<string, unknown>): Promise<Result<AppConfig>>
  themesList(): Promise<Result<ThemeInfo[]>>
  winmergeOpen(path: string): Promise<Result<void>>
}
