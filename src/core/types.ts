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
