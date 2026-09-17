import { ADDED, DELETED, MODIFIED, RENAMED, UNTRACKED, type FileChange } from "../shared/changes"

export type Busy = null | "refresh" | "generate" | "commit"

export type FilterKind = "all" | "none" | "added" | "deleted" | "modified"

export interface UiState {
  branch: string
  changes: FileChange[]
  stats: Record<string, [number | null, number | null]>
  checked: Set<string>
  message: string
  showUntracked: boolean
  checkedByDefault: string
  busy: Busy
  selectedPath: string | null
}

/** 按「显示未受版本控制的文件」开关过滤要显示的行。 */
export function visibleChanges(state: UiState): FileChange[] {
  if (state.showUntracked) return state.changes
  return state.changes.filter((change) => change.status !== UNTRACKED)
}

/** 默认勾选策略：tracked（默认）/ all / none。 */
export function defaultChecked(change: FileChange, policy: string): boolean {
  if (policy === "all") return true
  if (policy === "none") return false
  return change.status !== UNTRACKED
}

export function initialChecked(changes: FileChange[], policy: string): Set<string> {
  return new Set(changes.filter((change) => defaultChecked(change, policy)).map((change) => change.path))
}

/** 只统计可见行的勾选（被隐藏的行不参与提交）。 */
export function checkedPaths(state: UiState): string[] {
  const visible = new Set(visibleChanges(state).map((change) => change.path))
  return [...state.checked].filter((path) => visible.has(path))
}

export function summaryText(state: UiState): string {
  return `共 ${visibleChanges(state).length} 个变更 · 已选 ${checkedPaths(state).length}`
}

export function actionHint(state: UiState): string {
  const total = visibleChanges(state).length
  if (!total) return ""
  if (checkedPaths(state).length === 0) return "请先勾选要提交的文件"
  if (!state.message.trim()) return "请填写提交信息"
  return ""
}

export function commitEnabled(state: UiState): boolean {
  return checkedPaths(state).length > 0 && state.message.trim().length > 0 && state.busy === null
}

const FILTER_STATUS: Record<string, string[]> = {
  added: [ADDED],
  deleted: [DELETED],
  modified: [MODIFIED, RENAMED],
}

/** 过滤按钮：all/none 是全选/全不选；其余三个只累加勾选，不取消其它已勾选项。 */
export function applyFilter(state: UiState, kind: FilterKind): Set<string> {
  const visible = visibleChanges(state)
  if (kind === "all") return new Set(visible.map((change) => change.path))
  if (kind === "none") return new Set()
  const wanted = FILTER_STATUS[kind] ?? []
  const next = new Set(checkedPaths(state))
  for (const change of visible) {
    if (wanted.includes(change.status)) next.add(change.path)
  }
  return next
}
