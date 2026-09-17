import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

import { DEFAULT_STYLE } from "../core/config"
import type { ThemeInfo } from "../shared/ipc"

/** 外置主题目录：丢一个 .css 进去就是一个新主题（对应 Qt 版的 styles/*.qss）。 */
export const THEMES_DIR = join(homedir(), ".git_ai_commit", "themes")

export const BUILTIN_THEMES: ThemeInfo[] = [
  { key: DEFAULT_STYLE, label: "克制工具（浅色）", css: "" },
]

const LABEL_RE = /\/\*\s*名称:\s*(.+?)\s*\*\//

/** 内置主题 + `%USERPROFILE%\.git_ai_commit\themes\*.css`；外置同名 key 覆盖内置。 */
export function listThemes(): ThemeInfo[] {
  const themes = new Map(BUILTIN_THEMES.map((theme) => [theme.key, theme]))
  if (existsSync(THEMES_DIR)) {
    for (const name of readdirSync(THEMES_DIR)) {
      if (!name.toLowerCase().endsWith(".css")) continue
      const key = basename(name, ".css")
      if (key.startsWith("_") || key.startsWith(".")) continue
      try {
        const css = readFileSync(join(THEMES_DIR, name), "utf8")
        themes.set(key, { key, label: LABEL_RE.exec(css)?.[1] ?? key, css })
      } catch {
        // 单个主题读不了就跳过，不影响其它主题
      }
    }
  }
  return [...themes.values()]
}
