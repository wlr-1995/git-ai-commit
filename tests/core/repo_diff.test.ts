import { unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { MAX_UNTRACKED_BYTES, diffFor, readDiff, truncate } from "../../src/core/repo"
import { commitAll, git, initRepo, makeTempDir, writeFile } from "../helpers/repo"

describe("truncate", () => {
  it("短文本原样返回", () => {
    expect(truncate("a\nb", 10)).toBe("a\nb")
  })

  it("保留头部并标注省略行数", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
    const result = truncate(text, 3)
    expect(result.startsWith("line0\nline1\nline2")).toBe(true)
    expect(result).toContain("省略 7 行")
  })

  it("maxLines<=0 时不截断", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
    expect(truncate(text, 0)).toBe(text)
  })

  it("尾部换行不影响行数计算", () => {
    expect(truncate("a\nb\n", 10)).toBe("a\nb\n")
    expect(truncate("a\nb\n", 2)).toBe("a\nb\n")
  })
})

describe("diffFor", () => {
  it("已修改文件", async () => {
    const dir = initRepo(makeTempDir())
    writeFile(dir, "a.py", "one\n")
    commitAll(dir)
    writeFile(dir, "a.py", "one\ntwo\n")
    expect(await diffFor(dir, ["a.py"])).toContain("+two")
  })

  it("未跟踪文件显示内容", async () => {
    const dir = initRepo(makeTempDir())
    writeFile(dir, "new 文件.txt", "hello\nworld\n")
    const diff = await diffFor(dir, ["new 文件.txt"])
    expect(diff).toContain("新增文件")
    expect(diff).toContain("+hello")
    expect(diff).toContain("+world")
  })

  it("多个路径", async () => {
    const dir = initRepo(makeTempDir())
    writeFile(dir, "a.txt", "a\n")
    writeFile(dir, "b.txt", "b\n")
    const diff = await diffFor(dir, ["a.txt", "b.txt"])
    expect(diff).toContain("+a")
    expect(diff).toContain("+b")
  })

  it("超大未跟踪文件用紧凑标记", async () => {
    const dir = initRepo(makeTempDir())
    writeFileSync(join(dir, "big.bin"), Buffer.alloc(MAX_UNTRACKED_BYTES + 1024, "Z"))
    const diff = await diffFor(dir, ["big.bin"], 0)
    expect(diff).toContain("过大")
    expect(diff).toContain("已跳过")
    expect(diff).not.toContain("+Z")
    expect(diff.length).toBeLessThan(200)
  })

  it("二进制未跟踪文件用紧凑标记", async () => {
    const dir = initRepo(makeTempDir())
    writeFileSync(join(dir, "blob.bin"), Buffer.from("abc\0def\nghi\n", "binary"))
    const diff = await diffFor(dir, ["blob.bin"], 0)
    expect(diff).toContain("二进制")
    expect(diff).toContain("已跳过")
    expect(diff).not.toContain("abc")
    expect(diff.length).toBeLessThan(200)
  })
})

describe("readDiff", () => {
  it("未截断时 truncated=false", async () => {
    const dir = initRepo(makeTempDir())
    writeFile(dir, "a.txt", "a\nb\n")
    const result = await readDiff(dir, "a.txt", 100)
    expect(result.truncated).toBe(false)
    expect(result.omitted).toBe(0)
    expect(result.text).toContain("+a")
  })

  it("截断时给出 omitted 与标记行，且与 diffFor 结果一致", async () => {
    const dir = initRepo(makeTempDir())
    writeFile(dir, "a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n")
    const result = await readDiff(dir, "a.txt", 1)
    expect(result.truncated).toBe(true)
    expect(result.omitted).toBeGreaterThan(0)
    expect(result.text).toContain("已截断")
    const viaDiffFor = await diffFor(dir, ["a.txt"], 1)
    expect(viaDiffFor).toBe(result.text)
  })

  it("不存在的文件给出「不可读」说明且未截断", async () => {
    const dir = initRepo(makeTempDir())
    const result = await readDiff(dir, "ghost.txt", 100)
    expect(result.text).toBe("### 新增或不可读文件: ghost.txt")
    expect(result.truncated).toBe(false)
  })
})

describe("其它", () => {
  it("工作区文件被删且无 diff 时不谎报内容", async () => {
    const dir = initRepo(makeTempDir())
    const target = join(dir, "gone.txt")
    writeFileSync(target, "x")
    unlinkSync(target)
    const diff = await diffFor(dir, ["gone.txt"], 0)
    expect(diff).not.toContain("+x")
  })

  it("已跟踪但内容为空的新增文件也能给出说明", async () => {
    const dir = initRepo(makeTempDir())
    writeFile(dir, "empty.txt", "")
    const diff = await diffFor(dir, ["empty.txt"], 0)
    expect(diff).toContain("empty.txt")
    expect(diff).toContain("新增文件")
  })
})
