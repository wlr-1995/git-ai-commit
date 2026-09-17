import type { FileChange } from "../shared/changes"

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

/** IPC 一律返回判别联合，不抛异常（Electron 对 Error 的序列化会丢字段）。 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: ErrorCode; message: string } }

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
