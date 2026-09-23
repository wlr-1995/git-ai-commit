import { AIError } from "./ai"
import { GitError } from "./gitcmd"
import { PathError } from "./paths"
import type { ErrorCode } from "./types"
import { WinMergeError } from "./winmerge"

/** core 的异常 → IPC 错误码。 */
export function toError(error: unknown): { code: ErrorCode; message: string } {
  if (error instanceof GitError) {
    if (error.reason === "not_found") return { code: "GIT_NOT_FOUND", message: error.message }
    if (error.reason === "timeout") return { code: "GIT_TIMEOUT", message: error.message }
    return { code: "GIT_FAILED", message: error.message }
  }
  if (error instanceof PathError) return { code: "PATH_OUTSIDE_REPO", message: error.message }
  if (error instanceof AIError) {
    if (error.message.includes("未配置 api.url")) return { code: "AI_NO_URL", message: error.message }
    if (/^AI 返回 \d+/.test(error.message)) return { code: "AI_HTTP", message: error.message }
    return { code: "AI_BAD_RESPONSE", message: error.message }
  }
  if (error instanceof WinMergeError) {
    if (error.reason === "not_found") return { code: "WINMERGE_NOT_FOUND", message: error.message }
    return { code: "WINMERGE_LAUNCH_FAILED", message: error.message }
  }
  return { code: "UNKNOWN", message: error instanceof Error ? error.message : String(error) }
}
