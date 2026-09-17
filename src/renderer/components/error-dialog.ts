const SUMMARY_LIMIT = 120

/** 错误摘要：首行 + 120 字符截断（对齐 Qt 版的 _error_summary）。 */
export function errorSummary(message: string): string {
  const firstLine = (message ?? "").split(/\r?\n/)[0]?.trim() ?? ""
  if (!firstLine) return "发生未知错误"
  return firstLine.length <= SUMMARY_LIMIT ? firstLine : `${firstLine.slice(0, SUMMARY_LIMIT)}…`
}

export interface MessageDialogOptions {
  title: string
  message: string
  detail?: string
  tone?: "error" | "info"
}

let closeCurrent: (() => void) | null = null

/** 错误/提示弹层：摘要 + 可展开完整信息，Esc 或按钮关闭。 */
export function showMessageDialog(options: MessageDialogOptions): void {
  closeCurrent?.()
  const backdrop = document.createElement("div")
  backdrop.className = "modal-backdrop"

  const dialog = document.createElement("div")
  dialog.className = "modal"
  dialog.setAttribute("role", "dialog")
  dialog.setAttribute("aria-modal", "true")
  dialog.setAttribute("aria-label", options.title)

  const heading = document.createElement("h2")
  heading.textContent = options.title
  dialog.append(heading)

  const body = document.createElement("p")
  body.id = "message-summary"
  body.textContent = errorSummary(options.message)
  dialog.append(body)

  if (options.detail) {
    const details = document.createElement("details")
    const summary = document.createElement("summary")
    summary.textContent = "详细信息"
    const pre = document.createElement("pre")
    pre.id = "message-detail"
    pre.textContent = options.detail
    details.append(summary, pre)
    dialog.append(details)
  }

  const actions = document.createElement("div")
  actions.className = "modal-actions"
  const closeButton = document.createElement("button")
  closeButton.id = "message-close"
  closeButton.className = options.tone === "info" ? "primary" : ""
  closeButton.textContent = "确定"
  actions.append(closeButton)
  dialog.append(actions)
  backdrop.append(dialog)
  document.body.append(backdrop)

  const close = (): void => {
    document.removeEventListener("keydown", onKeydown)
    backdrop.remove()
    closeCurrent = null
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault()
      close()
    }
  }

  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close()
  })
  closeButton.addEventListener("click", close)
  document.addEventListener("keydown", onKeydown)
  closeCurrent = close
}
