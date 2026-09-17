export class AIError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AIError"
  }
}

export interface AiConfig {
  url: string
  api_key: string
  model: string
  prompt: string
  max_tokens: number
  language: string
  timeout: number
}

export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<{ status: number; text(): Promise<string>; json(): Promise<unknown> }>

const THINK_RE = /<think>[\s\S]*?<\/think>/g

/** 移除思考模型的 <think>...</think> 段落。 */
export function stripThink(text: string): string {
  return text.replace(THINK_RE, "").trim()
}

/** 自定义提示词优先，否则按语言生成默认提示词。 */
export function buildPrompt(cfg: { prompt?: string; language?: string }): string {
  const custom = (cfg.prompt ?? "").trim()
  if (custom) return custom
  const language = cfg.language || "中文"
  return (
    "你是一个专业程序员。请根据提供的 git diff 生成一条简洁、准确的提交信息，" +
    `使用${language}，只输出提交信息本身，不要输出解释、引号或 markdown 标记。`
  )
}

export interface GenerateOptions {
  signal?: AbortSignal
  fetchImpl?: FetchLike
}

/** 调用 {url}/chat/completions 生成提交信息。 */
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
    stream: false,
  }
  const maxTokens = cfg.max_tokens || 0
  if (maxTokens > 0) payload.max_tokens = maxTokens

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.api_key || ""}`,
  }

  const signals: AbortSignal[] = [AbortSignal.timeout((cfg.timeout ?? 60) * 1000)]
  if (options.signal) signals.push(options.signal)
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init))

  let response
  try {
    response = await fetchImpl(`${url}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.any(signals),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new AIError(`AI 请求失败：${message}`)
  }

  if (response.status !== 200) {
    const text = await response.text()
    throw new AIError(`AI 返回 ${response.status}：${text.slice(0, 500)}`)
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new AIError("AI 返回的不是合法 JSON")
  }

  const choices = (data as { choices?: unknown } | null)?.choices
  if (!Array.isArray(choices) || choices.length === 0) throw new AIError("AI 返回缺少 choices")

  const first = choices[0] as { message?: { content?: string } } | undefined
  const content = stripThink(first?.message?.content ?? "")
  if (!content) throw new AIError("AI 未返回有效内容")
  return content
}
