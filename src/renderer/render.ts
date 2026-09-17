import { STATUS_TEXT } from "../shared/changes"
import type { DiffView } from "../shared/ipc"
import { actionHint, checkedPaths, commitEnabled, summaryText, visibleChanges, type UiState } from "./state"

export interface Elements {
  repoName: HTMLElement
  repoPath: HTMLElement
  branch: HTMLElement
  message: HTMLTextAreaElement
  tbody: HTMLTableSectionElement
  empty: HTMLElement
  hint: HTMLElement
  status: HTMLElement
  btnCommit: HTMLButtonElement
  btnGenerate: HTMLButtonElement
  btnCancel: HTMLButtonElement
  showUntracked: HTMLInputElement
  diffTitle: HTMLElement
  diffBody: HTMLElement
  diffEmpty: HTMLElement
  diffPanel: HTMLElement
}

export interface RenderContext {
  repoName: string
  repoPath: string
  diff: DiffView | null
  onToggle: (path: string, checked: boolean) => void
  onSelect: (path: string) => void
}

const NUMBER = new Intl.NumberFormat("zh-CN")

function statText(value: number | null | undefined, has: boolean): string {
  if (!has) return ""
  return value === null || value === undefined ? "-" : NUMBER.format(value)
}

function suffixOf(path: string): string {
  const index = path.lastIndexOf(".")
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return index > slash ? path.slice(index) : ""
}

export function render(state: UiState, elements: Elements, ctx: RenderContext): void {
  elements.repoName.textContent = ctx.repoName
  elements.repoName.title = ctx.repoPath
  elements.repoPath.textContent = ctx.repoPath
  elements.repoPath.title = ctx.repoPath
  elements.branch.textContent = state.branch
  elements.branch.title = `当前分支：${state.branch}`

  if (elements.message.value !== state.message) elements.message.value = state.message
  elements.showUntracked.checked = state.showUntracked

  const visible = visibleChanges(state)
  elements.tbody.replaceChildren(
    ...visible.map((change) => {
      const row = document.createElement("tr")
      row.dataset.path = change.path
      row.setAttribute("aria-selected", String(state.selectedPath === change.path))

      const cell = document.createElement("td")
      cell.className = "path-cell"
      const box = document.createElement("input")
      box.type = "checkbox"
      box.checked = state.checked.has(change.path)
      box.setAttribute("aria-label", `选择 ${change.path}`)
      box.addEventListener("change", () => ctx.onToggle(change.path, box.checked))
      const label = document.createElement("span")
      label.className = "path-text"
      label.textContent = change.path
      label.title = change.origPath ? `${change.origPath} → ${change.path}` : change.path
      cell.append(box, label)
      // 整行可点：点行 = 选中并看 diff（点勾选框本身不算，见上）
      row.addEventListener("click", (event) => {
        if (event.target === box) return
        ctx.onSelect(change.path)
      })
      row.append(cell)

      const suffix = document.createElement("td")
      suffix.className = "suffix"
      suffix.textContent = suffixOf(change.path)
      row.append(suffix)

      const status = document.createElement("td")
      status.className = `status status-${change.status}`
      status.textContent = STATUS_TEXT[change.status] ?? change.status
      row.append(status)

      const has = Object.prototype.hasOwnProperty.call(state.stats, change.path)
      const [added, deleted] = state.stats[change.path] ?? [null, null]
      const addedCell = document.createElement("td")
      addedCell.className = "num"
      addedCell.textContent = statText(added, has)
      const deletedCell = document.createElement("td")
      deletedCell.className = "num"
      deletedCell.textContent = statText(deleted, has)
      row.append(addedCell, deletedCell)
      return row
    }),
  )

  elements.empty.hidden = visible.length > 0
  if (visible.length === 0) {
    elements.empty.textContent =
      state.changes.length === 0
        ? "工作区干净\n没有需要提交的改动"
        : "未显示任何文件\n可勾选「显示未受版本控制的文件」后再看"
  }

  renderDiff(state, elements, ctx)

  elements.hint.textContent = actionHint(state)
  elements.btnCommit.disabled = !commitEnabled(state)
  elements.btnCommit.title = actionHint(state)
  elements.btnGenerate.disabled = state.busy !== null
  elements.btnCancel.disabled = state.busy !== "generate"

  if (state.busy === null) {
    elements.status.textContent = summaryText(state)
  } else {
    elements.status.textContent =
      state.busy === "generate" ? "正在生成…" : state.busy === "commit" ? "正在提交…" : "正在读取变更…"
  }
}

function renderDiff(state: UiState, elements: Elements, ctx: RenderContext): void {
  const diff = ctx.diff
  const hasDiff = Boolean(diff && state.selectedPath)
  elements.diffEmpty.hidden = hasDiff
  elements.diffBody.hidden = !hasDiff
  elements.diffTitle.hidden = !hasDiff
  if (!hasDiff || !diff) return

  elements.diffTitle.textContent = diff.truncated
    ? `${diff.path}（已截断，省略 ${diff.omitted} 行）`
    : diff.path

  let oldLine = 0
  let newLine = 0
  elements.diffBody.replaceChildren(
    ...diff.lines.map((line) => {
      const row = document.createElement("div")
      row.className = `diff-line ${line.kind}`
      const nums = document.createElement("span")
      nums.className = "diff-nums"
      if (line.kind === "del") {
        oldLine += 1
        nums.textContent = `${oldLine}`
      } else if (line.kind === "add") {
        newLine += 1
        nums.textContent = `${newLine}`
      } else if (line.kind === "ctx") {
        oldLine += 1
        newLine += 1
        nums.textContent = `${oldLine}`
      } else if (line.kind === "hunk") {
        const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line.text)
        if (match) {
          oldLine = Number(match[1]) - 1
          newLine = Number(match[2]) - 1
        }
      }
      const text = document.createElement("span")
      text.className = "diff-text"
      text.textContent = line.text === "" ? " " : line.text
      row.append(nums, text)
      return row
    }),
  )
}
