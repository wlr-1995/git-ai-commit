import { unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { diffNumstat, numstatNewPath } from "../../src/core/repo"
import { commitAll, git, initRepo, makeTempDir, writeFile } from "../helpers/repo"

describe("numstatNewPath", () => {
  it("普通路径原样", () => {
    expect(numstatNewPath("a.txt")).toBe("a.txt")
  })

  it("重命名取新路径", () => {
    expect(numstatNewPath("old.txt => new.txt")).toBe("new.txt")
  })

  it("花括号形式取新路径并保留前后缀", () => {
    expect(numstatNewPath("src/{old => new}/a.ts")).toBe("src/new/a.ts")
  })
})

describe("diffNumstat", () => {
  it("统计已修改文件", async () => {
    const dir = initRepo(makeTempDir(), "trunk")
    writeFile(dir, "a.txt", "one\ntwo\n")
    commitAll(dir)
    writeFile(dir, "a.txt", "one\nTWO\nthree\n")
    expect((await diffNumstat(dir))["a.txt"]).toEqual([2, 1])
  })

  it("统计新增与删除", async () => {
    const dir = initRepo(makeTempDir(), "trunk")
    writeFile(dir, "gone.txt", "x\ny\n")
    commitAll(dir)
    writeFile(dir, "new.txt", "p\nq\nr\n")
    git(dir, ["add", "new.txt"])
    unlinkSync(join(dir, "gone.txt"))
    const stats = await diffNumstat(dir)
    expect(stats["new.txt"]).toEqual([3, 0])
    expect(stats["gone.txt"]).toEqual([0, 2])
  })

  it("二进制返回 [null, null]", async () => {
    const dir = initRepo(makeTempDir(), "trunk")
    writeFileSync(join(dir, "b.bin"), Buffer.from(Array.from({ length: 256 }, (_, i) => i)))
    commitAll(dir)
    writeFileSync(join(dir, "b.bin"), Buffer.from(Array.from({ length: 256 }, (_, i) => 255 - i)))
    expect((await diffNumstat(dir))["b.bin"]).toEqual([null, null])
  })

  it("未跟踪文件不统计", async () => {
    const dir = initRepo(makeTempDir(), "trunk")
    writeFile(dir, "a.txt", "a\n")
    commitAll(dir)
    writeFile(dir, "untracked.txt", "z\n")
    expect("untracked.txt" in (await diffNumstat(dir))).toBe(false)
  })

  it("重命名映射到新路径", async () => {
    const dir = initRepo(makeTempDir(), "trunk")
    writeFile(dir, "old.txt", "a\nb\nc\n")
    commitAll(dir)
    git(dir, ["mv", "old.txt", "new.txt"])
    writeFile(dir, "new.txt", "a\nb\nc\nd\n")
    git(dir, ["add", "-A"])
    const stats = await diffNumstat(dir)
    expect("new.txt" in stats).toBe(true)
    expect("old.txt" in stats).toBe(false)
  })

  it("空仓库返回 {}", async () => {
    const dir = initRepo(makeTempDir(), "trunk")
    writeFile(dir, "a.txt", "a\n")
    expect(await diffNumstat(dir)).toEqual({})
  })
})
