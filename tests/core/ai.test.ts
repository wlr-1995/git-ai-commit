import { describe, expect, it } from "vitest"

import { AIError, buildPrompt, generateCommitMessage, stripThink } from "../../src/core/ai"

const CFG = {
  url: "http://localhost:11434/v1",
  api_key: "ollama",
  model: "qwen2.5-coder:7b",
  prompt: "",
  max_tokens: 8192,
  language: "中文",
  timeout: 60,
}

function fakeFetch(payload: unknown, status = 200, text = "body") {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return {
      status,
      text: async () => text,
      json: async () => {
        if (payload === undefined) throw new Error("no json")
        return payload
      },
    }
  }
  return { calls, fetchImpl }
}

function body(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init.body))
}

describe("stripThink", () => {
  it("移除思考块", () => {
    expect(stripThink("a<think>secret\nlines</think>b")).toBe("ab")
  })

  it("没有思考块时原样返回（去空）", () => {
    expect(stripThink("  提交信息  ")).toBe("提交信息")
  })
})

describe("buildPrompt", () => {
  it("自定义提示词优先", () => {
    expect(buildPrompt({ ...CFG, prompt: "只输出一句话" })).toBe("只输出一句话")
  })

  it("默认按语言生成", () => {
    expect(buildPrompt(CFG)).toContain("中文")
  })

  it("未配置语言时默认中文", () => {
    expect(buildPrompt({ prompt: "", language: "" })).toContain("中文")
  })
})

describe("generateCommitMessage", () => {
  it("POST 到 chat/completions 并返回去空内容", async () => {
    const { calls, fetchImpl } = fakeFetch({ choices: [{ message: { content: " 修复登录bug " } }] })
    const result = await generateCommitMessage("diff text", CFG, { fetchImpl })
    expect(result).toBe("修复登录bug")
    expect(calls[0].url).toBe("http://localhost:11434/v1/chat/completions")
    expect((calls[0].init.headers as Record<string, string>)["Authorization"]).toBe("Bearer ollama")
    expect(body(calls[0])["model"]).toBe("qwen2.5-coder:7b")
    expect(body(calls[0])["stream"]).toBe(false)
    expect(body(calls[0])["max_tokens"]).toBe(8192)
  })

  it("把 diff 放进 user 消息、提示词放进 system 消息", async () => {
    const { calls, fetchImpl } = fakeFetch({ choices: [{ message: { content: "ok" } }] })
    await generateCommitMessage("diff text", CFG, { fetchImpl })
    const messages = body(calls[0])["messages"] as { role: string; content: string }[]
    expect(messages[0]).toEqual({ role: "system", content: buildPrompt(CFG) })
    expect(messages[1]).toEqual({ role: "user", content: "diff text" })
  })

  it("剥离响应里的 <think>", async () => {
    const { fetchImpl } = fakeFetch({ choices: [{ message: { content: "<think>x</think>真正内容" } }] })
    expect(await generateCommitMessage("d", CFG, { fetchImpl })).toBe("真正内容")
  })

  it("未配置 max_tokens 时不带该字段", async () => {
    const { calls, fetchImpl } = fakeFetch({ choices: [{ message: { content: "ok" } }] })
    await generateCommitMessage("d", { ...CFG, max_tokens: 0 }, { fetchImpl })
    expect("max_tokens" in body(calls[0])).toBe(false)
  })

  it("HTTP 错误抛出含状态码的 AIError", async () => {
    const { fetchImpl } = fakeFetch(undefined, 500, "boom")
    await expect(generateCommitMessage("d", CFG, { fetchImpl })).rejects.toThrow(/500/)
  })

  it("HTTP 错误信息带上响应正文（截断 500 字）", async () => {
    const long = "x".repeat(900)
    const { fetchImpl } = fakeFetch(undefined, 400, long)
    await expect(generateCommitMessage("d", CFG, { fetchImpl })).rejects.toThrow(new RegExp(`400：x{500}$`))
  })

  it("choices 为空抛 AIError", async () => {
    const { fetchImpl } = fakeFetch({ choices: [] })
    await expect(generateCommitMessage("d", CFG, { fetchImpl })).rejects.toBeInstanceOf(AIError)
  })

  it("响应不是合法 JSON 抛 AIError", async () => {
    const { fetchImpl } = fakeFetch(undefined, 200, "")
    await expect(generateCommitMessage("d", CFG, { fetchImpl })).rejects.toThrow("AI 返回的不是合法 JSON")
  })

  it("未配置 url 抛 AIError", async () => {
    await expect(generateCommitMessage("d", { ...CFG, url: "" })).rejects.toThrow("未配置 api.url，请先填写配置文件")
  })

  it("网络异常包装为「AI 请求失败：」", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED")
    }
    await expect(generateCommitMessage("d", CFG, { fetchImpl })).rejects.toThrow(/^AI 请求失败：/)
  })

  it("优先展示 fetch 的 cause（否则用户只看到 fetch failed）", async () => {
    const fetchImpl = async () => {
      throw Object.assign(new Error("fetch failed"), {
        cause: new Error("connect ECONNREFUSED 127.0.0.1:9"),
      })
    }
    await expect(generateCommitMessage("d", CFG, { fetchImpl })).rejects.toThrow(
      "AI 请求失败：connect ECONNREFUSED 127.0.0.1:9",
    )
  })

  it("内容为空抛 AIError", async () => {
    const { fetchImpl } = fakeFetch({ choices: [{ message: { content: "   " } }] })
    await expect(generateCommitMessage("d", CFG, { fetchImpl })).rejects.toThrow("AI 未返回有效内容")
  })

  it("AbortSignal 中止时抛 AI 请求失败", async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
    }
    await expect(
      generateCommitMessage("d", CFG, { fetchImpl, signal: controller.signal }),
    ).rejects.toThrow(/^AI 请求失败：/)
  })

  it("url 末尾斜杠被去掉", async () => {
    const { calls, fetchImpl } = fakeFetch({ choices: [{ message: { content: "ok" } }] })
    await generateCommitMessage("d", { ...CFG, url: "http://x/v1/" }, { fetchImpl })
    expect(calls[0].url).toBe("http://x/v1/chat/completions")
  })
})
