import { readSseStream } from "./sse"
import { createThinkSplitter, type ThinkParts } from "./think"

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

export interface AiConfig {
  url: string
  api_key: string
  model: string
  prompt: string
  max_tokens: number
  language: string
  timeout: number
  /** 是否随请求发 chat_template_kwargs.enable_thinking（可选，缺省不发） */
  enable_thinking?: boolean
}

const THINK_RE = /<think>[\s\S]*?<\/think>/g

/** 移除思考模型的 <think>...</think> 段落。 */
export function stripThink(text: string): string {
  return text.replace(THINK_RE, "").trim()
}

const COMMIT_TYPES = "feat、fix、docs、style、refactor、perf、test、build、ci、chore、revert"

/**
 * 默认系统提示词：Conventional Commits + 描述用配置语言 + 只在改动较大时给要点。
 *
 * 提示词里显式交代了 diff 的三处工具语义，模型才不会把工具生成的说明当代码：
 * `### ` 说明行、被截断的标记、以及「只看得到这些文件」。
 */
export function buildPrompt(cfg: { prompt?: string; language?: string }): string {
  const custom = (cfg.prompt ?? "").trim()
  if (custom) return custom
  const language = cfg.language || "中文"
  return `你是提交信息生成器。阅读给定的 git diff（可能包含多个文件），写一条提交信息。

## 格式（Conventional Commits）
<type>(<范围>): <描述>
- type 只能取：${COMMIT_TYPES}
- 范围可选：用改动最集中的模块/目录/文件名，不要发明 diff 里没有的名字
- 描述用${language}，动宾结构，说清「做了什么」；原因只在它不明显时才补一句
- 整条标题不超过 50 个字符，行尾不加句号，不加编号或方括号
- 示例：fix(配置): 旧默认窗口尺寸导致分栏折叠

## 正文（仅在必要时）
- 只有改动涉及多个文件、多个关注点，或原因不显而易见时，才在标题后空一行写正文
- 正文用 \`- \` 列出关键改动，最多 5 条，每条一句话，不重复标题已说的内容

## 硬性要求
- 只输出提交信息本身：不要引号、不要 markdown 标记、不要代码块、不要「以下是…」之类的前后缀
- 不要编造 diff 里没有的信息：issue 号、票号、测试结果、性能数字
- diff 中以 \`### \` 开头的行是工具生成的说明（新增文件、过大跳过、疑似二进制、已截断），不是代码内容
- diff 被截断时，只概括看得见的部分；diff 里没有的文件一概不提`
}

export interface GenerateOptions {
  signal?: AbortSignal
  fetchImpl?: FetchLike
  onDelta?: (delta: AiDelta) => void
  /** 流结束时的元信息（返回值保持 string，既有调用方不用动） */
  onFinish?: (info: { finishReason: string | null }) => void
  /** 空闲超时（毫秒）：超过这么久没收到任何字节才算超时；默认用 cfg.timeout 秒 */
  idleTimeoutMs?: number
}

interface StreamState {
  text: string
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
  // 服务端专属参数默认一个都不发（严格实现会因未知字段 400），只在用户显式开启时才带
  if (cfg.enable_thinking) payload.chat_template_kwargs = { enable_thinking: true }

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
  // 组合一次、两处共用：用户取消要能同时打断 fetch 与读流（假 fetch 的 body 未必接信号）
  const combinedSignal = AbortSignal.any(signals)

  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init))
  armIdle()

  let response: FetchResponseLike
  try {
    response = await fetchImpl(`${url}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: combinedSignal,
    })
  } catch (error) {
    stopIdle()
    // 取消优先于超时：误把「用户取消」当超时会弹错误框
    if (options.signal?.aborted) throw new AIError("已取消", "aborted")
    if (timedOut) throw new AIError(idleText, "timeout")
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

  const state: StreamState = { text: "", finishReason: null }
  const splitter = createThinkSplitter()
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
        emit("thinking", reasoning)
      }
      const content = firstString(piece, ["content"])
      if (content !== "") {
        const parts: ThinkParts = splitter.push(content)
        if (parts.thinking !== "") {
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
      // 非流式没有逐块活动可重装计时器，这里量的是整段总时长；作为
      // 「服务端不支持流式」的兜底路径，慢但持续产出的响应被误判超时可接受
      routeJson(await readJson())
    } else {
      const { dataEvents, raw } = await readSseStream(
        response.body as ReadableStream<Uint8Array>,
        onData,
        { onActivity: armIdle, signal: combinedSignal },
      )
      // 服务端把 content-type 写成 event-stream、其实整段是 JSON
      if (dataEvents === 0) routeJson(parseJson(raw))
    }
  } catch (error) {
    stopIdle()
    if (options.signal?.aborted) throw new AIError("已取消", "aborted")
    if (timedOut) throw new AIError(idleText, "timeout")
    if (error instanceof AIError) throw error
    throw new AIError(`AI 请求失败：${error instanceof Error ? error.message : String(error)}`, "network")
  }
  stopIdle()
  // 读流被取消（空闲超时/用户取消）时 read() 是正常收尾而不是抛错，所以这里再确认一次
  if (options.signal?.aborted) throw new AIError("已取消", "aborted")
  if (timedOut) throw new AIError(idleText, "timeout")

  // 收尾：未决前缀按当前状态归还，避免吞字
  const tail = splitter.flush()
  if (tail.thinking !== "") {
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
