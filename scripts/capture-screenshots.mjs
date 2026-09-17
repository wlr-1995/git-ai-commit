/**
 * 视觉验收截图：启动真实应用，抓「列表 + diff」「设置弹层」「错误弹层」三张图。
 *
 * 用法：npm run shots  （输出到 %TEMP%\electron-shots\）
 * 前置：npm run build（或用 npm run shots:build 一步到位）
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { _electron as electron } from "@playwright/test"

const OUT = join(process.env.TEMP ?? tmpdir(), "electron-shots")

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败: ${result.stderr}`)
  return result.stdout ?? ""
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gac-shot-"))
  git(dir, ["init", "-b", "main"])
  git(dir, ["config", "user.name", "t"])
  git(dir, ["config", "user.email", "t@example.com"])
  writeFileSync(join(dir, "README.md"), "# 示例项目\n\n第一行\n第二行\n", "utf8")
  writeFileSync(join(dir, "src-main.ts"), "export const a = 1\n", "utf8")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", "init"])
  writeFileSync(join(dir, "README.md"), "# 示例项目\n\n第一行\n第二行改过了\n新增一行\n", "utf8")
  writeFileSync(join(dir, "src-main.ts"), "export const a = 2\nexport const b = 3\n", "utf8")
  writeFileSync(join(dir, "新建文本文档.txt"), "第一次提交的内容\n", "utf8")
  return dir
}

function makeConfig() {
  const dir = mkdtempSync(join(tmpdir(), "gac-shot-cfg-"))
  const file = join(dir, "config.json")
  // 指向一个没有服务的端口，用于触发错误弹层
  writeFileSync(
    file,
    JSON.stringify({ api: { url: "http://127.0.0.1:9/v1", model: "demo" }, ui: { show_untracked: true } }),
    "utf8",
  )
  return file
}

mkdirSync(OUT, { recursive: true })
const repo = makeRepo()
const app = await electron.launch({
  args: [".", repo],
  env: { ...process.env, GIT_AI_COMMIT_CONFIG: makeConfig() },
})
const window = await app.firstWindow()
await window.waitForSelector("#changes-body tr")
await window.setViewportSize?.({ width: 1100, height: 640 }).catch(() => {})

// 1. 列表 + diff（选中 README.md 并勾选一个文件，展示勾选态与 diff）
await window.click("#message")
await window.fill("#message", "feat: 更新示例项目文档与入口")
await window.click('#changes-body tr[data-path="README.md"]')
await window.waitForSelector("#diff-body .diff-line.add")
await window.screenshot({ path: join(OUT, "1-list-diff.png") })

// 2. 设置弹层
await window.click("#btn-settings")
await window.waitForSelector("#settings-save")
await window.screenshot({ path: join(OUT, "2-settings.png") })
await window.keyboard.press("Escape")

// 3. 错误弹层（AI 接口不可达）
await window.click("#btn-generate")
await window.waitForSelector("#message-close", { timeout: 20_000 })
await window.screenshot({ path: join(OUT, "3-error.png") })

await app.close()
console.log(`截图输出目录: ${OUT}`)
