/**
 * 变更状态常量与文案。
 *
 * 放在 shared 而不是 core/repo：渲染层需要这些**值**（状态中文名、默认勾选策略），
 * 而 core/repo 依赖 gitcmd（node:child_process），渲染层不能碰。
 */

export const MODIFIED = "modified"
export const ADDED = "added"
export const DELETED = "deleted"
export const RENAMED = "renamed"
export const UNTRACKED = "untracked"
export const CONFLICTED = "conflicted"

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
