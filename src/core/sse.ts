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
