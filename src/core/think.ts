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
