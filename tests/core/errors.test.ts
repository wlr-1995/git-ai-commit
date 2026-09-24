import { describe, expect, it } from "vitest"

import { AIError } from "../../src/core/ai"
import { toError } from "../../src/core/errors"
import { GitError } from "../../src/core/gitcmd"
import { PathError } from "../../src/core/paths"
import { WinMergeError } from "../../src/core/winmerge"

describe("toError", () => {
  it("找不到 WinMerge → WINMERGE_NOT_FOUND", () => {
    expect(toError(new WinMergeError("未找到 WinMerge。", "not_found")).code).toBe("WINMERGE_NOT_FOUND")
  })

  it("WinMerge 启动失败 → WINMERGE_LAUNCH_FAILED，且保留原始文案", () => {
    const mapped = toError(new WinMergeError("WinMerge 启动失败：拒绝访问", "launch_failed"))
    expect(mapped.code).toBe("WINMERGE_LAUNCH_FAILED")
    expect(mapped.message).toContain("拒绝访问")
  })

  it("既有映射不回归", () => {
    expect(toError(new PathError("越界")).code).toBe("PATH_OUTSIDE_REPO")
    expect(toError(new GitError("超时", "timeout")).code).toBe("GIT_TIMEOUT")
    expect(toError(new AIError("AI 返回 500：boom")).code).toBe("AI_HTTP")
    expect(toError(new Error("随便")).code).toBe("UNKNOWN")
  })

  it("用户取消 → AI_CANCELLED（渲染层据此不弹错误框）", () => {
    const mapped = toError(new AIError("已取消", "aborted"))
    expect(mapped.code).toBe("AI_CANCELLED")
    expect(mapped.message).toBe("已取消")
  })

  it("AI 超时不回归成取消（仍是可弹框的错误）", () => {
    expect(toError(new AIError("AI 请求超时：60 秒内没有收到任何数据", "timeout")).code).toBe("AI_BAD_RESPONSE")
  })
})
