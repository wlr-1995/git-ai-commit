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

  it("默认提示词规定 Conventional Commits、长度上限与可用 type", () => {
    const prompt = buildPrompt(CFG)
    expect(prompt).toContain("Conventional Commits")
    expect(prompt).toContain("<type>(<范围>): <描述>")
    expect(prompt).toContain("50 个字符")
    for (const type of ["feat", "fix", "refactor", "chore", "revert"]) {
      expect(prompt).toContain(type)
    }
  })

  it("默认提示词交代了 diff 的工具语义（### 说明行与截断）", () => {
    const prompt = buildPrompt(CFG)
    expect(prompt).toContain("### ")
    expect(prompt).toContain("截断")
    expect(prompt).toContain("不要编造")
  })

  it("语言配置生效（描述语言跟随配置）", () => {
    expect(buildPrompt({ prompt: "", language: "English" })).toContain("描述用English")
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
    expect(body(calls[0])["stream"]).toBe(true)
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

  it("中止时抛 reason 为 aborted 的 AIError（上层据此不弹错误框）", async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
    }
    await expect(generateCommitMessage("d", CFG, { fetchImpl, signal: controller.signal })).rejects.toMatchObject({
      reason: "aborted",
    })
  })

  it("url 末尾斜杠被去掉", async () => {
    const { calls, fetchImpl } = fakeFetch({ choices: [{ message: { content: "ok" } }] })
    await generateCommitMessage("d", { ...CFG, url: "http://x/v1/" }, { fetchImpl })
    expect(calls[0].url).toBe("http://x/v1/chat/completions")
  })

  it("SSE：把思考与正文各自回调，返回值是正文累积", async () => {
    const deltas: { kind: string; text: string }[] = []
    const sse = [
      'data: {"choices":[{"delta":{"reasoning_content":"先看 diff。"}}]}',
      'data: {"choices":[{"delta":{"content":"feat: 加"}}]}',
      'data: {"choices":[{"delta":{"content":"流式"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n")
    const fetchImpl = async () => ({
      status: 200,
      headers: { get: () => "text/event-stream" },
      text: async () => sse,
      json: async () => {
        throw new Error("不该走 JSON")
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse))
          controller.close()
        },
      }),
    })

    const result = await generateCommitMessage("d", CFG, { fetchImpl, onDelta: (delta) => deltas.push(delta) })
    expect(result).toBe("feat: 加流式")
    expect(deltas).toEqual([
      { kind: "thinking", text: "先看 diff。" },
      { kind: "text", text: "feat: 加" },
      { kind: "text", text: "流式" },
    ])
  })

  it("SSE：内联 <think> 被分流到思考（含标签跨 chunk）", async () => {
    const deltas: { kind: string; text: string }[] = []
    const sse = [
      'data: {"choices":[{"delta":{"content":"<thi"}}]}',
      'data: {"choices":[{"delta":{"content":"nk>想完了</think>fix: 好"}}]}',
      "data: [DONE]",
      "",
    ].join("\n\n")
    const fetchImpl = async () => ({
      status: 200,
      headers: { get: () => "text/event-stream" },
      text: async () => sse,
      json: async () => {
        throw new Error("不该走 JSON")
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse))
          controller.close()
        },
      }),
    })

    const result = await generateCommitMessage("d", CFG, { fetchImpl, onDelta: (delta) => deltas.push(delta) })
    expect(result).toBe("fix: 好")
    expect(deltas.filter((item) => item.kind === "thinking").map((item) => item.text).join("")).toBe("想完了")
  })

  it("SSE：坏 JSON chunk 被跳过，不影响后续", async () => {
    const sse = [
      "data: {坏",
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      "data: [DONE]",
      "",
    ].join("\n\n")
    const fetchImpl = async () => ({
      status: 200,
      headers: { get: () => "text/event-stream" },
      text: async () => sse,
      json: async () => {
        throw new Error("不该走 JSON")
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse))
          controller.close()
        },
      }),
    })
    expect(await generateCommitMessage("d", CFG, { fetchImpl })).toBe("ok")
  })

  it("SSE：content-type 是 event-stream 但整段其实是 JSON 时兜底", async () => {
    const json = '{"choices":[{"message":{"content":"兜底成功"}}]}'
    const fetchImpl = async () => ({
      status: 200,
      headers: { get: () => "text/event-stream" },
      text: async () => json,
      json: async () => {
        throw new Error("不该走 JSON")
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(json))
          controller.close()
        },
      }),
    })
    expect(await generateCommitMessage("d", CFG, { fetchImpl })).toBe("兜底成功")
  })

  it("非流式响应里的 <think> 也作为思考回调（不再静默丢弃）", async () => {
    const deltas: { kind: string; text: string }[] = []
    const { fetchImpl } = fakeFetch({ choices: [{ message: { content: "<think>想了</think>feat: 好" } }] })
    const result = await generateCommitMessage("d", CFG, { fetchImpl, onDelta: (delta) => deltas.push(delta) })
    expect(result).toBe("feat: 好")
    expect(deltas).toEqual([
      { kind: "thinking", text: "想了" },
      { kind: "text", text: "feat: 好" },
    ])
  })

  it("finish_reason 为 length 时通过 onFinish 回报", async () => {
    const { fetchImpl } = fakeFetch({ choices: [{ message: { content: "半截" }, finish_reason: "length" }] })
    let reason: string | null | undefined
    await generateCommitMessage("d", CFG, { fetchImpl, onFinish: (info) => { reason = info.finishReason } })
    expect(reason).toBe("length")
  })

  it("空闲超时：一段时间没有数据就中止并抛 reason 为 timeout", async () => {
    const fetchImpl = async () => ({
      status: 200,
      headers: { get: () => "text/event-stream" },
      text: async () => "",
      json: async () => {
        throw new Error("不该走 JSON")
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'))
          // 之后一直不给数据
          void controller
        },
      }),
    })
    await expect(
      generateCommitMessage("d", CFG, { fetchImpl, idleTimeoutMs: 30 }),
    ).rejects.toMatchObject({ reason: "timeout" })
  })
})
