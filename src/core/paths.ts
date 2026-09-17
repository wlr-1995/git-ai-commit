import { isAbsolute, join, relative, resolve, sep } from "node:path"

export class PathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PathError"
  }
}

/**
 * 把仓库内相对路径解析成绝对路径；越界或非法则抛 PathError。
 *
 * diff 面板会渲染仓库内容，路径又来自渲染层，因此所有路径都必须先过这一关：
 * 解析后必须以仓库根为前缀，禁止 `..` 逃逸、仓库外的绝对路径、含 NUL 的字符串。
 */
export function resolveInsideRepo(repoRoot: string, relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0 || relPath.includes("\0")) {
    throw new PathError(`非法路径: ${String(relPath)}`)
  }
  const root = resolve(repoRoot)
  const target = isAbsolute(relPath) ? resolve(relPath) : resolve(root, relPath)
  const rel = relative(root, target)
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new PathError(`路径超出仓库范围: ${relPath}`)
  }
  if (rel === "") return root
  return join(root, ...rel.split(sep))
}
