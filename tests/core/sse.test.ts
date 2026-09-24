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
