import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test"

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败: ${result.stderr}`)
  return result.stdout ?? ""
}

/** 造一个含「已修改 + 未跟踪」的临时仓库。 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gac-e2e-"))
  git(dir, ["init", "-b", "main"])
  git(dir, ["config", "user.name", "t"])
  git(dir, ["config", "user.email", "t@example.com"])
  writeFileSync(join(dir, "tracked.txt"), "v1\n", "utf8")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", "init"])
  writeFileSync(join(dir, "tracked.txt"), "v1\nv2\n", "utf8")
  writeFileSync(join(dir, "new.txt"), "hello\n", "utf8")
  return dir
}

function makeConfig(overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "gac-cfg-"))
  const file = join(dir, "config.json")
  writeFileSync(file, JSON.stringify(overrides), "utf8")
  return file
}

interface LaunchOptions {
  repo: string
  configFile?: string
  noDialog?: boolean
}

async function launchApp({ repo, configFile, noDialog }: LaunchOptions): Promise<ElectronApplication> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  if (configFile) env.GIT_AI_COMMIT_CONFIG = configFile
  if (noDialog) env.GIT_AI_COMMIT_NO_DIALOG = "1"
  return electron.launch({ args: [".", repo], env })
}

test("① 启动即列出变更与分支", async () => {
  const repo = makeRepo()
  const app = await launchApp({ repo, configFile: makeConfig() })
  const window = await app.firstWindow()

  await expect(window.locator("#changes-body tr")).toHaveCount(1)
  await expect(window.locator("#changes-body tr").first()).toHaveAttribute("data-path", "tracked.txt")
  await expect(window.locator("#branch")).toHaveText("main")
  await expect(window.locator("#repo-name")).toHaveText(/gac-e2e-/)
  await expect(window.locator("#repo-path")).toHaveText(repo)
  await expect(window).toHaveTitle(/gac-e2e-.* — AI 提交/)
  await expect(window.locator("#empty-state")).toBeHidden()
  await expect(window.locator("#status")).toContainText("共 1 个变更 · 已选 1")
  await expect(window.locator("#btn-commit")).toBeDisabled()

  await app.close()
})

test("② 勾选并提交只包含勾选的文件", async () => {
  const repo = makeRepo()
  const app = await launchApp({ repo, configFile: makeConfig() })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")

  await window.fill("#message", "更新 tracked")
  await expect(window.locator("#btn-commit")).toBeEnabled()
  await window.click("#btn-commit")
  await expect(window.locator("#status")).toContainText("提交成功")

  const files = git(repo, ["ls-tree", "-r", "HEAD", "--name-only"]).split(/\r?\n/).filter(Boolean)
  expect(files).toContain("tracked.txt")
  expect(files).not.toContain("new.txt")
  expect(git(repo, ["log", "-1", "--pretty=%s"]).trim()).toBe("更新 tracked")

  await app.close()
})

test("③ AI 生成填入提交信息并剥离 <think>", async () => {
  const repo = makeRepo()
  const calls: unknown[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { content: "<think>推理过程</think>修复 tracked 文件" } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  const configFile = makeConfig({ api: { url: `http://127.0.0.1:${port}/v1`, api_key: "k", model: "m" } })

  const app = await launchApp({ repo, configFile })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")
  await window.click("#btn-generate")

  await expect(window.locator("#message")).toHaveValue("修复 tracked 文件")
  await expect(window.locator("#status")).toContainText("已生成")
  expect(calls).toHaveLength(1)
  expect((calls[0] as { model: string }).model).toBe("m")

  await app.close()
  server.close()
})

test("④ 设置保存写回配置文件并保留其它键", async () => {
  const repo = makeRepo()
  const configFile = makeConfig({ git: { max_diff_lines: 123 } })
  const app = await launchApp({ repo, configFile })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")

  await window.click("#btn-settings")
  await expect(window.locator("#settings-save")).toBeVisible()
  await window.fill("#api-url", "http://127.0.0.1:9/v1")
  await window.fill("#api-model", "test-model")
  await window.click("#settings-save")
  await expect(window.locator("#status")).toContainText("设置已保存")

  const saved = JSON.parse(readFileSync(configFile, "utf8"))
  expect(saved.api.url).toBe("http://127.0.0.1:9/v1")
  expect(saved.api.model).toBe("test-model")
  expect(saved.git.max_diff_lines).toBe(123)
  expect(saved.selection.checked_by_default).toBe("tracked")

  await app.close()
})

test("④b 接口地址为空时保存禁用且给出提示", async () => {
  const repo = makeRepo()
  const app = await launchApp({ repo, configFile: makeConfig() })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")

  await window.click("#btn-settings")
  await window.fill("#api-url", "")
  await expect(window.locator("#settings-save")).toBeDisabled()
  await expect(window.locator("#settings-validation")).toHaveText("接口地址不能为空")

  await app.close()
})

test("⑤ 点某行在右栏显示 diff", async () => {
  const repo = makeRepo()
  const app = await launchApp({ repo, configFile: makeConfig() })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")

  await expect(window.locator("#diff-empty")).toBeVisible()
  await window.click('#changes-body tr[data-path="tracked.txt"]')
  await expect(window.locator("#diff-title")).toHaveText("tracked.txt")
  await expect(window.locator("#diff-body .diff-line.add")).toContainText("+v2")
  await expect(window.locator('#changes-body tr[data-path="tracked.txt"]')).toHaveAttribute("aria-selected", "true")

  await app.close()
})

test("⑤b 未跟踪文件显示新增内容与说明行", async () => {
  const repo = makeRepo()
  const app = await launchApp({ repo, configFile: makeConfig({ ui: { show_untracked: true } }) })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")

  await expect(window.locator("#changes-body tr")).toHaveCount(2)
  await window.click('#changes-body tr[data-path="new.txt"]')
  await expect(window.locator("#diff-body .diff-line.note")).toContainText("新增文件")
  await expect(window.locator("#diff-body .diff-line.add")).toContainText("+hello")

  await app.close()
})

test("⑦ 旧版配置（720×520 + traditional）仍以分栏形态打开", async () => {
  const repo = makeRepo()
  const configFile = makeConfig({ ui: { window_width: 720, window_height: 520, style: "traditional" } })
  const app = await launchApp({ repo, configFile })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")

  // 旧默认尺寸被升级 → 不是窄窗形态；未知样式回退内置浅色
  const narrow = await window.evaluate(() => document.getElementById("app")?.classList.contains("narrow"))
  expect(narrow).toBe(false)
  await expect(window.locator("#diff-empty")).toBeVisible()

  await app.close()
})

test("⑥ 不是 git 仓库时报错并以非 0 退出", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gac-notrepo-"))
  const app = await launchApp({ repo: dir, configFile: makeConfig(), noDialog: true })
  const proc = app.process()
  const code = await new Promise<number | null>((resolve) => proc.once("exit", (value) => resolve(value)))
  expect(code).not.toBe(0)
})
