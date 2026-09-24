import type { AiDelta, DiffView, ThemeInfo } from "../shared/ipc"

import { openSettingsDialog } from "./components/settings"
import { showMessageDialog } from "./components/error-dialog"
import { render, renderStream, type Elements } from "./render"
import { applyAiDelta, applyFilter, checkedPaths, initialChecked, type FilterKind, type UiState } from "./state"

const api = window.api

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`缺少元素 #${id}`)
  return node as T
}

const elements: Elements = {
  repoName: el("repo-name"),
  repoPath: el("repo-path"),
  branch: el("branch"),
  message: el<HTMLTextAreaElement>("message"),
  thinking: el<HTMLDetailsElement>("thinking"),
  thinkingBody: el("thinking-body"),
  tbody: el("changes-body") as HTMLTableSectionElement,
  empty: el("empty-state"),
  hint: el("action-hint"),
  status: el("status"),
  btnCommit: el<HTMLButtonElement>("btn-commit"),
  btnGenerate: el<HTMLButtonElement>("btn-generate"),
  btnCancel: el<HTMLButtonElement>("btn-cancel"),
  showUntracked: el<HTMLInputElement>("show-untracked"),
  diffTitle: el("diff-title"),
  diffBody: el("diff-body"),
  diffEmpty: el("diff-empty"),
  diffPanel: el("diff-panel"),
}

const state: UiState = {
  branch: "未知",
  changes: [],
  stats: {},
  checked: new Set(),
  message: "",
  thinking: "",
  showUntracked: false,
  checkedByDefault: "tracked",
  busy: null,
  selectedPath: null,
}

let diff: DiffView | null = null
let repoPath = ""
let diffRequest = 0
let themes: ThemeInfo[] = []
let streamStarted = false
let generationRun = 0

function repoName(): string {
  const parts = repoPath.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? repoPath
}

function paint(): void {
  render(state, elements, {
    repoName: repoName(),
    repoPath,
    diff,
    onToggle: (path, checked) => {
      if (checked) state.checked.add(path)
      else state.checked.delete(path)
      paint()
    },
    onSelect: (path) => {
      state.selectedPath = path
      elements.diffPanel.classList.add("diff-open")
      paint()
      void loadDiff(path)
    },
    onOpenInWinMerge: (path) => void openInWinMerge(path),
  })
}

function setStatus(text: string): void {
  elements.status.textContent = text
}

function showError(message: string): void {
  setStatus(`错误：${message}`)
  showMessageDialog({ title: "AI 提交", message, detail: message, tone: "error" })
}

function showInfo(message: string): void {
  showMessageDialog({ title: "AI 提交", message, tone: "info" })
}

function applyTheme(key: string): void {
  const theme = themes.find((item) => item.key === key) ?? themes[0]
  const live = document.getElementById("theme-live")
  if (!theme || theme.key === "light" || !theme.css) {
    live?.remove()
    return
  }
  const style = (live as HTMLStyleElement | null) ?? document.createElement("style")
  style.id = "theme-live"
  style.textContent = theme.css
  if (!live) document.head.append(style)
}

async function loadDiff(path: string): Promise<void> {
  const request = ++diffRequest
  const result = await api.diffRead(path)
  if (request !== diffRequest) return
  if (result.ok) {
    diff = result.value
  } else {
    diff = null
    showError(result.error.message)
  }
  paint()
}

async function openInWinMerge(path: string): Promise<void> {
  const result = await api.winmergeOpen(path)
  if (!result.ok) showError(result.error.message)
}

async function refresh(): Promise<void> {
  if (state.busy !== null) return
  state.busy = "refresh"
  paint()
  const result = await api.repoLoad()
  state.busy = null
  if (result.ok) {
    repoPath = result.value.repoRoot
    state.branch = result.value.branch
    state.changes = result.value.changes
    state.stats = result.value.stats
    state.checked = initialChecked(result.value.changes, state.checkedByDefault)
    state.selectedPath = null
    diff = null
    state.thinking = "" // 刷新=新上下文，上一轮的思考不再适用
    if (result.value.changes.length === 0) state.message = ""
  } else {
    state.changes = []
    state.stats = {}
    state.checked = new Set()
    showError(`读取变更失败：${result.error.message}`)
  }
  paint()
}

async function submit(): Promise<void> {
  if (state.busy !== null) return
  state.busy = "commit"
  paint()
  const result = await api.commit({ paths: checkedPaths(state), message: state.message.trim() })
  state.busy = null
  if (!result.ok) {
    paint()
    showError(result.error.message)
    return
  }
  state.message = ""
  await refresh()
  showInfo("提交成功")
  setStatus("提交成功")
}

async function generate(): Promise<void> {
  if (state.busy !== null) return
  const paths = checkedPaths(state)
  if (paths.length === 0) {
    showError("请先勾选至少一个文件")
    return
  }
  const run = ++generationRun
  state.busy = "generate"
  state.thinking = ""
  streamStarted = false
  paint()
  const result = await api.aiGenerate(paths)
  if (run !== generationRun) return // 已被后一轮取代：本轮结果作废，别再动 busy/界面
  state.busy = null
  if (result.ok) {
    // 以核心返回的最终文本为准（与流式累积一致，顺便对齐首尾空白）
    state.message = result.value.message
    // 思考也以回执为准：非流式 JSON 的增量可能晚于回执到达而被 busy 门丢弃，这里兜底
    state.thinking = result.value.thinking
    paint()
    setStatus(result.value.truncated ? "已生成（输出被 max_tokens 截断）" : "已生成，可编辑后提交")
  } else if (result.error.code === "AI_CANCELLED") {
    paint()
    setStatus("已取消（已保留已收到内容）")
  } else {
    paint()
    showError(result.error.message)
  }
}

function applyDelta(delta: AiDelta): void {
  if (state.busy !== "generate") return
  if (delta.kind === "text" && !streamStarted) {
    // 第一段正文到达才丢弃草稿：这样「生成失败不清空已写内容」的承诺仍然成立
    streamStarted = true
    state.message = ""
  }
  const next = applyAiDelta(state, delta)
  state.thinking = next.thinking
  state.message = next.message
  renderStream(state, elements)
}

async function cancelGeneration(): Promise<void> {
  if (state.busy !== "generate") return
  await api.aiCancel()
  state.busy = null
  paint()
  setStatus("已取消")
}

async function openSettings(): Promise<void> {
  const config = await api.configGet()
  if (!config.ok) {
    showError(config.error.message)
    return
  }
  openSettingsDialog({
    config: {
      api: {
        url: config.value.api.url,
        model: config.value.api.model,
        api_key: config.value.api.api_key,
        timeout: config.value.api.timeout,
        enable_thinking: config.value.api.enable_thinking,
      },
      ui: { style: config.value.ui.style },
      tools: { winmerge_path: config.value.tools.winmerge_path },
    },
    themes,
    onPreview: (key) => applyTheme(key),
    onSave: async (values) => {
      const saved = await api.configSave(values)
      if (!saved.ok) return `保存失败：${saved.error.message}`
      state.showUntracked = saved.value.ui.show_untracked
      state.checkedByDefault = saved.value.selection.checked_by_default
      applyTheme(saved.value.ui.style)
      paint()
      setStatus("设置已保存")
      return null
    },
  })
}

function bindTableShortcuts(): void {
  const wrap = el("table-wrap")
  wrap.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement
    if (target instanceof HTMLInputElement && target.type === "checkbox") return
    if (event.key === "a" || event.key === "A") {
      state.checked = applyFilter(state, "all")
      paint()
    } else if (event.key === "n" || event.key === "N") {
      state.checked = applyFilter(state, "none")
      paint()
    } else if (event.key === "u" || event.key === "U") {
      elements.showUntracked.checked = !elements.showUntracked.checked
      state.showUntracked = elements.showUntracked.checked
      paint()
    }
  })
}

function bindSplitter(): void {
  const splitter = el("splitter")
  const body = document.querySelector<HTMLElement>(".app-body")
  if (!body) return
  let dragging = false

  const move = (event: PointerEvent): void => {
    if (!dragging) return
    const left = Math.round(event.clientX - body.getBoundingClientRect().left)
    const max = Math.round(window.innerWidth * 0.6)
    const width = Math.max(420, Math.min(max, left))
    document.documentElement.style.setProperty("--left-column-width", `${width}px`)
  }

  splitter.addEventListener("pointerdown", (event) => {
    dragging = true
    splitter.setPointerCapture(event.pointerId)
  })
  splitter.addEventListener("pointermove", move)
  splitter.addEventListener("pointerup", () => {
    dragging = false
  })
}

function bindNarrowMode(): void {
  const query = window.matchMedia("(max-width: 760px)")
  const app = el("app")
  const sync = (): void => {
    app.classList.toggle("narrow", query.matches)
    if (!query.matches) elements.diffPanel.classList.remove("diff-open")
  }
  query.addEventListener("change", sync)
  sync()
}

function bind(): void {
  api.onAiDelta(applyDelta)
  elements.message.addEventListener("input", () => {
    state.message = elements.message.value
    paint()
  })
  elements.showUntracked.addEventListener("change", () => {
    state.showUntracked = elements.showUntracked.checked
    paint()
  })
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-filter]")) {
    button.addEventListener("click", () => {
      state.checked = applyFilter(state, (button.dataset.filter ?? "all") as FilterKind)
      paint()
    })
  }
  elements.btnCommit.addEventListener("click", () => void submit())
  elements.btnGenerate.addEventListener("click", () => void generate())
  elements.btnCancel.addEventListener("click", () => void cancelGeneration())
  el("btn-settings").addEventListener("click", () => void openSettings())

  document.addEventListener("keydown", (event) => {
    if (event.key === "F5") {
      event.preventDefault()
      void refresh()
    } else if (event.ctrlKey && event.key === ",") {
      // 设置已弱化为顶栏图标，用系统习惯快捷键补齐可达性；已有弹层时不叠加
      event.preventDefault()
      if (!document.querySelector(".modal-backdrop")) void openSettings()
    } else if (event.key === "Escape") {
      elements.diffPanel.classList.remove("diff-open")
    }
  })

  bindTableShortcuts()
  bindSplitter()
  bindNarrowMode()
}

async function start(): Promise<void> {
  const listed = await api.themesList()
  if (listed.ok) themes = listed.value
  const config = await api.configGet()
  if (config.ok) {
    state.showUntracked = config.value.ui.show_untracked
    state.checkedByDefault = config.value.selection.checked_by_default
    applyTheme(config.value.ui.style)
  }
  bind()
  await refresh()
}

void start()
