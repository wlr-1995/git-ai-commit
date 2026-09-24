# 流式显示 AI 思考 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点「AI 生成」后，模型的思考实时滚进输入框下方一块可折叠的「AI 思考」区、正文实时落进提交信息输入框（打字机效果）。

**Architecture:** `core` 三块新/改：`sse.ts` 把 SSE 字节流解成 `data:` 事件；`think.ts` 是一个增量状态机，把正文里的 `<think>…</think>` 实时分流成「思考 / 正文」（跨 chunk 不吞字、不漏标签）；`ai.ts` 发 `stream: true`、用空闲超时、把 `delta.reasoning_content|reasoning|content` 路由成 `onDelta({kind,text})` 回调，并把「非流式 JSON」当回退路径。主进程把每次 `onDelta` 用新通道 `ai:delta` 推给渲染层；渲染层用一个纯函数 `applyAiDelta` 累积到 `state.thinking` / `state.message` 后重绘。

**Tech Stack:** Electron 44 + TypeScript 7 + vitest 5（单测）+ Playwright `_electron`（E2E）。沿用现有 `runGit`、`Result<T>`/`ErrorCode`、`CHANNELS`/`IpcApi`、`FetchLike` 注入点、`tests/helpers/repo.ts`。

## Global Constraints

- 平台仅 Windows；界面与提示文案一律中文。
- `src/core/**` 不得 import electron；不得 import `src/renderer/**`；可以 import `src/shared/**`。
- **核心逻辑零运行时依赖**：SSE 解析手写，不许引 `eventsource-parser` 之类的库。
- 渲染层无 Node：思考/正文都只能是字符串，经 `textContent` / `textarea.value` 写入（绝不用 `innerHTML`）。
- IPC 一律 `Result<T>` 判别联合，**不跨进程抛异常**；新通道要同时改 `shared/ipc.ts`（`CHANNELS` + `IpcApi`）+ `preload/index.ts` 的唯一实现（**接口与实现必须同一次提交**，否则会留下 typecheck 过不了的提交）。
- 思考内容**绝不**进入提交信息输入框，也绝不被提交；只在内存与界面，不落盘。
- 代码注释用中文，只在「为什么」不明显处写。
- 测试命令：`npx vitest run tests/core/<file>.test.ts`（单测）、`npm run e2e`（E2E）、`npm run typecheck`、`npm run coverage`。
- 提交信息用 Conventional Commits（本仓库风格：`feat(core): …` / `feat(ui): …`）。
- 覆盖率门：`src/core/**` **聚合**行覆盖 ≥ 90%（`vitest.config.ts`），新文件会被计入。

### 与 spec 的差异（本计划已定，Task 10 回填 spec）

1. `readSseStream(body, onData, { onActivity?, signal? })` 返回 `{ dataEvents: number; raw: string }`，**不做 JSON 解析**（坏 chunk 的计数与跳过留在 `ai.ts`）—— 让 SSE 层只管切帧；`signal` 中止时取消读流，空闲超时才能收尾。
2. 「非流式」判定用 `Content-Type` 含 `application/json` **或**响应没有 `body`；`event-stream` 但在整条流里一个 `data:` 都没收到时，把累积的 `raw` 当 JSON 再试一次（兜底）。
3. `finish_reason` 通过 `GenerateOptions.onFinish` 回报，**返回值仍是 `string`**（不动既有 ~10 处断言）。
4. `AiConfig.enable_thinking` 是**可选**字段（既有单测的最小配置不用改）；`AppConfig.api.enable_thinking` 才是必填、有默认值。

### 需要一起改的既有测试（会被新行为打破）

| 文件 | 位置 | 原因 |
|---|---|---|
| `tests/core/ai.test.ts` | `:88` | 断言 `stream` 为 `false` → 现在是 `true` |
| `tests/core/ai.test.ts` | `:159-168` | 中止现在抛「已取消」且 `reason === "aborted"` |
| `tests/renderer/settings.test.ts` | `:30-44` | `api` 是 `toEqual` 精确匹配，多了 `enable_thinking` |
| `tests/e2e/app.spec.ts` | `:212`（③） | 假服务改成 SSE，思考改为进思考区 |

---

### Task 1: `core/sse.ts` —— SSE 字节流 → `data:` 事件

**Files:**
- Create: `src/core/sse.ts`
- Test: `tests/core/sse.test.ts`

**Interfaces:**
- Produces:
  - `readSseStream(body: ReadableStream<Uint8Array>, onData: (data: string) => void, options?: { onActivity?: () => void; signal?: AbortSignal }): Promise<SseReadResult>`
  - `interface SseReadResult { dataEvents: number; raw: string }`
  - （Task 3 消费它；`onActivity` 用于空闲超时计时，`signal` 中止时取消读流，`raw` 用于「event-stream 其实是 JSON」兜底）

- [ ] **Step 1: 写失败测试**

创建 `tests/core/sse.test.ts`：

```ts
import { describe, expect, it } from "vitest"

import { readSseStream } from "../../src/core/sse"

/** 把字节按固定大小切片喂成可读流（size=1 时每个字节一个 chunk）。 */
function chunked(bytes: Buffer, size: number): ReadableStream<Uint8Array> {
  const parts: Uint8Array[] = []
  for (let index = 0; index < bytes.length; index += size) {
    parts.push(new Uint8Array(bytes.subarray(index, index + size)))
  }
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
}

/** 按非均匀切点切片（切点即切在哪两个字节之间）。 */
function splitAt(bytes: Buffer, cuts: number[]): ReadableStream<Uint8Array> {
  const bounds = [0, ...cuts, bytes.length]
  const parts: Uint8Array[] = []
  for (let index = 0; index < bounds.length - 1; index += 1) {
    parts.push(new Uint8Array(bytes.subarray(bounds[index], bounds[index + 1])))
  }
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<{ events: string[]; activity: number }> {
  const events: string[] = []
  let activity = 0
  await readSseStream(stream, (data) => events.push(data), { onActivity: () => { activity += 1 } })
  return { events, activity }
}

describe("readSseStream", () => {
  it("取 data: 载荷，忽略空行、注释与其它字段；[DONE] 结束", async () => {
    const text = [
      ": ping",
      "",
      'data: {"a":1}',
      "",
      "event: message",
      "id: 7",
      'data:{"a":2}',
      "",
      "data: [DONE]",
      "",
      'data: {"a":3}',
      "",
    ].join("\n")
    const { events } = await collect(chunked(Buffer.from(text, "utf8"), 4))
    expect(events).toEqual(['{"a":1}', '{"a":2}'])
  })

  it("中文跨 chunk 不被切坏（每个 chunk 大小都试一遍）", async () => {
    const text = 'data: {"content":"你好🚀世界"}\n\ndata: [DONE]\n\n'
    const bytes = Buffer.from(text, "utf8")
    for (let size = 1; size <= bytes.length; size += 1) {
      const { events } = await collect(chunked(bytes, size))
      expect(events).toEqual(['{"content":"你好🚀世界"}'])
    }
  })

  it("非均匀切点（切在 JSON 中间、切在标签中间）也一致", async () => {
    const bytes = Buffer.from('data: {"content":"a<think>b"}\r\n\r\ndata: [DONE]\r\n\r\n', "utf8")
    const reference = await collect(chunked(bytes, bytes.length))
    for (const cuts of [[1], [3, 9], [5, 6, 7], [bytes.length - 1]]) {
      const { events } = await collect(splitAt(bytes, cuts))
      expect(events).toEqual(reference.events)
    }
  })

  it("CRLF 行尾、结尾没有换行都能解析", async () => {
    const { events } = await collect(chunked(Buffer.from('data: {"a":1}\r\n\r\ndata: {"b":2}', "utf8"), 3))
    expect(events).toEqual(['{"a":1}', '{"b":2}'])
  })

  it("每个字节都算一次活动（空闲超时靠它重置）", async () => {
    const { activity } = await collect(chunked(Buffer.from('data: {"a":1}\n\n', "utf8"), 1))
    expect(activity).toBe(15)
  })

  it("返回累积原文，供「event-stream 其实是 JSON」兜底", async () => {
    const text = '{"choices":[{"message":{"content":"ok"}}]}'
    const result = await readSseStream(chunked(Buffer.from(text, "utf8"), 5), () => {})
    expect(result.dataEvents).toBe(0)
    expect(result.raw).toBe(text)
  })

  it("signal 中止时取消读流：许久的 read 不再挂住（空闲超时靠它收尾）", async () => {
    const controller = new AbortController()
    // 只给一块数据，之后永不结束
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'))
      },
    })
    const events: string[] = []
    const reading = readSseStream(stream, (data) => events.push(data), { signal: controller.signal })
    controller.abort()
    await expect(reading).resolves.toMatchObject({ dataEvents: 1 })
    expect(events).toEqual(['{"a":1}'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/sse.test.ts`
Expected: FAIL —— `Cannot find module '../../src/core/sse'`

- [ ] **Step 3: 实现 `src/core/sse.ts`**

```ts
/**
 * 极简 SSE 读取：把字节流按行切开，只取 `data:` 载荷。
 *
 * 手写而不引库：核心逻辑零运行时依赖是硬约束（见 README）。
 * 增量解码（TextDecoder 的 stream 选项）是必须的：一个中文字或 emoji
 * 被 chunk 从中间切开时，整块解码会得到 U+FFFD。
 */
export interface SseReadResult {
  /** 收到的 `data:` 事件数（`[DONE]` 不算） */
  dataEvents: number
  /** 累积的原文（供「content-type 说是 event-stream、其实是 JSON」兜底） */
  raw: string
}

export interface SseReadOptions {
  /** 每读到一块字节回调一次（空闲超时靠它重置计时） */
  onActivity?: () => void
  /** 中止时取消读流，让挂着的 read() 立刻收尾（否则空闲超时会一直等下去） */
  signal?: AbortSignal
}

export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
  options: SseReadOptions = {},
): Promise<SseReadResult> {
  const decoder = new TextDecoder("utf-8")
  const reader = body.getReader()
  let pending = ""
  let raw = ""
  let dataEvents = 0
  let stopped = false

  const onAbort = (): void => {
    void reader.cancel().catch(() => {})
  }
  options.signal?.addEventListener("abort", onAbort, { once: true })

  const handleLine = (rawLine: string): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    // 空行是事件边界；`:` 开头是注释/心跳；其余字段（event:/id:/retry:）一律忽略
    if (line === "" || line.startsWith(":")) return
    if (!line.startsWith("data:")) return
    const payload = line.slice(5).replace(/^ /, "")
    if (payload === "[DONE]") {
      stopped = true
      return
    }
    dataEvents += 1
    onData(payload)
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      raw += text
      pending += text
      options.onActivity?.()
      let index = pending.indexOf("\n")
      while (index >= 0 && !stopped) {
        handleLine(pending.slice(0, index))
        pending = pending.slice(index + 1)
        index = pending.indexOf("\n")
      }
      if (stopped) break
      if (options.signal?.aborted) break
    }
    // 流结束时把解码器与最后一行（可能没有换行）都冲刷掉
    const rest = decoder.decode()
    if (rest !== "") {
      raw += rest
      pending += rest
    }
    if (!stopped && pending !== "") handleLine(pending)
  } finally {
    options.signal?.removeEventListener("abort", onAbort)
  }

  return { dataEvents, raw }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core/sse.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/core/sse.ts tests/core/sse.test.ts
git commit -m "feat(core): parse SSE byte streams"
```

---

### Task 2: `core/think.ts` —— 增量思考分离器

**Files:**
- Create: `src/core/think.ts`
- Test: `tests/core/think.test.ts`

**Interfaces:**
- Produces:
  - `interface ThinkParts { thinking: string; text: string }`
  - `class ThinkSplitter { push(chunk: string): ThinkParts; flush(): ThinkParts }`
  - `createThinkSplitter(): ThinkSplitter`
  - （Task 3 每请求 new 一个，`push` 喂 `delta.content`，流结束 `flush`）

- [ ] **Step 1: 写失败测试**

创建 `tests/core/think.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/think.test.ts`
Expected: FAIL —— `Cannot find module '../../src/core/think'`

- [ ] **Step 3: 实现 `src/core/think.ts`**

```ts
export interface ThinkParts {
  thinking: string
  text: string
}

const OPEN = "<think>"
const CLOSE = "</think>"

/**
 * 增量分离 `<think>…</think>`。
 *
 * 难点全在 chunk 边界：`<thi` 既不能当正文吐（下一块可能就是 `nk>`），
 * 也不能直接咽掉（万一下一块是 `x`，它就是普通文本）。所以维护一个
 * 「未决前缀」缓冲，只有确定不是标签开头才归正文 —— 任何输入都不吞字。
 *
 * 思考态里不处理嵌套：只找 `</think>`，其间出现的 `<think>` 算思考文本。
 */
export class ThinkSplitter {
  private inThinking = false
  private pending = ""

  push(chunk: string): ThinkParts {
    const out: ThinkParts = { thinking: "", text: "" }
    let buffer = this.pending + chunk
    this.pending = ""

    for (;;) {
      const tag = this.inThinking ? CLOSE : OPEN
      const index = buffer.indexOf(tag)
      if (index >= 0) {
        this.append(out, buffer.slice(0, index))
        buffer = buffer.slice(index + tag.length)
        this.inThinking = !this.inThinking
        if (buffer === "") break
        continue
      }
      // 没有完整标签：把「可能是标签开头」的尾巴留到下一块
      const keep = pendingPrefixLength(buffer, tag)
      this.append(out, buffer.slice(0, buffer.length - keep))
      this.pending = keep > 0 ? buffer.slice(buffer.length - keep) : ""
      break
    }
    return out
  }

  flush(): ThinkParts {
    const out: ThinkParts = { thinking: "", text: "" }
    this.append(out, this.pending)
    this.pending = ""
    return out
  }

  private append(out: ThinkParts, text: string): void {
    if (text === "") return
    if (this.inThinking) out.thinking += text
    else out.text += text
  }
}

/** buffer 结尾有多长的一段「tag 的真前缀」（不含 tag 本身），这段要留在 pending。 */
function pendingPrefixLength(buffer: string, tag: string): number {
  const max = Math.min(tag.length - 1, buffer.length)
  for (let length = max; length > 0; length -= 1) {
    if (buffer.endsWith(tag.slice(0, length))) return length
  }
  return 0
}

export function createThinkSplitter(): ThinkSplitter {
  return new ThinkSplitter()
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core/think.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/core/think.ts tests/core/think.test.ts
git commit -m "feat(core): incremental think-tag splitter"
```

---

### Task 3: `core/ai.ts` —— 流式请求 + delta 路由 + 空闲超时

**Files:**
- Modify: `src/core/ai.ts`（`AIError`、`AiConfig`、`FetchLike`、`GenerateOptions`、`generateCommitMessage`）
- Test: `tests/core/ai.test.ts`（改 2 处既有断言 + 追加流式用例）

**Interfaces:**
- Consumes: Task 1 的 `readSseStream`、Task 2 的 `ThinkSplitter`
- Produces:
  - `export type AiErrorReason = "aborted" | "timeout" | "http" | "bad_response" | "network"`
  - `export class AIError extends Error { readonly reason: AiErrorReason }`（构造第二参默认 `"bad_response"`）
  - `export interface AiDelta { kind: "thinking" | "text"; text: string }`
  - `export interface FetchResponseLike { status: number; headers?: { get(name: string): string | null } | null; text(): Promise<string>; json(): Promise<unknown>; body?: ReadableStream<Uint8Array> | null }`
  - `export type FetchLike = (url: string, init: RequestInit) => Promise<FetchResponseLike>`
  - `export interface GenerateOptions { signal?; fetchImpl?; onDelta?: (delta: AiDelta) => void; onFinish?: (info: { finishReason: string | null }) => void; idleTimeoutMs?: number }`
  - `generateCommitMessage(diffText, cfg, options?): Promise<string>`（**返回类型不变**）

- [ ] **Step 1: 改既有断言 + 追加失败测试**

`tests/core/ai.test.ts`：

1. `:88` 改成 `expect(body(calls[0])["stream"]).toBe(true)`。
2. `:159-168` 的「AbortSignal 中止时抛 AI 请求失败」整条替换为：

```ts
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
```

3. 文件末尾（`describe("generateCommitMessage")` 内部）追加：

```ts
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
```

> 最后一条依赖真实的 30ms 定时器（不用假定时器，避免与 `AbortSignal.any` 交互出坑）；最长 30ms，不影响测试时长。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/ai.test.ts`
Expected: FAIL —— `result.reason` 是 `undefined`、`Cannot find module '../../src/core/sse'` 等

- [ ] **Step 3: 实现 `src/core/ai.ts`**

顶部 import：

```ts
import { readSseStream } from "./sse"
import { ThinkSplitter, type ThinkParts } from "./think"
```

`AIError` 与其后新增类型（替换原第 1-21 行的 `AIError` 与 `FetchLike`）：

```ts
export type AiErrorReason = "aborted" | "timeout" | "http" | "bad_response" | "network"

export class AIError extends Error {
  readonly reason: AiErrorReason

  constructor(message: string, reason: AiErrorReason = "bad_response") {
    super(message)
    this.name = "AIError"
    this.reason = reason
  }
}

/** 流式增量：思考与正文本就是两条流，用 kind 分开（渲染层各自累积）。 */
export interface AiDelta {
  kind: "thinking" | "text"
  text: string
}

/**
 * 只声明用得到的部分；`body` 缺失即视为「非流式」——
 * 既有单测的假 fetch 不提供 body，因此天然走 JSON 分支。
 */
export interface FetchResponseLike {
  status: number
  headers?: { get(name: string): string | null } | null
  text(): Promise<string>
  json(): Promise<unknown>
  body?: ReadableStream<Uint8Array> | null
}

export type FetchLike = (url: string, init: RequestInit) => Promise<FetchResponseLike>
```

`AiConfig` 追加一个可选字段（Task 4 才用到，先声明以便同文件改动一次到底）：

```ts
  /** 是否随请求发 chat_template_kwargs.enable_thinking（可选，缺省不发） */
  enable_thinking?: boolean
```

`GenerateOptions` 替换为：

```ts
export interface GenerateOptions {
  signal?: AbortSignal
  fetchImpl?: FetchLike
  onDelta?: (delta: AiDelta) => void
  /** 流结束时的元信息（返回值保持 string，既有调用方不用动） */
  onFinish?: (info: { finishReason: string | null }) => void
  /** 空闲超时（毫秒）：超过这么久没收到任何字节才算超时；默认用 cfg.timeout 秒 */
  idleTimeoutMs?: number
}
```

`generateCommitMessage` 整体替换为：

```ts
interface StreamState {
  text: string
  thinking: string
  finishReason: string | null
}

function firstString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "string" && value !== "") return value
  }
  return ""
}

/** 调用 {url}/chat/completions 生成提交信息（流式；服务端不支持时自动按整体 JSON 处理）。 */
export async function generateCommitMessage(
  diffText: string,
  cfg: AiConfig,
  options: GenerateOptions = {},
): Promise<string> {
  const url = (cfg.url || "").trim().replace(/\/+$/, "")
  if (!url) throw new AIError("未配置 api.url，请先填写配置文件")

  const payload: Record<string, unknown> = {
    model: cfg.model || "",
    messages: [
      { role: "system", content: buildPrompt(cfg) },
      { role: "user", content: diffText },
    ],
    stream: true,
  }
  const maxTokens = cfg.max_tokens || 0
  if (maxTokens > 0) payload.max_tokens = maxTokens

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.api_key || ""}`,
  }

  // 空闲超时：AbortSignal.timeout 是「总时长」，会把长思考截死在半路，所以自己计时
  const idleMs = options.idleTimeoutMs ?? (cfg.timeout ?? 60) * 1000
  const idleText = `AI 请求超时：${Math.round(idleMs / 1000)} 秒内没有收到任何数据`
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const armIdle = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, idleMs)
  }
  const stopIdle = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const signals: AbortSignal[] = [controller.signal]
  if (options.signal) signals.push(options.signal)

  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init))
  armIdle()

  let response: FetchResponseLike
  try {
    response = await fetchImpl(`${url}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.any(signals),
    })
  } catch (error) {
    stopIdle()
    if (timedOut) throw new AIError(idleText, "timeout")
    if (options.signal?.aborted) throw new AIError("已取消", "aborted")
    // Node 的 fetch 只抛 "fetch failed"，真正的原因（ECONNREFUSED 等）在 cause 里
    const cause = (error as { cause?: { message?: string } }).cause?.message
    const message = cause ?? (error instanceof Error ? error.message : String(error))
    throw new AIError(`AI 请求失败：${message}`, "network")
  }

  if (response.status !== 200) {
    stopIdle()
    const text = await response.text()
    throw new AIError(`AI 返回 ${response.status}：${text.slice(0, 500)}`, "http")
  }

  const state: StreamState = { text: "", thinking: "", finishReason: null }
  const splitter = new ThinkSplitter()
  const emit = (kind: AiDelta["kind"], text: string): void => {
    if (text === "") return
    options.onDelta?.({ kind, text })
  }
  const routeChoice = (choice: unknown): void => {
    if (!choice || typeof choice !== "object") return
    const item = choice as {
      delta?: Record<string, unknown>
      message?: Record<string, unknown>
      finish_reason?: string | null
    }
    const piece = item.delta ?? item.message
    if (piece) {
      const reasoning = firstString(piece, ["reasoning_content", "reasoning"])
      if (reasoning !== "") {
        state.thinking += reasoning
        emit("thinking", reasoning)
      }
      const content = firstString(piece, ["content"])
      if (content !== "") {
        const parts: ThinkParts = splitter.push(content)
        if (parts.thinking !== "") {
          state.thinking += parts.thinking
          emit("thinking", parts.thinking)
        }
        if (parts.text !== "") {
          state.text += parts.text
          emit("text", parts.text)
        }
      }
    }
    if (typeof item.finish_reason === "string") state.finishReason = item.finish_reason
  }
  const routeJson = (data: unknown): void => {
    const choices = (data as { choices?: unknown } | null)?.choices
    if (!Array.isArray(choices) || choices.length === 0) throw new AIError("AI 返回缺少 choices")
    for (const choice of choices) routeChoice(choice)
  }
  const parseJson = (text: string): unknown => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new AIError("AI 返回的不是合法 JSON")
    }
  }
  const readJson = async (): Promise<unknown> => {
    try {
      return await response.json()
    } catch {
      throw new AIError("AI 返回的不是合法 JSON")
    }
  }
  const onData = (data: string): void => {
    let event: unknown
    try {
      event = JSON.parse(data) as unknown
    } catch {
      // 心跳/杂质：跳过，别为一条坏帧废掉整条流
      return
    }
    const choices = (event as { choices?: unknown } | null)?.choices
    if (!Array.isArray(choices)) return
    for (const choice of choices) routeChoice(choice)
  }

  const contentType = response.headers?.get("content-type") ?? ""
  const usesJson = /application\/json/i.test(contentType) || !response.body

  try {
    if (usesJson) {
      routeJson(await readJson())
    } else {
      const { dataEvents, raw } = await readSseStream(
        response.body as ReadableStream<Uint8Array>,
        onData,
        { onActivity: armIdle, signal: controller.signal },
      )
      // 服务端把 content-type 写成 event-stream、其实整段是 JSON
      if (dataEvents === 0) routeJson(parseJson(raw))
    }
  } catch (error) {
    stopIdle()
    if (timedOut) throw new AIError(idleText, "timeout")
    if (options.signal?.aborted) throw new AIError("已取消", "aborted")
    if (error instanceof AIError) throw error
    throw new AIError(`AI 请求失败：${error instanceof Error ? error.message : String(error)}`, "network")
  }
  stopIdle()
  // 读流被取消（空闲超时）时 read() 是正常收尾而不是抛错，所以这里再确认一次
  if (timedOut) throw new AIError(idleText, "timeout")

  // 收尾：未决前缀按当前状态归还，避免吞字
  const tail = splitter.flush()
  if (tail.thinking !== "") {
    state.thinking += tail.thinking
    emit("thinking", tail.thinking)
  }
  if (tail.text !== "") {
    state.text += tail.text
    emit("text", tail.text)
  }

  options.onFinish?.({ finishReason: state.finishReason })

  const content = state.text.trim()
  if (!content) throw new AIError("AI 未返回有效内容")
  return content
}
```

`stripThink` 与其正则**保留不动**（非流式兜底与既有测试仍用它）。

- [ ] **Step 4: 跑测试确认通过（含既有用例不回归）**

Run: `npx vitest run tests/core/ai.test.ts`
Expected: PASS（既有 19 条 + 新增 8 条）

- [ ] **Step 5: 提交**

```bash
git add src/core/ai.ts tests/core/ai.test.ts
git commit -m "feat(core): stream chat completions with idle timeout"
```

---

### Task 4: 配置 `api.enable_thinking` + 请求体

**Files:**
- Modify: `src/core/types.ts`（`AppConfig.api`）、`src/core/config.ts`（`DEFAULT_CONFIG`）
- Modify: `src/core/ai.ts`（请求体按 `cfg.enable_thinking` 决定是否带 `chat_template_kwargs`）
- Test: `tests/core/config.test.ts`、`tests/core/ai.test.ts`（各追加）

**Interfaces:**
- Produces: `AppConfig.api.enable_thinking: boolean`（默认 `false`）；请求体在开启时带 `chat_template_kwargs: { enable_thinking: true }`

- [ ] **Step 1: 写失败测试**

追加到 `tests/core/config.test.ts`：

```ts
it("默认配置里 enable_thinking 为 false（不发专属参数）", () => {
  expect(DEFAULT_CONFIG.api.enable_thinking).toBe(false)
})

it("旧配置文件没有该键时回落 false", () => {
  const cfgFile = join(makeTempDir(), "config.json")
  writeFileSync(cfgFile, JSON.stringify({ api: { url: "http://x/v1" } }), "utf8")
  expect(loadConfig(cfgFile).api.enable_thinking).toBe(false)
})

it("enable_thinking 能被读回", () => {
  const cfgFile = join(makeTempDir(), "config.json")
  writeFileSync(cfgFile, JSON.stringify({ api: { enable_thinking: true } }), "utf8")
  expect(loadConfig(cfgFile).api.enable_thinking).toBe(true)
})
```

（`DEFAULT_CONFIG` / `makeTempDir` / `loadConfig` 若不在 import 里，按该文件现有风格补齐。）

追加到 `tests/core/ai.test.ts` 的 `describe("generateCommitMessage")`：

```ts
  it("enable_thinking 为 true 时带 chat_template_kwargs，false/缺省时不带", async () => {
    const enabled = fakeFetch({ choices: [{ message: { content: "ok" } }] })
    await generateCommitMessage("d", { ...CFG, enable_thinking: true }, { fetchImpl: enabled.fetchImpl })
    expect(body(enabled.calls[0])["chat_template_kwargs"]).toEqual({ enable_thinking: true })

    const disabled = fakeFetch({ choices: [{ message: { content: "ok" } }] })
    await generateCommitMessage("d", CFG, { fetchImpl: disabled.fetchImpl })
    expect("chat_template_kwargs" in body(disabled.calls[0])).toBe(false)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/config.test.ts tests/core/ai.test.ts`
Expected: FAIL —— `DEFAULT_CONFIG.api.enable_thinking` 是 `undefined`；`chat_template_kwargs` 不存在

- [ ] **Step 3: 实现**

`src/core/types.ts` 的 `AppConfig.api` 追加一行：

```ts
  api: {
    url: string
    api_key: string
    model: string
    prompt: string
    max_tokens: number
    language: string
    timeout: number
    /** 是否随请求发 chat_template_kwargs.enable_thinking（Qwen3 在 SGLang 上有时需要） */
    enable_thinking: boolean
  }
```

`src/core/config.ts` 的 `DEFAULT_CONFIG.api` 追加一行（放在 `timeout` 之后）：

```ts
    timeout: 60,
    enable_thinking: false,
```

`src/core/ai.ts` 的 payload 之后追加（紧跟 `if (maxTokens > 0) payload.max_tokens = maxTokens`）：

```ts
  // 服务端专属参数默认一个都不发（严格实现会因未知字段 400），只在用户显式开启时才带
  if (cfg.enable_thinking) payload.chat_template_kwargs = { enable_thinking: true }
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/core/config.test.ts tests/core/ai.test.ts && npm run typecheck`
Expected: PASS 且 typecheck 干净

- [ ] **Step 5: 提交**

```bash
git add src/core/types.ts src/core/config.ts src/core/ai.ts tests/core/config.test.ts tests/core/ai.test.ts
git commit -m "feat(config): optional api.enable_thinking"
```

---

### Task 5: IPC 接线（`ai:delta` 推送 + 取消语义）

**Files:**
- Modify: `src/shared/ipc.ts`（`CHANNELS.aiDelta`、`AiDelta` re-export、`IpcApi.aiGenerate` 返回体、`IpcApi.onAiDelta`）
- Modify: `src/preload/index.ts`（**与接口同一次提交**）
- Modify: `src/core/types.ts`（`ErrorCode` 加 `AI_CANCELLED`）
- Modify: `src/core/errors.ts`（`aborted` → `AI_CANCELLED`）
- Modify: `src/main/ipc.ts`（接线 `onDelta` / `onFinish`）
- Test: `tests/core/errors.test.ts`（追加）

**Interfaces:**
- Consumes: Task 3 的 `AIError.reason` / `AiDelta` / `onFinish`；Task 4 的 `api.enable_thinking`
- Produces:
  - `CHANNELS.aiDelta = "ai:delta"`
  - `IpcApi.aiGenerate(paths): Promise<Result<{ message: string; truncated: boolean }>>`
  - `IpcApi.onAiDelta(cb: (delta: AiDelta) => void): void`
  - `ErrorCode` 新增 `"AI_CANCELLED"`

- [ ] **Step 1: 写失败测试**

追加到 `tests/core/errors.test.ts`：

```ts
  it("用户取消 → AI_CANCELLED（渲染层据此不弹错误框）", () => {
    const mapped = toError(new AIError("已取消", "aborted"))
    expect(mapped.code).toBe("AI_CANCELLED")
    expect(mapped.message).toBe("已取消")
  })

  it("AI 超时不回归成取消（仍是可弹框的错误）", () => {
    expect(toError(new AIError("AI 请求超时：60 秒内没有收到任何数据", "timeout")).code).toBe("AI_BAD_RESPONSE")
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/errors.test.ts`
Expected: FAIL —— `code` 是 `"AI_BAD_RESPONSE"`（还没按 reason 分流）

- [ ] **Step 3: 实现**

`src/core/types.ts` 的 `ErrorCode` 追加 `"AI_CANCELLED"`（放在 `"AI_BAD_RESPONSE"` 之后）：

```ts
  | "AI_BAD_RESPONSE"
  | "AI_CANCELLED"
```

`src/core/errors.ts` 的 `AIError` 分支最前面加一行：

```ts
  if (error instanceof AIError) {
    if (error.reason === "aborted") return { code: "AI_CANCELLED", message: error.message }
    if (error.message.includes("未配置 api.url")) return { code: "AI_NO_URL", message: error.message }
    if (/^AI 返回 \d+/.test(error.message)) return { code: "AI_HTTP", message: error.message }
    return { code: "AI_BAD_RESPONSE", message: error.message }
  }
```

`src/shared/ipc.ts`：

```ts
import type { DiffLine } from "../core/diff"
import type { AiDelta, AppConfig, RepoSnapshot, Result } from "../core/types"

export type { AiDelta, Result }
```

（注意 `AiDelta` 定义在 `src/core/ai.ts`；为不引入新循环，`src/core/types.ts` 里加一行 `export type { AiDelta } from "./ai"`，再由 `shared/ipc.ts` 从 `../core/types` 取。**按这个方式做**，不要直接从 `../core/ai` import 到 shared。）

`CHANNELS` 追加：

```ts
  aiGenerate: "ai:generate",
  aiDelta: "ai:delta",
  aiCancel: "ai:cancel",
```

`IpcApi` 的两处改动：

```ts
  aiGenerate(paths: string[]): Promise<Result<{ message: string; truncated: boolean }>>
  /** 主进程推来的流式增量；整程序只订阅一次，不提供取消订阅 */
  onAiDelta(cb: (delta: AiDelta) => void): void
```

`src/preload/index.ts` 的 `api` 对象：

```ts
  aiGenerate: (paths: string[]) => ipcRenderer.invoke(CHANNELS.aiGenerate, paths),
  onAiDelta: (cb) => {
    ipcRenderer.on(CHANNELS.aiDelta, (_event, delta) => cb(delta as AiDelta))
  },
```

import 增加 `type AiDelta`（`import { CHANNELS, type AiDelta, type IpcApi } from "../shared/ipc"`）。

`src/main/ipc.ts` 的 `aiGenerate` handler 替换为：

```ts
  handle(CHANNELS.aiGenerate, (rawPaths) =>
    guarded(async () => {
      const paths = toStringArray(rawPaths)
      if (paths.length === 0) throw new GitError("请先勾选至少一个文件")
      const config = loadConfig()
      if (!config.api.url.trim()) throw new AIError("未配置 api.url，请编辑配置文件后重试")
      const diffText = await diffFor(repoRoot, paths, config.git.max_diff_lines)
      if (!diffText.trim()) throw new AIError("勾选的文件没有可分析的改动")
      generation = new AbortController()
      let truncated = false
      try {
        const message = await generateCommitMessage(diffText, config.api, {
          signal: generation.signal,
          onDelta: (delta) => {
            if (!win.isDestroyed()) win.webContents.send(CHANNELS.aiDelta, delta)
          },
          onFinish: (info) => {
            truncated = info.finishReason === "length"
          },
        })
        return { message, truncated }
      } finally {
        generation = null
      }
    }),
  )
```

`src/main/ipc.ts` 的 import 增加 `AiDelta` 类型（用于 `onDelta` 参数标注则可省，能省就省，以 typecheck 为准）。

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/core/errors.test.ts && npm run typecheck`
Expected: PASS 且 typecheck 干净（若报 `Property 'onAiDelta' is missing`，说明 preload 没同步改）

- [ ] **Step 5: 提交**

```bash
git add src/core/types.ts src/core/errors.ts src/shared/ipc.ts src/preload/index.ts src/main/ipc.ts tests/core/errors.test.ts
git commit -m "feat(ipc): stream ai deltas to the renderer"
```

---

### Task 6: `renderer/state.ts` —— `thinking` 字段与 `applyAiDelta`

**Files:**
- Modify: `src/renderer/state.ts`（`UiState`、`applyAiDelta`）
- Test: `tests/renderer/state.test.ts`（追加）

**Interfaces:**
- Consumes: `AiDelta`（`../shared/ipc` 的 re-export）
- Produces:
  - `UiState.thinking: string`
  - `applyAiDelta(current: { thinking: string; message: string }, delta: AiDelta): { thinking: string; message: string }`（纯函数）

- [ ] **Step 1: 写失败测试**

追加到 `tests/renderer/state.test.ts`：

```ts
describe("applyAiDelta", () => {
  it("思考与正文各走各的，思考绝不进 message", () => {
    const first = applyAiDelta({ thinking: "", message: "" }, { kind: "thinking", text: "先看 diff。" })
    expect(first).toEqual({ thinking: "先看 diff。", message: "" })
    const second = applyAiDelta(first, { kind: "text", text: "feat: 好" })
    expect(second).toEqual({ thinking: "先看 diff。", message: "feat: 好" })
  })

  it("同种增量按到达顺序拼接", () => {
    let current = { thinking: "", message: "" }
    for (const delta of [
      { kind: "text" as const, text: "feat: " },
      { kind: "thinking" as const, text: "a" },
      { kind: "text" as const, text: "流式" },
      { kind: "thinking" as const, text: "b" },
    ]) {
      current = applyAiDelta(current, delta)
    }
    expect(current).toEqual({ thinking: "ab", message: "feat: 流式" })
  })
})
```

（`applyAiDelta` 若不在 import 里，补进 `../../src/renderer/state`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/renderer/state.test.ts -t "applyAiDelta"`
Expected: FAIL —— `applyAiDelta is not a function`

- [ ] **Step 3: 实现**

`src/renderer/state.ts`：import 补类型、`UiState` 加字段、文件末尾加函数：

```ts
import { ADDED, DELETED, MODIFIED, RENAMED, UNTRACKED, type FileChange } from "../shared/changes"
import type { AiDelta } from "../shared/ipc"
```

```ts
export interface UiState {
  branch: string
  changes: FileChange[]
  stats: Record<string, [number | null, number | null]>
  checked: Set<string>
  message: string
  /** AI 流式思考内容；空串表示没有（界面据此整块隐藏） */
  thinking: string
  showUntracked: boolean
  checkedByDefault: string
  busy: Busy
  selectedPath: string | null
}
```

```ts
/** 把一条流式增量并进当前内容（纯函数，便于单测）。 */
export function applyAiDelta(
  current: { thinking: string; message: string },
  delta: AiDelta,
): { thinking: string; message: string } {
  if (delta.kind === "thinking") return { ...current, thinking: current.thinking + delta.text }
  return { ...current, message: current.message + delta.text }
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/renderer/state.test.ts && npm run typecheck`
Expected: PASS；typecheck 会因 `main.ts` 的 `state` 字面量缺 `thinking` 报错 —— **这是预期的**，Task 7 补上；若想保持每一步都绿，可在本步先给 `main.ts` 的 `state` 加 `thinking: ""`（一行），Task 7 不再重复。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/state.ts tests/renderer/state.test.ts src/renderer/main.ts
git commit -m "feat(ui): accumulate streamed thinking in state"
```

---

### Task 7: 界面 —— 思考区、只读输入框、订阅增量

**Files:**
- Modify: `src/renderer/index.html`（`#thinking` 块）
- Modify: `src/renderer/render.ts`（`Elements`、`renderThinking`、`readOnly`）
- Modify: `src/renderer/main.ts`（elements 查找、`applyDelta`、订阅、`generate` 收尾、取消分支）
- Modify: `src/renderer/styles/tokens.css`、`src/renderer/styles/app.css`
- Test: 界面观感由 Task 9 的 E2E 与 `npm run shots` 截图人工确认（本任务不加单测）

**Interfaces:**
- Consumes: Task 5 的 `api.onAiDelta`、Task 6 的 `applyAiDelta` / `state.thinking`
- Produces: `Elements.thinking: HTMLDetailsElement`、`Elements.thinkingBody: HTMLElement`

- [ ] **Step 1: 加 HTML 结构**

`src/renderer/index.html` 的 `#message` 之后插入：

```html
          <details id="thinking" hidden>
            <summary>AI 思考</summary>
            <pre id="thinking-body"></pre>
          </details>
```

- [ ] **Step 2: 加主题变量与样式**

`src/renderer/styles/tokens.css` 的 `--diff-hunk-bg` 之后追加：

```css
  --thinking-bg: var(--surface-muted);
  --thinking-border: var(--border);
  --thinking-fg: var(--text-muted);
```

`src/renderer/styles/app.css` 的 `#message:focus,` 规则块之前插入（**不要给 `#thinking` 设 `display`**，否则 `hidden` 会被压住，得额外写 `[hidden]` 规则）：

```css
#thinking {
  border: 1px solid var(--thinking-border);
  border-radius: var(--radius);
  background: var(--thinking-bg);
}

#thinking > summary {
  padding: var(--space-xs) var(--space-sm);
  color: var(--text-muted);
  font-size: var(--font-size-small);
  cursor: pointer;
  user-select: none;
}

#thinking-body {
  margin: 0;
  padding: var(--space-sm);
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono);
  font-size: var(--font-size-small);
  color: var(--thinking-fg);
}
```

- [ ] **Step 3: `render.ts` 渲染思考区与只读态**

`Elements` 接口追加：

```ts
  thinking: HTMLDetailsElement
  thinkingBody: HTMLElement
```

`render()` 里，`if (elements.message.value !== state.message) …` 之后追加：

```ts
  // 生成期间输入框只读：正文是流式写入的，别让 paint 冲掉用户正在打的字
  elements.message.readOnly = state.busy === "generate"
  renderThinking(state, elements)
```

文件末尾（`renderDiff` 之后）追加：

```ts
function renderThinking(state: UiState, elements: Elements): void {
  const details = elements.thinking
  const body = elements.thinkingBody
  const wasHidden = details.hidden
  details.hidden = state.thinking === ""
  if (state.thinking === "") return

  // 用户翻到上面看的时候别把他拽回底部
  const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 24
  if (body.textContent !== state.thinking) body.textContent = state.thinking

  if (wasHidden) {
    // 思考第一次出现时展开（之后尊重用户手动收起）
    details.open = true
    body.scrollTop = body.scrollHeight
  } else if (state.busy === "generate" && stick) {
    body.scrollTop = body.scrollHeight
  }
}
```

- [ ] **Step 4: `main.ts` 接线**

`elements` 字面量追加：

```ts
  thinking: el<HTMLDetailsElement>("thinking"),
  thinkingBody: el("thinking-body"),
```

`state` 若 Task 6 没加，补 `thinking: ""`。

import 增加（`main.ts` 顶部已从 `../shared/ipc` 引类型）：

```ts
import type { AiDelta, DiffView, ThemeInfo } from "../shared/ipc"
import { applyAiDelta, applyFilter, checkedPaths, initialChecked, type FilterKind, type UiState } from "./state"
```

`generate()` 整体替换为：

```ts
async function generate(): Promise<void> {
  if (state.busy !== null) return
  const paths = checkedPaths(state)
  if (paths.length === 0) {
    showError("请先勾选至少一个文件")
    return
  }
  state.busy = "generate"
  state.thinking = ""
  paint()
  const result = await api.aiGenerate(paths)
  state.busy = null
  if (result.ok) {
    // 以核心返回的最终文本为准（与流式累积一致，顺便对齐首尾空白）
    state.message = result.value.message
    paint()
    setStatus(result.value.truncated ? "已生成（输出被 max_tokens 截断）" : "已生成，可编辑后提交")
  } else if (result.error.code === "AI_CANCELLED") {
    paint()
    setStatus("已取消（已保留已收到内容）")
  } else {
    paint()
    showError(result.error.message)
  }
}
```

`cancelGeneration()` 之后新增处理函数：

```ts
function applyDelta(delta: AiDelta): void {
  if (state.busy !== "generate") return
  const next = applyAiDelta(state, delta)
  state.thinking = next.thinking
  state.message = next.message
  paint()
}
```

`bind()` 的第一行加订阅：

```ts
  api.onAiDelta(applyDelta)
```

- [ ] **Step 5: 类型检查 + 抓图人工确认**

Run: `npm run typecheck && npm run build && npm run shots`
Expected: typecheck 干净；`%TEMP%\electron-shots\` 出现三张图。**看图确认**：思考区默认不出现（没有思考时不留空框）、`#thinking` 样式与整体间距（4/8/12 刻度）一致。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/index.html src/renderer/render.ts src/renderer/main.ts src/renderer/styles/tokens.css src/renderer/styles/app.css
git commit -m "feat(ui): thinking panel and read-only input while generating"
```

---

### Task 8: 设置弹层加「启用思考模式」复选框

**Files:**
- Modify: `src/renderer/components/settings.ts`（`SettingsValues`、`buildSettingsValues`、HTML、`currentValues`）
- Modify: `src/renderer/main.ts`（`openSettings` 传 `enable_thinking`）
- Test: `tests/renderer/settings.test.ts`（改既有 3 处 + 追加）

**Interfaces:**
- Consumes: Task 4 的 `api.enable_thinking`
- Produces: 保存时落盘 `api.enable_thinking: boolean`

- [ ] **Step 1: 改既有断言 + 追加失败测试**

`tests/renderer/settings.test.ts`：

1. 三处 `buildSettingsValues({ … })` 调用各加一行 `enableThinking: false,`。
2. 第三条用例（`:30`）的期望改成带上新键：

```ts
    expect(values.api).toEqual({
      url: "http://x/v1",
      model: "m",
      api_key: "secret",
      timeout: 42,
      enable_thinking: false,
    })
```

3. 末尾追加：

```ts
  it("enableThinking 落盘为 api.enable_thinking", () => {
    const values = buildSettingsValues({
      url: "http://x/v1",
      model: "m",
      apiKey: "k",
      timeout: 60,
      style: "light",
      winmergePath: "",
      enableThinking: true,
    }) as { api: { enable_thinking: boolean } }
    expect(values.api.enable_thinking).toBe(true)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/renderer/settings.test.ts`
Expected: FAIL —— `values.api.enable_thinking` 是 `undefined`

- [ ] **Step 3: 实现**

`src/renderer/components/settings.ts`：

```ts
export interface SettingsValues {
  url: string
  model: string
  apiKey: string
  timeout: number
  style: string
  winmergePath: string
  enableThinking: boolean
}

/** 只组装要落盘的键：api 五键 + ui.style + tools（其余配置由主进程 deepMerge 保留）。 */
export function buildSettingsValues(input: SettingsValues): Record<string, unknown> {
  return {
    api: {
      url: input.url,
      model: input.model,
      api_key: input.apiKey,
      timeout: input.timeout,
      enable_thinking: input.enableThinking,
    },
    ui: { style: input.style },
    tools: { winmerge_path: input.winmergePath.trim() },
  }
}
```

`SettingsDialogOptions.config.api` 追加 `enable_thinking: boolean`：

```ts
    api: { url: string; model: string; api_key: string; timeout: number; enable_thinking: boolean }
```

弹层 HTML：在「模型」组的「超时（秒）」字段之后插入：

```html
        <div class="field">
          <label for="enable-thinking">
            <input id="enable-thinking" type="checkbox" ${options.config.api.enable_thinking ? "checked" : ""} />
            启用思考模式（发送 enable_thinking）
          </label>
        </div>
```

元素引用与取值（`winmergeInput` 之后）：

```ts
  const thinkingInput = backdrop.querySelector<HTMLInputElement>("#enable-thinking")!
```

`currentValues()` 里 `style:` 之后追加：

```ts
      enableThinking: thinkingInput.checked,
```

`src/renderer/main.ts` 的 `openSettings` 里，`api` 对象追加：

```ts
        enable_thinking: config.value.api.enable_thinking,
```

- [ ] **Step 4: 跑测试确认通过 + 抓图确认**

Run: `npx vitest run tests/renderer/settings.test.ts && npm run typecheck && npm run shots`
Expected: PASS、typecheck 干净；**看图确认**复选框的标签与「超时（秒）」的对齐（同一组内间距一致）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/components/settings.ts src/renderer/main.ts tests/renderer/settings.test.ts
git commit -m "feat(ui): enable-thinking checkbox in settings"
```

---

### Task 9: E2E —— 改造 ③ + 流式 ⑫ / 取消 ⑬ / 非流式 ⑭

**Files:**
- Modify: `tests/e2e/app.spec.ts`（新增 `streamServer` 辅助 + 改 ③ + 追加 ⑫⑬⑭）

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 端到端证据（真 Electron + 真临时仓库 + 假 SSE 服务）

- [ ] **Step 1: 加 SSE 假服务辅助**

`tests/e2e/app.spec.ts` 顶部 import 补 `type Server`：

```ts
import { createServer, type Server } from "node:http"
```

在 `makeConfig` 之后追加：

```ts
/**
 * 假 SSE 服务：handler 拿到 send/finish/done 逐块推 delta。
 * 不调用 done() 就是「连接一直挂着」——用来断言流式中间态，避免用 sleep 抢时序。
 */
function streamServer(
  handler: (ctx: {
    send: (delta: Record<string, unknown>) => void
    finish: (reason?: string) => void
    done: () => void
  }) => void,
  calls: unknown[] = [],
): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      const send = (delta: Record<string, unknown>): void => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
      }
      const finish = (reason = "stop"): void => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`)
      }
      const done = (): void => {
        res.write("data: [DONE]\n\n")
        res.end()
      }
      handler({ send, finish, done })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port
      resolve({ server, url: `http://127.0.0.1:${port}/v1` })
    })
  })
}
```

- [ ] **Step 2: 改 ③ 为 SSE（思考进思考区）**

把 `:212-249` 的用例整体替换为：

```ts
test("③ AI 生成：思考进思考区、正文进输入框（SSE，标签跨 chunk）", async () => {
  const repo = makeRepo()
  const calls: unknown[] = []
  const { server, url } = await streamServer(({ send, finish, done }) => {
    send({ content: "<thi" })
    send({ content: "nk>先看 diff。</think>fix(tracked): 修好" })
    finish()
    done()
  }, calls)
  const configFile = makeConfig({ api: { url, api_key: "k", model: "m" } })

  const app = await launchApp({ repo, configFile })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")
  await window.click("#btn-generate")

  await expect(window.locator("#message")).toHaveValue("fix(tracked): 修好")
  await expect(window.locator("#thinking")).toBeVisible()
  await expect(window.locator("#thinking-body")).toHaveText("先看 diff。")
  await expect(window.locator("#status")).toContainText("已生成")

  // 真实链路发出去的提示词必须是新的结构化版本，且 diff 作为 user 消息
  const messages = (calls[0] as { messages: { role: string; content: string }[] }).messages
  expect((calls[0] as { model: string }).model).toBe("m")
  expect((calls[0] as { stream: boolean }).stream).toBe(true)
  expect(messages[0].role).toBe("system")
  expect(messages[0].content).toContain("Conventional Commits")
  expect(messages[0].content).toContain("<type>(<范围>): <描述>")
  expect(messages[1].role).toBe("user")
  expect(messages[1].content).toContain("diff --git a/tracked.txt b/tracked.txt")
  expect(messages[1].content).toContain("+v2")

  await app.close()
  server.close()
})
```

- [ ] **Step 3: 追加 ⑫⑬⑭**

文件末尾追加：

```ts
test("⑫ 流式：思考与正文边收边显示，生成中输入框只读", async () => {
  const repo = makeRepo()
  // 只发两块就不结束（连接挂着）→ 中间态可稳定断言，不靠 sleep 抢时序
  const { server, url } = await streamServer(({ send }) => {
    send({ reasoning_content: "先看改动。" })
    send({ content: "fix: 流式" })
  })
  const configFile = makeConfig({ api: { url, api_key: "k", model: "m" } })

  const app = await launchApp({ repo, configFile })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")
  await window.click("#btn-generate")

  await expect(window.locator("#thinking-body")).toHaveText("先看改动。")
  await expect(window.locator("#thinking")).toBeVisible()
  await expect(window.locator("#message")).toHaveValue("fix: 流式")
  await expect(window.locator("#message")).toHaveAttribute("readonly", "")
  await expect(window.locator("#btn-cancel")).toBeEnabled()

  await app.close()
  server.close()
})

test("⑬ 取消：不弹错误弹层，且保留已收到的思考与正文", async () => {
  const repo = makeRepo()
  const { server, url } = await streamServer(({ send }) => {
    send({ reasoning_content: "想了半截" })
    send({ content: "fix: 半截" })
  })
  const configFile = makeConfig({ api: { url, api_key: "k", model: "m" } })

  const app = await launchApp({ repo, configFile })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")
  await window.click("#btn-generate")
  await expect(window.locator("#message")).toHaveValue("fix: 半截")

  await window.click("#btn-cancel")

  await expect(window.locator("#status")).toContainText("已取消")
  await expect(window.locator(".modal-backdrop")).toBeHidden()
  await expect(window.locator("#thinking-body")).toHaveText("想了半截")
  await expect(window.locator("#message")).toHaveValue("fix: 半截")
  await expect(window.locator("#message")).not.toHaveAttribute("readonly", "")

  await app.close()
  server.close()
})

test("⑭ 服务端返回非流式 JSON：照常生成，思考进思考区，截断有提示", async () => {
  const repo = makeRepo()
  const server = createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "<think>想过</think>fix: 半截" }, finish_reason: "length" }],
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  const configFile = makeConfig({ api: { url: `http://127.0.0.1:${port}/v1`, api_key: "k", model: "m" } })

  const app = await launchApp({ repo, configFile })
  const window = await app.firstWindow()
  await window.waitForSelector("#changes-body tr")
  await window.click("#btn-generate")

  await expect(window.locator("#message")).toHaveValue("fix: 半截")
  await expect(window.locator("#thinking-body")).toHaveText("想过")
  await expect(window.locator("#status")).toContainText("截断")

  await app.close()
  server.close()
})
```

> ⑫⑬ 的流是被**故意挂住**的（不调 `done()`），用例结束时会留下一条未关闭的连接。若 `npm run e2e` 出现句柄残留告警或卡住，在 `server.close()` 之后补一行 `server.closeAllConnections?.()`（Node 18.2+ 有）即可。

- [ ] **Step 4: 跑 E2E**

Run: `npm run build && npm run e2e`
Expected: 全部通过（既有 14 条 + 新增 3 条 = 17 条；③ 是改造后的那条）

- [ ] **Step 5: 提交**

```bash
git add tests/e2e/app.spec.ts
git commit -m "test(e2e): streamed thinking, cancel and non-stream fallback"
```

---

### Task 10: 全量验证、文档、spec 对齐、打包

**Files:**
- Modify: `README.md`（配置表 + 「AI 生成」说明）
- Modify: `docs/superpowers/specs/2026-09-24-ai-thinking-stream-design.md`（回填本计划的 4 处实现差异）

- [ ] **Step 1: 跑全量验证**

```bash
npm test
npm run typecheck
npm run coverage
npm run build
npm run e2e
```

Expected: 单测全绿（153 → 约 175+）；`tsc --noEmit` 无输出；`src/core` 聚合行覆盖 ≥ 90%；E2E 17 条通过。

- [ ] **Step 2: 更新 README**

「配置」表 `api.max_tokens` 之后插入：

```markdown
| `api.enable_thinking` | `false` | 是否随请求发 `chat_template_kwargs: {enable_thinking: true}`（Qwen3 在 SGLang 上有时需要才吐思考）；默认不发，避免严格服务报 400 |
```

`api.timeout` 那一行的说明改为：

```markdown
| `api.timeout` | `60` | **空闲超时**（秒）：这么久没收到任何数据才算超时；持续有数据就一直生成（思考模型可以调到 300） |
```

「使用」一节的「AI 生成」条目改成：

```markdown
- **AI 生成**：按勾选的改动调用 OpenAI 兼容接口（`/chat/completions`，流式）。**思考模型的思考内容**实时滚进输入框下方的「AI 思考」区（没有思考就整块不出现），提交信息**边生成边落进输入框**（生成中输入框只读）；生成中可取消，取消保留已收到的内容且不报错。结果可继续编辑。默认要求 **Conventional Commits** 格式（`feat(范围): 中文描述`，标题 ≤ 50 字，改动大时补 `- ` 要点），并明确告诉模型 diff 里的 `### ` 说明行、截断标记不是代码，避免瞎编 issue 号/测试结果。思考来源三种都认：`reasoning_content` / `reasoning` / 正文里的 `<think>…</think>`。**非思考版模型（如 Qwen3-*-Instruct-2507）不会出现思考区**，这不是故障
```

- [ ] **Step 3: 回填 spec 的 4 处差异**

改 `docs/superpowers/specs/2026-09-24-ai-thinking-stream-design.md`：

1. §4.1 的 `readSseStream` 签名改成 `(body, onData, onActivity?) => Promise<{ dataEvents: number; raw: string }>`，并说明「JSON 解析与坏帧跳过在 `ai.ts`，SSE 层只管切帧」。
2. §4.3 的判定补一句：非流式＝`Content-Type` 含 `application/json` **或**响应无 `body`；`event-stream` 但零 `data:` 事件时，用累积 `raw` 再按 JSON 试一次。
3. §4.3 的 `GenerateOptions` 加 `onFinish`，并注明返回值仍是 `string`。
4. §4.3 的 `AIError` 补 `reason` 的取值与默认值；`AiConfig.enable_thinking` 注明是可选字段。

- [ ] **Step 4: 重新打包**

```bash
npm run package
```

产物仍在 `dist\win-unpacked\`。（本机没有可用的思考模型服务，**真机观看效果无法自动验证**——交付时如实说明；如需人工确认，把 `api.url` 指向本地 SGLang 后点一次「AI 生成」。）

- [ ] **Step 5: 提交**

```bash
git add README.md docs/superpowers/specs/2026-09-24-ai-thinking-stream-design.md
git commit -m "docs: document streamed AI thinking"
```

---

## 覆盖检查（对照 spec 逐条）

| spec 要求 | 落点 |
|---|---|
| 真流式（`stream: true` + SSE 增量） | Task 3（`stream: true` + `readSseStream`）、Task 9 ③⑫ |
| 三种思考来源都认 | Task 3（`reasoning_content`/`reasoning`/内联标签）、Task 3 单测、Task 9 ③（内联）与 ⑫（字段） |
| 手写 SSE、零依赖 | Task 1 |
| 思考/正文分离在 core、可穷举单测 | Task 2（切分穷举 + 未决前缀） |
| 正文实时落输入框、生成中只读 | Task 7（`readOnly` + 流式写入）、Task 9 ⑫ |
| 思考区位置/限高/默认展开/无思考不出现 | Task 7（`<details>` + `max-height` + `wasHidden` 判定）、Task 9 ③⑫ 断言 `toBeVisible` |
| 取消不弹框、保留已收内容 | Task 5（`AI_CANCELLED`）、Task 7（分支）、Task 9 ⑬ |
| 空闲超时（非总时长） | Task 3（`armIdle`/`onActivity`）、Task 3 单测 |
| 非流式回退 | Task 3（content-type / 无 body / 零事件兜底）、Task 3 单测、Task 9 ⑭ |
| `finish_reason === "length"` 提示 | Task 3（`onFinish`）、Task 5（`truncated`）、Task 7（状态栏文案）、Task 9 ⑭ |
| `api.enable_thinking` 开关（默认不发） | Task 4（payload + 单测）、Task 8（设置复选框） |
| 坏 chunk 跳过、零内容报错 | Task 3（单测）、既有「内容为空」用例 |
| 思考不进提交信息 | Task 2（分离器）、Task 6（`applyAiDelta`）、Task 9 ③⑭（`#message` 精确断言） |
| 主题 token | Task 7（tokens.css + app.css） |
| 覆盖率门、既有测试不回归 | Task 10 Step 1 |
