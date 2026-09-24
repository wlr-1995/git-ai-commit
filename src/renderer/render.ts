import { STATUS_TEXT } from "../shared/changes"
import type { DiffView } from "../shared/ipc"
import { actionHint, checkedPaths, commitEnabled, summaryText, visibleChanges, type UiState } from "./state"

export interface Elements {
  repoName: HTMLElement
  repoPath: HTMLElement
  branch: HTMLElement
  message: HTMLTextAreaElement
  thinking: HTMLDetailsElement
  thinkingBody: HTMLElement
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
  onOpenInWinMerge: (path: string) => void
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
  document.title = `${ctx.repoName} — AI 提交`
  elements.repoName.textContent = ctx.repoName
  elements.repoName.title = ctx.repoPath
  elements.repoPath.textContent = ctx.repoPath
  elements.repoPath.title = ctx.repoPath
  elements.branch.textContent = state.branch
  elements.branch.title = `当前分支：${state.branch}`

  if (elements.message.value !== state.message) elements.message.value = state.message
  // 生成期间输入框只读：正文是流式写入的，别让 paint 冲掉用户正在打的字
  elements.message.readOnly = state.busy === "generate"
  renderThinking(state, elements)
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
      // 双击 = 用 WinMerge 对比（点勾选框不算，否则会和勾选打架）
      row.addEventListener("dblclick", (event) => {
        if (event.target === box) return
        ctx.onOpenInWinMerge(change.path)
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

/**
 * 流式增量只更新会变的那几处：每个 token 都走整树重绘（表格 + diff 重建）会白烧 DOM。
 * 这里刻意不碰 #status（生成中要保持「正在生成…」）与表格/diff。
 */
export function renderStream(state: UiState, elements: Elements): void {
  if (elements.message.value !== state.message) elements.message.value = state.message
  elements.message.readOnly = state.busy === "generate"
  renderThinking(state, elements)
  elements.hint.textContent = actionHint(state)
  elements.btnCommit.disabled = !commitEnabled(state)
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

function renderThinking(state: UiState, elements: Elements): void {
  const details = elements.thinking
  const body = elements.thinkingBody
  const wasHidden = details.hidden
  details.hidden = state.thinking === ""
  if (state.thinking === "") return

  // 用户翻到上面看的时候别把他拽回底部
  const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 24
  if (body.textContent !== state.thinking) body.textContent = state.thinking

  if (wasHidden) {
    // 思考第一次出现时展开（之后尊重用户手动收起）
    details.open = true
    body.scrollTop = body.scrollHeight
  } else if (state.busy === "generate" && stick) {
    body.scrollTop = body.scrollHeight
  }
}
