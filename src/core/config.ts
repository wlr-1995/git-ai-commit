import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type { AppConfig } from "./types"

/** 内置默认主题 key（「克制工具」浅色）。 */
export const DEFAULT_STYLE = "light"

export const DEFAULT_CONFIG: AppConfig = {
  api: {
    url: "http://localhost:11434/v1",
    api_key: "ollama",
    model: "qwen2.5-coder:7b",
    prompt: "",
    max_tokens: 8192,
    language: "中文",
    timeout: 60,
  },
  git: { max_diff_lines: 200 },
  ui: { window_width: 1100, window_height: 640, show_untracked: false, style: DEFAULT_STYLE },
  selection: { checked_by_default: "tracked" },
}

// 正式运行固定用用户目录；GIT_AI_COMMIT_CONFIG 仅供端到端测试隔离使用。
export const CONFIG_FILE =
  process.env.GIT_AI_COMMIT_CONFIG ?? join(homedir(), ".git_ai_commit", "config.json")

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 递归合并 override 到 base 的副本上（不改动入参）。 */
export function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result: Record<string, unknown> = structuredClone(base)
  for (const [key, value] of Object.entries(override)) {
    const current = result[key]
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : structuredClone(value)
  }
  return result as T
}

/**
 * 旧 Python 版的默认开窗是 720×520；Electron 版左右分栏需要更宽（1100×640），
 * 否则默认就落进窄窗形态、右栏 diff 被折叠。
 *
 * 只在窗口尺寸**恰好等于旧默认值**时升级：用户自己改过的尺寸（哪怕更小）保持不动。
 */
function migrateLegacyDefaults(config: AppConfig): AppConfig {
  if (config.ui.window_width === 720 && config.ui.window_height === 520) {
    config.ui.window_width = DEFAULT_CONFIG.ui.window_width
    config.ui.window_height = DEFAULT_CONFIG.ui.window_height
  }
  return config
}

/** 读取配置；文件不存在则写出默认配置。坏文件回退默认值。 */
export function loadConfig(path: string = CONFIG_FILE): AppConfig {
  if (!existsSync(path)) {
    const config = structuredClone(DEFAULT_CONFIG)
    saveConfig(config, path)
    return config
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!isPlainObject(parsed)) return structuredClone(DEFAULT_CONFIG)
    return migrateLegacyDefaults(deepMerge(structuredClone(DEFAULT_CONFIG), parsed) as AppConfig)
  } catch {
    return structuredClone(DEFAULT_CONFIG)
  }
}

/** 写出配置（UTF-8，保留中文，无尾随换行）。 */
export function saveConfig(config: AppConfig, path: string = CONFIG_FILE): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8")
}
