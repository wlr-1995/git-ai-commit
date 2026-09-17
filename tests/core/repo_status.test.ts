import { mkdirSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  ADDED,
  CONFLICTED,
  DELETED,
  MODIFIED,
  RENAMED,
  STATUS_TEXT,
  UNTRACKED,
  currentBranch,
  findRepoRoot,
  hasCommits,
  listChanges,
  parsePorcelainZ,
} from "../../src/core/repo"
import { commitAll, git, initRepo, initRepoWithCommit, makeTempDir, writeFile } from "../helpers/repo"

describe("parsePorcelainZ", () => {
  it("解析基本状态", () => {
    const text = " M a.py\0?? b 文件.txt\0 D c.py\0"
    expect(parsePorcelainZ(text)).toEqual([
      { path: "a.py", status: MODIFIED, origPath: null },
      { path: "b 文件.txt", status: UNTRACKED, origPath: null },
      { path: "c.py", status: DELETED, origPath: null },
    ])
  })

  it("重命名先新路径后旧路径", () => {
    expect(parsePorcelainZ("R  new.py\0old.py\0")).toEqual([
      { path: "new.py", status: RENAMED, origPath: "old.py" },
    ])
  })

  it("忽略 !! 条目", () => {
    expect(parsePorcelainZ("!! cache/\0")).toEqual([])
  })

  it("重命名后紧跟的条目不会被吞掉", () => {
    const text = "R  new.py\0old.py\0 M z.py\0"
    expect(parsePorcelainZ(text).map((c) => c.path)).toEqual(["new.py", "z.py"])
  })
})

describe("仓库探测", () => {
  it("listChanges 保留路径中的空格", async () => {
    const dir = initRepo(makeTempDir())
    writeFile(dir, "a b.txt", "x")
    const changes = await listChanges(dir)
    expect(changes.map((c) => c.path)).toEqual(["a b.txt"])
  })

  it("不在仓库内返回 null", async () => {
    expect(await findRepoRoot(makeTempDir())).toBeNull()
  })

  it("路径不存在返回 null", async () => {
    expect(await findRepoRoot(join(makeTempDir(), "does_not_exist"))).toBeNull()
  })

  it("仓库子目录返回仓库根", async () => {
    const dir = initRepo(makeTempDir())
    const sub = join(dir, "sub")
    mkdirSync(sub)
    const root = await findRepoRoot(sub)
    expect(root).not.toBeNull()
    expect(await findRepoRoot(dir)).toBe(root)
  })

  it("列出未跟踪与已修改", async () => {
    const dir = initRepoWithCommit(makeTempDir(), { "tracked.txt": "v1" })
    writeFile(dir, "tracked.txt", "v2")
    writeFile(dir, "new.txt", "x")
    const changes = Object.fromEntries((await listChanges(dir)).map((c) => [c.path, c.status]))
    expect(changes["tracked.txt"]).toBe(MODIFIED)
    expect(changes["new.txt"]).toBe(UNTRACKED)
  })

  it("hasCommits", async () => {
    const dir = initRepo(makeTempDir())
    expect(await hasCommits(dir)).toBe(false)
    writeFile(dir, "a.txt", "a")
    commitAll(dir)
    expect(await hasCommits(dir)).toBe(true)
  })
})

describe("currentBranch", () => {
  it("未出生分支", async () => {
    expect(await currentBranch(initRepo(makeTempDir(), "trunk"))).toBe("trunk")
  })

  it("提交后", async () => {
    const dir = initRepo(makeTempDir(), "trunk")
    writeFile(dir, "a.txt", "a")
    commitAll(dir)
    expect(await currentBranch(dir)).toBe("trunk")
  })

  it("游离 HEAD 返回短 SHA", async () => {
    const dir = initRepoWithCommit(initRepo(makeTempDir(), "trunk"))
    const sha = git(dir, ["rev-parse", "--short", "HEAD"]).trim()
    git(dir, ["checkout", "--detach", "HEAD"])
    expect(await currentBranch(dir)).toBe(`游离 HEAD (${sha})`)
  })
})

describe("状态文案", () => {
  it("状态中文名", () => {
    expect(STATUS_TEXT[MODIFIED]).toBe("已修改")
    expect(STATUS_TEXT[ADDED]).toBe("已添加")
    expect(STATUS_TEXT[DELETED]).toBe("已删除")
    expect(STATUS_TEXT[RENAMED]).toBe("已重命名")
    expect(STATUS_TEXT[UNTRACKED]).toBe("未版本控制")
    expect(STATUS_TEXT[CONFLICTED]).toBe("冲突")
  })
})
