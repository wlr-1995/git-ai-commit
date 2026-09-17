import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { PathError, resolveInsideRepo } from "../../src/core/paths"
import { makeTempDir } from "../helpers/repo"

describe("resolveInsideRepo", () => {
  const root = makeTempDir()

  it("仓库内相对路径可解析", () => {
    expect(resolveInsideRepo(root, "a/b.txt")).toBe(join(root, "a", "b.txt"))
  })

  it("反斜杠路径也可解析", () => {
    expect(resolveInsideRepo(root, "a\\b.txt")).toBe(join(root, "a", "b.txt"))
  })

  it("拒绝 ../ 逃逸", () => {
    expect(() => resolveInsideRepo(root, "../outside.txt")).toThrow(PathError)
  })

  it("拒绝嵌套的逃逸", () => {
    expect(() => resolveInsideRepo(root, "a/../../outside.txt")).toThrow(PathError)
  })

  it("拒绝绝对路径（仓库外）", () => {
    expect(() => resolveInsideRepo(root, join(makeTempDir(), "x.txt"))).toThrow(PathError)
  })

  it("拒绝仓库内的绝对路径（只接受相对路径）", () => {
    expect(() => resolveInsideRepo(root, join(root, "a.txt"))).toThrow(PathError)
  })

  it("拒绝含 NUL 的路径", () => {
    expect(() => resolveInsideRepo(root, "a\0b")).toThrow(PathError)
  })

  it("允许解析到仓库根本身", () => {
    expect(resolveInsideRepo(root, ".")).toBe(root)
  })
})
