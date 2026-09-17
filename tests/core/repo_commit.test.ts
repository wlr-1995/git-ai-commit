import { unlinkSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { GitError } from "../../src/core/gitcmd"
import { commit, commitPathspecs, listChanges, stage } from "../../src/core/repo"
import { filesInHead, git, initRepoWithCommit, makeTempDir, porcelain, writeFile } from "../helpers/repo"

describe("stage/commit", () => {
  it("只提交勾选路径，忽略其它已暂存内容", async () => {
    const dir = initRepoWithCommit(makeTempDir())
    writeFile(dir, "a.txt", "a")
    writeFile(dir, "b.txt", "b")
    git(dir, ["add", "b.txt"])
    await stage(dir, ["a.txt"])
    await commit(dir, "只提交 a", ["a.txt"])
    const names = filesInHead(dir)
    expect(names).toContain("a.txt")
    expect(names).not.toContain("b.txt")
  })

  it("处理删除", async () => {
    const dir = initRepoWithCommit(makeTempDir(), { "gone.txt": "x" })
    unlinkSync(join(dir, "gone.txt"))
    await stage(dir, ["gone.txt"])
    await commit(dir, "删除 gone", ["gone.txt"])
    expect(filesInHead(dir)).not.toContain("gone.txt")
    expect(porcelain(dir)).toBe("")
  })

  it("中文路径", async () => {
    const dir = initRepoWithCommit(makeTempDir())
    writeFile(dir, "中文 文件.txt", "hi")
    await stage(dir, ["中文 文件.txt"])
    await commit(dir, "新增中文文件", ["中文 文件.txt"])
    expect(filesInHead(dir)).toContain("中文 文件.txt")
  })

  it("无可提交内容时抛 GitError", async () => {
    const dir = initRepoWithCommit(makeTempDir())
    await expect(commit(dir, "空提交", ["seed.txt"])).rejects.toBeInstanceOf(GitError)
  })

  it("已由 git rm 暂存删除后仍能提交", async () => {
    const dir = initRepoWithCommit(makeTempDir(), { "gone.txt": "x" })
    git(dir, ["rm", "-q", "gone.txt"])
    await stage(dir, ["gone.txt"])
    await commit(dir, "删除 gone", ["gone.txt"])
    expect(filesInHead(dir)).not.toContain("gone.txt")
    expect(porcelain(dir)).toBe("")
  })

  it("重命名提交时带上旧路径", async () => {
    const dir = initRepoWithCommit(makeTempDir(), { "old.txt": "content" })
    git(dir, ["mv", "old.txt", "new.txt"])
    const changes = await listChanges(dir)
    const paths = commitPathspecs(changes)
    expect(new Set(paths)).toEqual(new Set(["new.txt", "old.txt"]))
    await stage(dir, changes.map((c) => c.path))
    await commit(dir, "重命名", paths)
    const names = filesInHead(dir)
    expect(names).toContain("new.txt")
    expect(names).not.toContain("old.txt")
    expect(porcelain(dir)).toBe("")
  })

  it("方括号文件名按字面量处理", async () => {
    const dir = initRepoWithCommit(makeTempDir())
    writeFile(dir, "file1.txt", "one")
    writeFile(dir, "file[1].txt", "bracket")
    await stage(dir, ["file[1].txt"])
    await commit(dir, "新增方括号文件", ["file[1].txt"])
    const names = filesInHead(dir)
    expect(names).toContain("file[1].txt")
    expect(names).not.toContain("file1.txt")
  })

  it("空路径列表提交时抛「没有勾选任何文件」", async () => {
    const dir = initRepoWithCommit(makeTempDir())
    await expect(commit(dir, "x", [])).rejects.toThrow("没有勾选任何文件")
  })

  it("stage 空列表是空操作", async () => {
    const dir = initRepoWithCommit(makeTempDir())
    writeFile(dir, "a.txt", "a")
    await stage(dir, [])
    expect(porcelain(dir)).toContain("a.txt")
  })
})
