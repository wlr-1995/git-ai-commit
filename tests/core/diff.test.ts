import { describe, expect, it } from "vitest"

import { parseDiff } from "../../src/core/diff"

const SAMPLE = [
  "diff --git a/a.py b/a.py",
  "index 111..222 100644",
  "--- a/a.py",
  "+++ b/a.py",
  "@@ -1,2 +1,3 @@",
  " one",
  "+two",
  "-old",
  "\\ No newline at end of file",
].join("\n")

describe("parseDiff", () => {
  it("分类文件头、hunk、增删与上下文", () => {
    expect(parseDiff(SAMPLE)).toEqual([
      { kind: "meta", text: "diff --git a/a.py b/a.py" },
      { kind: "meta", text: "index 111..222 100644" },
      { kind: "meta", text: "--- a/a.py" },
      { kind: "meta", text: "+++ b/a.py" },
      { kind: "hunk", text: "@@ -1,2 +1,3 @@" },
      { kind: "ctx", text: " one" },
      { kind: "add", text: "+two" },
      { kind: "del", text: "-old" },
      { kind: "meta", text: "\\ No newline at end of file" },
    ])
  })

  it("正文里的 +++ 是新增行而不是文件头", () => {
    const text = ["@@ -1 +1,2 @@", " ctx", "+++extra"].join("\n")
    expect(parseDiff(text)).toEqual([
      { kind: "hunk", text: "@@ -1 +1,2 @@" },
      { kind: "ctx", text: " ctx" },
      { kind: "add", text: "+++extra" },
    ])
  })

  it("未跟踪文件的提示行是 note", () => {
    const text = "### 新增文件: a.txt\n+hello\n+world"
    expect(parseDiff(text)).toEqual([
      { kind: "note", text: "### 新增文件: a.txt" },
      { kind: "add", text: "+hello" },
      { kind: "add", text: "+world" },
    ])
  })

  it("空文本返回空数组", () => {
    expect(parseDiff("")).toEqual([])
  })

  it("末尾换行不产生空行", () => {
    expect(parseDiff("@@ -1 +1 @@\n+a\n")).toHaveLength(2)
  })

  it("CRLF 输入的 \\r 不会留在文本里", () => {
    expect(parseDiff("@@ -1 +1 @@\r\n+a\r\n")).toEqual([
      { kind: "hunk", text: "@@ -1 +1 @@" },
      { kind: "add", text: "+a" },
    ])
  })

  it("新增文件的空内容不产生额外行", () => {
    expect(parseDiff("### 新增文件: empty.txt\n")).toEqual([{ kind: "note", text: "### 新增文件: empty.txt" }])
  })
})
