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
    // Node 的 fetch 只抛 "fetch failed"，真正的原因（ECONNREFUSED 等）在 cause 里
    const cause = (error as { cause?: { message?: string } }).cause?.message
    const message = cause ?? (error instanceof Error ? error.message : String(error))
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
