export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "ctx" | "note"

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

const HEADER_PREFIXES = ["diff --git ", "index ", "--- ", "+++ "]

function splitLines(text: string): string[] {
  if (text === "") return []
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/**
 * 把 unified diff 文本切分为带类型的行。
 *
 * 分两段判定以避免 `+++` 歧义：首个 `@@` 之前是文件头（`diff --git`/`index `
 * /`--- `/`+++ ` 都是 meta）；之后是正文，`+`/`-` 开头一律按增删行处理，所以
 * 正文里内容为 `++x` 的新增行（渲染成 `+++x`）不会被误判成文件头。
 *
 * `### ` 开头的行是 core 为「未跟踪/超限/二进制」生成的说明，归 note，并且
 * 它同时标志着一个**合成正文块**的开始（后面跟的是纯 `+` 内容行，没有 `@@`）。
 */
export function parseDiff(text: string): DiffLine[] {
  const result: DiffLine[] = []
  let inBody = false
  for (const line of splitLines(text)) {
    if (line.startsWith("### ")) {
      inBody = true
      result.push({ kind: "note", text: line })
      continue
    }
    if (line.startsWith("@@")) {
      inBody = true
      result.push({ kind: "hunk", text: line })
      continue
    }
    if (line.startsWith("\\ No newline")) {
      result.push({ kind: "meta", text: line })
      continue
    }
    if (inBody && line.startsWith("+")) {
      result.push({ kind: "add", text: line })
      continue
    }
    if (inBody && line.startsWith("-")) {
      result.push({ kind: "del", text: line })
      continue
    }
    if (!inBody && HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      result.push({ kind: "meta", text: line })
      continue
    }
    result.push({ kind: "ctx", text: line })
  }
  return result
}
