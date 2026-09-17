import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { GitError, runGit } from "../../src/core/gitcmd"
import { makeTempDir } from "../helpers/repo"

const gitAvailable = spawnSync("git", ["--version"]).status === 0
const maybe = gitAvailable ? describe : describe.skip

maybe("gitcmd", () => {
  it("run_git 返回 stdout", async () => {
    const dir = makeTempDir()
    const { code, stdout } = await runGit(["--version"], { cwd: dir })
    expect(code).toBe(0)
    expect(stdout).toContain("git version")
  })

  it("check=true 时非零退出码抛 GitError", async () => {
    const dir = makeTempDir()
    await expect(runGit(["rev-parse", "--verify", "HEAD"], { cwd: dir })).rejects.toBeInstanceOf(GitError)
  })

  it("check=false 时不抛，返回退出码", async () => {
    const dir = makeTempDir()
    const { code } = await runGit(["rev-parse", "--verify", "HEAD"], { cwd: dir, check: false })
    expect(code).not.toBe(0)
  })

  it("处理含中文与空格的路径", async () => {
    const repo = join(makeTempDir(), "含 空格 的 目录")
    mkdirSync(repo)
    spawnSync("git", ["init"], { cwd: repo })
    writeFileSync(join(repo, "文 件.txt"), "hello", "utf8")
    const { stdout } = await runGit(["status", "--porcelain"], { cwd: repo })
    expect(stdout).toContain("文 件.txt")
  })

  it("工作目录不存在时抛「工作目录无效」", async () => {
    const missing = join(makeTempDir(), "does_not_exist")
    await expect(runGit(["--version"], { cwd: missing })).rejects.toThrow(/工作目录无效/)
  })

  it("超时抛「git 命令超时」", async () => {
    const dir = makeTempDir()
    // timeoutMs=0：定时器必然早于子进程退出，结论确定（不依赖 git 跑多久）
    await expect(runGit(["--version"], { cwd: dir, timeoutMs: 0 })).rejects.toThrow(/超时/)
  })

  it("GIT_LITERAL_PATHSPECS 生效：方括号文件名不被当通配", async () => {
    const repo = join(makeTempDir(), "repo")
    mkdirSync(repo)
    spawnSync("git", ["init"], { cwd: repo })
    writeFileSync(join(repo, "file[1].txt"), "x", "utf8")
    const { stdout } = await runGit(["add", "-A", "--", "file[1].txt"], { cwd: repo })
    expect(stdout).toBe("")
  })
})
