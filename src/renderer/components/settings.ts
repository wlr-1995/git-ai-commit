import type { ThemeInfo } from "../../shared/ipc"

export interface SettingsValues {
  url: string
  model: string
  apiKey: string
  timeout: number
  style: string
  winmergePath: string
  enableThinking: boolean
}

/** 只组装要落盘的键：api 五键 + ui.style + tools（其余配置由主进程 deepMerge 保留）。 */
export function buildSettingsValues(input: SettingsValues): Record<string, unknown> {
  return {
    api: {
      url: input.url,
      model: input.model,
      api_key: input.apiKey,
      timeout: input.timeout,
      enable_thinking: input.enableThinking,
    },
    ui: { style: input.style },
    tools: { winmerge_path: input.winmergePath.trim() },
  }
}

export function parseTimeout(raw: string, fallback = 60): number {
  const value = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(value)) return fallback
  return Math.min(600, Math.max(1, value))
}

export interface SettingsDialogHandles {
  root: HTMLElement
  close: () => void
}

export interface SettingsDialogOptions {
  config: {
    api: { url: string; model: string; api_key: string; timeout: number; enable_thinking: boolean }
    ui: { style: string }
    tools: { winmerge_path: string }
  }
  themes: ThemeInfo[]
  onPreview: (key: string) => void
  onSave: (values: Record<string, unknown>) => Promise<string | null>
}

const ESCAPE_HTML = /[&<>"']/g

function escapeHtml(text: string): string {
  return text.replace(ESCAPE_HTML, (char) => {
    switch (char) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      default:
        return "&#39;"
    }
  })
}

/** 设置弹层：主题下拉即时预览，保存失败保持打开并保留输入。 */
export function openSettingsDialog(options: SettingsDialogOptions): SettingsDialogHandles {
  const originalStyle = options.config.ui.style
  const backdrop = document.createElement("div")
  backdrop.className = "modal-backdrop"
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="设置">
      <h2>设置</h2>
      <div class="group">
        <div class="group-title">外观</div>
        <div class="field">
          <label for="style">样式</label>
          <select id="style">
            ${options.themes
              .map((theme) => `<option value="${escapeHtml(theme.key)}">${escapeHtml(theme.label)}</option>`)
              .join("")}
          </select>
        </div>
      </div>
      <div class="group">
        <div class="group-title">工具</div>
        <div class="field">
          <label for="winmerge-path">WinMerge 路径</label>
          <input id="winmerge-path" type="text" placeholder="留空自动查找，如 C:\\Program Files\\WinMerge\\WinMergeU.exe"
                 value="${escapeHtml(options.config.tools.winmerge_path)}" />
        </div>
      </div>
      <div class="group">
        <div class="group-title">模型</div>
        <div class="field">
          <label for="api-url">接口地址</label>
          <input id="api-url" type="text" value="${escapeHtml(options.config.api.url)}" />
        </div>
        <div class="field">
          <label for="api-model">模型名</label>
          <input id="api-model" type="text" value="${escapeHtml(options.config.api.model)}" />
        </div>
        <div class="field">
          <label for="api-key">API Key</label>
          <input id="api-key" type="password" value="${escapeHtml(options.config.api.api_key)}" />
        </div>
        <div class="field">
          <label for="timeout">超时（秒）</label>
          <input id="timeout" type="number" min="1" max="600" value="${options.config.api.timeout}" />
        </div>
        <div class="field field-control">
          <input id="enable-thinking" type="checkbox" ${options.config.api.enable_thinking ? "checked" : ""} />
          <label for="enable-thinking">启用思考模式（发送 enable_thinking）</label>
        </div>
        <div class="validation" id="settings-validation"></div>
      </div>
      <div class="modal-actions">
        <button id="settings-cancel">取消</button>
        <button id="settings-save" class="primary">保存</button>
      </div>
    </div>
  `
  document.body.append(backdrop)

  const styleSelect = backdrop.querySelector<HTMLSelectElement>("#style")!
  const urlInput = backdrop.querySelector<HTMLInputElement>("#api-url")!
  const modelInput = backdrop.querySelector<HTMLInputElement>("#api-model")!
  const keyInput = backdrop.querySelector<HTMLInputElement>("#api-key")!
  const timeoutInput = backdrop.querySelector<HTMLInputElement>("#timeout")!
  const winmergeInput = backdrop.querySelector<HTMLInputElement>("#winmerge-path")!
  const thinkingInput = backdrop.querySelector<HTMLInputElement>("#enable-thinking")!
  const saveButton = backdrop.querySelector<HTMLButtonElement>("#settings-save")!
  const validation = backdrop.querySelector<HTMLElement>("#settings-validation")!

  styleSelect.value = options.themes.some((theme) => theme.key === originalStyle)
    ? originalStyle
    : (options.themes[0]?.key ?? originalStyle)

  const close = (): void => {
    document.removeEventListener("keydown", onKeydown)
    backdrop.remove()
  }

  const currentValues = (): Record<string, unknown> =>
    buildSettingsValues({
      url: urlInput.value.trim(),
      model: modelInput.value.trim(),
      apiKey: keyInput.value,
      timeout: parseTimeout(timeoutInput.value),
      style: styleSelect.value,
      winmergePath: winmergeInput.value,
      enableThinking: thinkingInput.checked,
    })

  const validate = (): boolean => {
    const urlMissing = urlInput.value.trim() === ""
    saveButton.disabled = urlMissing
    validation.textContent = urlMissing ? "接口地址不能为空" : ""
    return !urlMissing
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault()
      onCancel()
    }
  }

  function onCancel(): void {
    options.onPreview(originalStyle)
    close()
  }

  styleSelect.addEventListener("change", () => options.onPreview(styleSelect.value))
  urlInput.addEventListener("input", validate)
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) onCancel()
  })
  backdrop.querySelector("#settings-cancel")!.addEventListener("click", onCancel)
  saveButton.addEventListener("click", () => {
    if (!validate()) return
    void (async () => {
      saveButton.disabled = true
      const error = await options.onSave(currentValues())
      saveButton.disabled = false
      if (error) {
        validation.textContent = error
        return
      }
      close()
    })()
  })

  document.addEventListener("keydown", onKeydown)
  validate()
  return { root: backdrop, close }
}
