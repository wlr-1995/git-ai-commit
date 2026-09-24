import { describe, expect, it } from "vitest"

import { ThinkSplitter, type ThinkParts } from "../../src/core/think"

function run(chunks: string[]): ThinkParts {
  const splitter = new ThinkSplitter()
  const acc: ThinkParts = { thinking: "", text: "" }
  for (const chunk of chunks) {
    const parts = splitter.push(chunk)
    acc.thinking += parts.thinking
    acc.text += parts.text
  }
  const tail = splitter.flush()
  acc.thinking += tail.thinking
  acc.text += tail.text
  return acc
}

function bySize(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size))
  return chunks
}

describe("ThinkSplitter", () => {
  it("整段一次喂：思考与正文分流", () => {
    expect(run(["前<think>想</think>后"])).toEqual({ thinking: "想", text: "前后" })
  })

  it("多个思考块全部拼接，标签外都是正文", () => {
    expect(run(["a<think>1</think>b<think>2</think>c"])).toEqual({ thinking: "12", text: "abc" })
  })

  it("穷举切分：任何切法结果都与整段一致（含中文与 emoji）", () => {
    const text = "修改<think>先看 diff，再想一个中文描述 🚀</think>feat: 完成"
    const reference = run([text])
    for (let size = 1; size <= text.length; size += 1) {
      expect(run(bySize(text, size))).toEqual(reference)
    }
  })

  it("标签被切在最刁钻的位置也不吞字、不漏标签", () => {
    const reference = run(["x<think>y</think>z"])
    const cases: string[][] = [
      ["x<", "think>y<", "/think>z"],
      ["x<th", "i", "nk>y", "</thi", "nk>z"],
      ["x<think", ">y</think", ">z"],
      ["x<think>y<", "/think>z"],
      ["x", "<", "t", "h", "i", "n", "k", ">", "y", "<", "/", "t", "h", "i", "n", "k", ">", "z"],
    ]
    for (const chunks of cases) expect(run(chunks)).toEqual(reference)
  })

  it("未闭合的思考块：已收部分是思考，flush 也归思考", () => {
    expect(run(["a<think>没写完"])).toEqual({ thinking: "没写完", text: "a" })
    expect(run(["a<thin"])).toEqual({ thinking: "", text: "a<thin" })
  })

  it("只收到标签的一截时留作未决前缀，不吐给正文也不吞掉", () => {
    const splitter = new ThinkSplitter()
    expect(splitter.push("<thi")).toEqual({ thinking: "", text: "" })
    expect(splitter.push("nk>x")).toEqual({ thinking: "x", text: "" })
    expect(splitter.flush()).toEqual({ thinking: "", text: "" })
  })

  it("思考态里不再处理嵌套，只认结束标签", () => {
    expect(run(["<think>a<think>b</think>c"])).toEqual({ thinking: "a<think>b", text: "c" })
  })

  it("没有思考标签时原样透传", () => {
    expect(run(["feat(ui): 加思考区"])).toEqual({ thinking: "", text: "feat(ui): 加思考区" })
  })
})
