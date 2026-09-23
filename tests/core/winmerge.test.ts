import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { comparePlan, prepareComparison } from "../../src/core/winmerge"
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
