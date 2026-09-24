import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
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

/**
 * 假 SSE 服务：handler 拿到 send/finish/done 逐块推 delta。
 * 不调用 done() 就是「连接一直挂着」——用来断言流式中间态，避免用 sleep 抢时序。
 */
function streamServer(
  handler: (ctx: {
    send: (delta: Record<string, unknown>) => void
    finish: (reason?: string) => void
    done: () => void
  }) => void,
  calls: unknown[] = [],
): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      const send = (delta: Record<string, unknown>): void => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
      }
      const finish = (reason = "stop"): void => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`)
      }
      const done = (): void => {
        res.write("data: [DONE]\n\n")
        res.end()
      }
      handler({ send, finish, done })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port
      resolve({ server, url: `http://127.0.0.1:${port}/v1` })
    })
  })
}

/**
 * 假 WinMerge 的引导脚本（本机没装 WinMerge，用 node.exe 冒充）。
 *
 * 主进程以 `/s /e /u <left> <right>` 拉起假 WinMerge，但 node 会把首个参数 `/s`
 * 当脚本路径、直接报「Cannot find module」而不执行 left。于是这两条用例经
 * launchApp 的 extraEnv 传 `node_options=--require=<本脚本>`（子进程继承该变量），
 * 让 node 先加载这里；它再把 left（argv[4]，即 `git show HEAD:`
 * 落下的 probe.js）当模块 require —— probe.js 因此真正执行，把自身的
 * HEAD/WORKTREE 标签写进标记文件。
 *
 * 用小写 `node_options` 而非 `NODE_OPTIONS`：Playwright 的 electron.launch 会
 * `delete env.NODE_OPTIONS`（见 playwright-core electron launcher），Windows 环境变量
 * 大小写不敏感，换个大小写恰好绕过这一步而仍被 node 识别。
 */
/**
 * 引导脚本的临时目录只在 worker 的 `beforeAll` 里建：Playwright 的收集阶段也会
 * 在主进程求值本文件，若在顶层 `mkdtempSync`，主进程那份没有 `afterAll` 可清、
 * 会永久残留在 `%TEMP%`。
 */
let bootDir = ""
let fakeWinMergeEnv: Record<string, string> = {}

test.beforeAll(() => {
  bootDir = mkdtempSync(join(tmpdir(), "gac-boot-"))
  const bootstrap = join(bootDir, "boot.js")
  writeFileSync(
    bootstrap,
    `try { const entry = process.argv[4]; if (entry && entry.endsWith("probe.js")) require(entry) } catch {}\n`,
    "utf8",
  )
  // 只给需要假 WinMerge 的 ⑧⑪ 传 node_options，避免泄漏给同 worker 的其它用例。
  // 路径加引号防 %TEMP% 含空格被按空白切分；用正斜杠是因为 NODE_OPTIONS 解析时
  // 双引号内的反斜杠会被当转义吃掉（C:\Users\... 会变成 C:Users...）。
  fakeWinMergeEnv = { node_options: `--require="${bootstrap.replace(/\\/g, "/")}"` }
})

test.afterAll(() => {
  if (bootDir) rmSync(bootDir, { recursive: true, force: true })
})

/** 造一个含 probe.js 的仓库：HEAD 版写 "HEAD"，工作区版写 "WORKTREE"。 */
function makeProbeRepo(marker: string): string {
  const dir = makeRepo()
  const body = (tag: string): string =>
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(tag)})\n`
  writeFileSync(join(dir, "probe.js"), body("HEAD"), "utf8")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", "probe"])
  writeFileSync(join(dir, "probe.js"), body("WORKTREE"), "utf8")
  return dir
}

test("⑧ 双击行用 WinMerge 打开：左值取自 HEAD（假 WinMerge = node.exe）", async () => {
  const markerDir = mkdtempSync(join(tmpdir(), "gac-mark-"))
  const marker = join(markerDir, "marker.txt")
  const repo = makeProbeRepo(marker)
  const configFile = makeConfig({ tools: { winmerge_path: process.execPath } })

  const app = await launchApp({ repo, configFile, extraEnv: fakeWinMergeEnv })
  const window = await app.firstWindow()
  await window.waitForSelector('#changes-body tr[data-path="probe.js"]')

  await window.dblclick('#changes-body tr[data-path="probe.js"]')

  await expect.poll(() => (existsSync(marker) ? readFileSync(marker, "utf8") : ""), {
    timeout: 15_000,
  }).toBe("HEAD")

  await app.close()
})

test("⑨ 双击不改变勾选状态", async () => {
  const repo = makeRepo() // tracked.txt 默认勾选、new.txt 未跟踪默认不显示
  const app = await launchApp({ repo, configFile: makeConfig({ tools: { winmerge_path: process.execPath } }) })
  const window = await app.firstWindow()
  const box = window.locator('#changes-body tr[data-path="tracked.txt"] input[type=checkbox]')

  await expect(box).toBeChecked()
  await window.dblclick('#changes-body tr[data-path="tracked.txt"]')
  await expect(box).toBeChecked()

  await app.close()
})

test("⑩ 找不到 WinMerge 时弹错误弹层，且不动其它状态", async () => {
  const repo = makeRepo()
  const configFile = makeConfig({ tools: { winmerge_path: "C:\\definitely-missing\\WinMergeU.exe" } })
  const app = await launchApp({ repo, configFile })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")

  await window.fill("#message", "别动我")
  await window.dblclick('#changes-body tr[data-path="tracked.txt"]')

  await expect(window.locator(".modal-backdrop")).toBeVisible()
  await expect(window.locator("#message-detail")).toContainText("未找到 WinMerge")
  await expect(window.locator("#message")).toHaveValue("别动我")
  await expect(window.locator('#changes-body tr[data-path="tracked.txt"] input[type=checkbox]')).toBeChecked()

  await app.close()
})

test("⑪ 退出后临时目录被清理", async () => {
  const markerDir = mkdtempSync(join(tmpdir(), "gac-mark2-"))
  const repo = makeProbeRepo(join(markerDir, "m.txt"))
  const app = await launchApp({
    repo,
    configFile: makeConfig({ tools: { winmerge_path: process.execPath } }),
    extraEnv: fakeWinMergeEnv,
  })
  const window = await app.firstWindow()
  await window.waitForSelector('#changes-body tr[data-path="probe.js"]')
  await window.dblclick('#changes-body tr[data-path="probe.js"]')

  // app.process().pid 是 Playwright 在 Windows 上经 shell 拉起的中间进程（cmd.exe），
  // 不是 stageRoot 所用的 Electron 主进程 pid；要进主进程问它自己的 pid。
  const pid = await app.evaluate(() => process.pid)
  const dir = join(tmpdir(), "git-ai-commit", String(pid))
  await expect.poll(() => existsSync(dir), { timeout: 15_000 }).toBe(true)

  await app.close()
  await expect.poll(() => existsSync(dir), { timeout: 15_000 }).toBe(false)
})

interface LaunchOptions {
  repo: string
  configFile?: string
  noDialog?: boolean
  extraEnv?: Record<string, string>
}

async function launchApp({ repo, configFile, noDialog, extraEnv }: LaunchOptions): Promise<ElectronApplication> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  if (configFile) env.GIT_AI_COMMIT_CONFIG = configFile
  if (noDialog) env.GIT_AI_COMMIT_NO_DIALOG = "1"
  if (extraEnv) Object.assign(env, extraEnv)
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

test("③ AI 生成：思考进思考区、正文进输入框（SSE，标签跨 chunk）", async () => {
  const repo = makeRepo()
  const calls: unknown[] = []
  const { server, url } = await streamServer(({ send, finish, done }) => {
    send({ content: "<thi" })
    send({ content: "nk>先看 diff。</think>fix(tracked): 修好" })
    finish()
    done()
  }, calls)
  const configFile = makeConfig({ api: { url, api_key: "k", model: "m" } })

  const app = await launchApp({ repo, configFile })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")
  await window.click("#btn-generate")

  await expect(window.locator("#message")).toHaveValue("fix(tracked): 修好")
  await expect(window.locator("#thinking")).toBeVisible()
  await expect(window.locator("#thinking-body")).toHaveText("先看 diff。")
  await expect(window.locator("#status")).toContainText("已生成")

  // 真实链路发出去的提示词必须是新的结构化版本，且 diff 作为 user 消息
  expect(calls).toHaveLength(1)
  const messages = (calls[0] as { messages: { role: string; content: string }[] }).messages
  expect((calls[0] as { model: string }).model).toBe("m")
  expect((calls[0] as { stream: boolean }).stream).toBe(true)
  expect(messages[0].role).toBe("system")
  expect(messages[0].content).toContain("Conventional Commits")
  expect(messages[0].content).toContain("<type>(<范围>): <描述>")
  expect(messages[1].role).toBe("user")
  expect(messages[1].content).toContain("diff --git a/tracked.txt b/tracked.txt")
  expect(messages[1].content).toContain("+v2")

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

test("④c 设置入口在顶栏、动作行不再有它，Ctrl+, 也能打开", async () => {
  const repo = makeRepo()
  const app = await launchApp({ repo, configFile: makeConfig() })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")

  await expect(window.locator(".app-header #btn-settings")).toBeVisible()
  await expect(window.locator(".actions #btn-settings")).toHaveCount(0)
  await expect(window.locator("#btn-settings")).toHaveAttribute("aria-label", "设置")

  await window.keyboard.press("Control+,")
  await expect(window.locator("#settings-save")).toBeVisible()

  // 弹层已开时再按一次不应叠加出第二个弹层
  await window.keyboard.press("Control+,")
  await expect(window.locator(".modal-backdrop")).toHaveCount(1)
  await window.keyboard.press("Escape")
  await expect(window.locator(".modal-backdrop")).toHaveCount(0)

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

test("⑫ 流式：思考与正文边收边显示，生成中输入框只读", async () => {
  const repo = makeRepo()
  // 只发两块就不结束（连接挂着）→ 中间态可稳定断言，不靠 sleep 抢时序
  const { server, url } = await streamServer(({ send }) => {
    send({ reasoning_content: "先看改动。" })
    send({ content: "fix: 流式" })
  })
  const configFile = makeConfig({ api: { url, api_key: "k", model: "m" } })

  const app = await launchApp({ repo, configFile })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")
  await window.fill("#message", "草稿不要留")
  await window.click("#btn-generate")

  await expect(window.locator("#thinking-body")).toHaveText("先看改动。")
  await expect(window.locator("#thinking")).toBeVisible()
  await expect(window.locator("#message")).toHaveValue("fix: 流式")
  await expect(window.locator("#message")).toHaveAttribute("readonly", "")
  await expect(window.locator("#btn-cancel")).toBeEnabled()

  await app.close()
  server.close()
})

test("⑬ 取消：不弹错误弹层，且保留已收到的思考与正文", async () => {
  const repo = makeRepo()
  const { server, url } = await streamServer(({ send }) => {
    send({ reasoning_content: "想了半截" })
    send({ content: "fix: 半截" })
  })
  const configFile = makeConfig({ api: { url, api_key: "k", model: "m" } })

  const app = await launchApp({ repo, configFile })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")
  await window.click("#btn-generate")
  await expect(window.locator("#message")).toHaveValue("fix: 半截")

  await window.click("#btn-cancel")

  await expect(window.locator("#status")).toContainText("已取消")
  await expect(window.locator(".modal-backdrop")).toBeHidden()
  await expect(window.locator("#thinking-body")).toHaveText("想了半截")
  await expect(window.locator("#message")).toHaveValue("fix: 半截")
  await expect(window.locator("#message")).not.toHaveAttribute("readonly", "")

  await app.close()
  server.close()
})

test("⑭ 服务端返回非流式 JSON：照常生成，思考进思考区，截断有提示", async () => {
  const repo = makeRepo()
  const server = createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "<think>想过</think>fix: 半截" }, finish_reason: "length" }],
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  const configFile = makeConfig({ api: { url: `http://127.0.0.1:${port}/v1`, api_key: "k", model: "m" } })

  const app = await launchApp({ repo, configFile })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")
  await window.click("#btn-generate")

  await expect(window.locator("#message")).toHaveValue("fix: 半截")
  await expect(window.locator("#thinking-body")).toHaveText("想过")
  await expect(window.locator("#status")).toContainText("截断")

  await app.close()
  server.close()
})
