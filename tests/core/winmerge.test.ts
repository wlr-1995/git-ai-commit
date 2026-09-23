import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  WINMERGE_ARGS,
  WinMergeError,
  comparePlan,
  defaultProbe,
  detectWinMerge,
  launchWinMerge,
  notFoundMessage,
  parseRegQueryInstallLocation,
  prepareComparison,
  stageRoot,
  type WinMergeProbe,
} from "../../src/core/winmerge"
import { ADDED, DELETED, MODIFIED, RENAMED, UNTRACKED } from "../../src/shared/changes"
import { commitAll, git, initRepo, makeTempDir, writeFile } from "../helpers/repo"

function stage(): string {
  return makeTempDir("gac-stage-")
}

describe("comparePlan", () => {
  it("已修改：左取自 HEAD，右为工作区真实路径", () => {
    const worktree = join("C:", "repo", "src", "core", "ai.ts")
    const plan = comparePlan({ path: "src/core/ai.ts", status: MODIFIED, origPath: null }, worktree, stage())
    expect(plan.leftFromHead).toBe("HEAD:src/core/ai.ts")
    expect(plan.rightEmpty).toBe(false)
    expect(plan.rightPath).toBe(worktree)
    expect(plan.leftPath.endsWith("ai.ts")).toBe(true)
    expect(plan.leftPath).not.toBe(plan.rightPath)
  })

  it("已重命名：左取自 HEAD 的旧路径", () => {
    const plan = comparePlan(
      { path: "new.txt", status: RENAMED, origPath: "old.txt" },
      join("C:", "repo", "new.txt"),
      stage(),
    )
    expect(plan.leftFromHead).toBe("HEAD:old.txt")
  })

  it("已添加/未跟踪：左为空（不给 HEAD 引用）", () => {
    for (const status of [ADDED, UNTRACKED]) {
      const plan = comparePlan({ path: "新 文件.txt", status, origPath: null }, join("C:", "repo", "新 文件.txt"), stage())
      expect(plan.leftFromHead).toBeNull()
      expect(plan.rightEmpty).toBe(false)
    }
  })

  it("已删除：右为空占位（给不存在的路径 WinMerge 会弹选择框）", () => {
    const plan = comparePlan({ path: "gone.txt", status: DELETED, origPath: null }, join("C:", "repo", "gone.txt"), stage())
    expect(plan.rightEmpty).toBe(true)
    expect(plan.rightPath).not.toContain("repo")
    expect(plan.rightPath.endsWith("gone.txt")).toBe(true)
  })

  it("反斜杠路径归一为正斜杠（git 只认正斜杠）", () => {
    const plan = comparePlan({ path: "src\\a.ts", status: MODIFIED, origPath: null }, "C:\\repo\\src\\a.ts", stage())
    expect(plan.leftFromHead).toBe("HEAD:src/a.ts")
  })
})

describe("prepareComparison", () => {
  it("左值是 HEAD 版，右值仍是工作区真实文件（不被改写）", async () => {
    const repo = makeTempDir("gac-cmp-")
    initRepo(repo)
    writeFile(repo, "a.txt", "HEAD 内容\n")
    commitAll(repo)
    writeFile(repo, "a.txt", "工作区内容\n")

    const worktree = join(repo, "a.txt")
    const plan = comparePlan({ path: "a.txt", status: MODIFIED, origPath: null }, worktree, stage())
    const { left, right } = await prepareComparison(repo, plan)

    expect(readFileSync(left, "utf8")).toBe("HEAD 内容\n")
    expect(right).toBe(worktree)
    expect(readFileSync(right, "utf8")).toBe("工作区内容\n")
  })

  it("二进制按字节落盘，不被 utf8 改坏", async () => {
    const repo = makeTempDir("gac-cmp-bin-")
    initRepo(repo)
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x41])
    writeFileSync(join(repo, "blob.bin"), raw)
    commitAll(repo)

    const plan = comparePlan({ path: "blob.bin", status: MODIFIED, origPath: null }, join(repo, "blob.bin"), stage())
    const { left } = await prepareComparison(repo, plan)
    expect(readFileSync(left).equals(raw)).toBe(true)
  })

  it("已添加的文件：左侧是 0 字节文件", async () => {
    const repo = makeTempDir("gac-cmp-add-")
    initRepo(repo)
    writeFile(repo, "seed.txt", "s")
    commitAll(repo)
    writeFile(repo, "new.txt", "新内容\n")

    const plan = comparePlan({ path: "new.txt", status: UNTRACKED, origPath: null }, join(repo, "new.txt"), stage())
    const { left } = await prepareComparison(repo, plan)
    expect(existsSync(left)).toBe(true)
    expect(readFileSync(left).length).toBe(0)
  })

  it("已删除的文件：右侧是 0 字节占位（工作区那份不存在）", async () => {
    const repo = makeTempDir("gac-cmp-del-")
    initRepo(repo)
    writeFile(repo, "gone.txt", "将被删除\n")
    commitAll(repo)
    git(repo, ["rm", "-q", "gone.txt"])

    const plan = comparePlan({ path: "gone.txt", status: DELETED, origPath: null }, join(repo, "gone.txt"), stage())
    const { left, right } = await prepareComparison(repo, plan)
    expect(readFileSync(left, "utf8")).toBe("将被删除\n")
    expect(existsSync(right)).toBe(true)
    expect(readFileSync(right).length).toBe(0)
  })

  it("HEAD 里没有该路径时左侧降级为空文件，不报错", async () => {
    const repo = makeTempDir("gac-cmp-miss-")
    initRepo(repo)
    writeFile(repo, "seed.txt", "s")
    commitAll(repo)
    writeFile(repo, "spoke.txt", "x")

    const plan = comparePlan({ path: "spoke.txt", status: MODIFIED, origPath: null }, join(repo, "spoke.txt"), stage())
    const { left } = await prepareComparison(repo, plan)
    expect(readFileSync(left).length).toBe(0)
  })

  it("两次计划落在不同 stageDir，同名文件不互相覆盖", async () => {
    const repo = makeTempDir("gac-cmp-two-")
    initRepo(repo)
    writeFile(repo, "a.txt", "v1\n")
    commitAll(repo)
    writeFile(repo, "a.txt", "v2\n")

    const first = await prepareComparison(
      repo,
      comparePlan({ path: "a.txt", status: MODIFIED, origPath: null }, join(repo, "a.txt"), stage()),
    )
    const second = await prepareComparison(
      repo,
      comparePlan({ path: "a.txt", status: MODIFIED, origPath: null }, join(repo, "a.txt"), stage()),
    )
    expect(first.left).not.toBe(second.left)
    expect(readFileSync(first.left, "utf8")).toBe("v1\n")
  })
})

describe("detectWinMerge", () => {
  const probe = (existing: string[], registry: string[], common: string[]): WinMergeProbe => ({
    exists: (path) => existing.includes(path),
    registryInstallLocations: () => registry,
    commonPaths: () => common,
  })

  it("配置了 exe 路径且存在 → 直接用配置值", () => {
    const configured = "D:\\Tools\\WinMerge\\WinMergeU.exe"
    expect(detectWinMerge(configured, probe([configured], [], []))).toBe(configured)
  })

  it("配置了目录 → 补上 WinMergeU.exe", () => {
    const dir = "D:\\Tools\\WinMerge"
    const exe = join(dir, "WinMergeU.exe")
    expect(detectWinMerge(dir, probe([exe], [], []))).toBe(exe)
  })

  it("配置了但不存在 → 直接失败，不再往下探测（避免悄悄换成别的安装）", () => {
    const common = ["C:\\Program Files\\WinMerge\\WinMergeU.exe"]
    expect(detectWinMerge("C:\\nope\\WinMergeU.exe", probe(common, [], common))).toBeNull()
  })

  it("未配置 → 注册表 InstallLocation 优先于常见路径", () => {
    const fromRegistry = "D:\\Green\\WinMerge\\WinMergeU.exe"
    const common = "C:\\Program Files\\WinMerge\\WinMergeU.exe"
    expect(detectWinMerge("", probe([fromRegistry, common], ["D:\\Green\\WinMerge"], [common]))).toBe(fromRegistry)
  })

  it("未配置且注册表没有 → 用常见路径", () => {
    const common = "C:\\Program Files\\WinMerge\\WinMergeU.exe"
    expect(detectWinMerge("", probe([common], [], [common]))).toBe(common)
  })

  it("都没有 → null", () => {
    expect(detectWinMerge("", probe([], [], []))).toBeNull()
  })

  it("parseRegQueryInstallLocation 能从 reg query 输出里取值，无匹配返回 null", () => {
    const output = [
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WinMerge",
      "    InstallLocation    REG_SZ    C:\\Program Files\\WinMerge\\",
      "",
    ].join("\r\n")
    expect(parseRegQueryInstallLocation(output)).toBe("C:\\Program Files\\WinMerge\\")
    expect(parseRegQueryInstallLocation("错误: 系统找不到指定的注册表项或值。")).toBeNull()
  })

  it("notFoundMessage 带上配置过的路径", () => {
    expect(notFoundMessage("")).toContain("未找到 WinMerge")
    expect(notFoundMessage("C:\\nope\\WinMergeU.exe")).toContain("C:\\nope\\WinMergeU.exe")
  })
})

describe("defaultProbe / stageRoot", () => {
  it("registryInstallLocations 用注入的 runner，不碰真实注册表", () => {
    // 只让其中一个 key 命中，才能断言结果恰好一条；REG_KEYS 按顺序访问，命中用哪个 key 不影响结论。
    const runner = (key: string) => (key === "HKLM\\SOFTWARE\\WinMerge" ? "D:\\Green\\WinMerge\\" : null)
    expect(defaultProbe.registryInstallLocations(runner)).toEqual(["D:\\Green\\WinMerge\\"])
  })

  it("exists 对真实文件为 true、对不存在的路径为 false", () => {
    const dir = makeTempDir("gac-exists-")
    const file = join(dir, "present.txt")
    writeFileSync(file, "x")
    expect(defaultProbe.exists(file)).toBe(true)
    expect(defaultProbe.exists(join(dir, "missing.txt"))).toBe(false)
  })

  it("stageRoot 按 pid 隔离在系统临时目录下", () => {
    const root = stageRoot(4242)
    expect(root.endsWith(join("git-ai-commit", "4242"))).toBe(true)
    expect(root).toContain(tmpdir())
  })

  it("commonPaths 从 ProgramFiles 拼出常见安装路径", () => {
    const old = process.env.ProgramFiles
    try {
      process.env.ProgramFiles = "X:\\PF"
      expect(defaultProbe.commonPaths()).toContain(join("X:\\PF", "WinMerge", "WinMergeU.exe"))
    } finally {
      // 环境变量是全局的，改完必须还原，避免污染同进程的其它用例。
      if (old === undefined) delete process.env.ProgramFiles
      else process.env.ProgramFiles = old
    }
  })
})

describe("WINMERGE_ARGS / launchWinMerge", () => {
  it("参数顺序：/s /e /u 在路径之前，左在右之前", () => {
    expect(WINMERGE_ARGS("L.txt", "R.txt")).toEqual(["/s", "/e", "/u", "L.txt", "R.txt"])
  })

  it("detached 启动、不等待，且把参数原样传给 exe", async () => {
    const calls: { exe: string; args: string[]; options: unknown }[] = []
    let unrefCalled = false
    const fakeSpawn = ((exe: string, args: string[], options: unknown) => {
      calls.push({ exe, args, options })
      return {
        once(event: string, handler: () => void) {
          if (event === "spawn") handler()
          return this
        },
        unref() {
          unrefCalled = true
        },
      }
    }) as unknown as typeof spawn

    await launchWinMerge("C:\\W\\WinMergeU.exe", "L", "R", fakeSpawn)
    expect(calls[0].exe).toBe("C:\\W\\WinMergeU.exe")
    expect(calls[0].args).toEqual(["/s", "/e", "/u", "L", "R"])
    const options = calls[0].options as { detached: boolean; stdio: string }
    expect(options.detached).toBe(true)
    expect(options.stdio).toBe("ignore")
    expect(unrefCalled).toBe(true)
  })

  it("spawn 报错 → WinMergeError(launch_failed)", async () => {
    const fakeSpawn = (() => ({
      once(event: string, handler: (error: Error) => void) {
        if (event === "error") handler(new Error("拒绝访问"))
        return this
      },
      unref() {},
    })) as unknown as typeof spawn

    const error = await launchWinMerge("C:\\W\\W.exe", "L", "R", fakeSpawn).catch((e) => e)
    expect(error).toBeInstanceOf(WinMergeError)
    expect((error as WinMergeError).reason).toBe("launch_failed")
    expect((error as Error).message).toContain("拒绝访问")
  })
})
