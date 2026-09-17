import { describe, expect, it } from "vitest"

import { ADDED, DELETED, MODIFIED, RENAMED, UNTRACKED } from "../../src/shared/changes"
import {
  actionHint,
  applyFilter,
  checkedPaths,
  commitEnabled,
  defaultChecked,
  initialChecked,
  summaryText,
  visibleChanges,
  type UiState,
} from "../../src/renderer/state"

function change(path: string, status: string) {
  return { path, status, origPath: null }
}

function makeState(over: Partial<UiState> = {}): UiState {
  const changes = over.changes ?? [change("a.txt", MODIFIED), change("b.txt", UNTRACKED)]
  const policy = over.checkedByDefault ?? "tracked"
  return {
    branch: "main",
    changes,
    stats: {},
    checked: initialChecked(changes, policy),
    message: "",
    showUntracked: false,
    checkedByDefault: policy,
    busy: null,
    selectedPath: null,
    ...over,
  }
}

describe("defaultChecked / initialChecked", () => {
  it("tracked 策略勾选已跟踪、不勾未跟踪", () => {
    expect(defaultChecked(change("a", MODIFIED), "tracked")).toBe(true)
    expect(defaultChecked(change("b", UNTRACKED), "tracked")).toBe(false)
  })

  it("all / none 策略", () => {
    expect(defaultChecked(change("b", UNTRACKED), "all")).toBe(true)
    expect(defaultChecked(change("a", MODIFIED), "none")).toBe(false)
  })

  it("initialChecked 按策略初始化", () => {
    expect([...initialChecked([change("a", MODIFIED), change("b", UNTRACKED)], "tracked")]).toEqual(["a"])
  })
})

describe("visibleChanges", () => {
  it("默认隐藏未跟踪文件", () => {
    expect(visibleChanges(makeState()).map((c) => c.path)).toEqual(["a.txt"])
  })

  it("打开开关后显示未跟踪文件", () => {
    expect(visibleChanges(makeState({ showUntracked: true })).map((c) => c.path)).toEqual(["a.txt", "b.txt"])
  })
})

describe("applyFilter", () => {
  it("all / none 全选全不选（只作用于可见行）", () => {
    const state = makeState()
    expect([...applyFilter(state, "all")]).toEqual(["a.txt"])
    expect(applyFilter(state, "none").size).toBe(0)
  })

  it("已添加是累加勾选，不取消已有勾选", () => {
    const state = makeState({ changes: [change("a", MODIFIED), change("n", ADDED)], checked: new Set(["a"]) })
    expect([...applyFilter(state, "added")].sort()).toEqual(["a", "n"])
  })

  it("已修改同时匹配已重命名", () => {
    const state = makeState({ changes: [change("r", RENAMED), change("d", DELETED)], checked: new Set() })
    expect([...applyFilter(state, "modified")]).toEqual(["r"])
    expect([...applyFilter(state, "deleted")]).toEqual(["d"])
  })

  it("隐藏行的勾选不参与提交，过滤后即被丢弃", () => {
    const state = makeState({ showUntracked: false, checked: new Set(["a.txt", "b.txt"]) })
    expect(checkedPaths(state)).toEqual(["a.txt"])
    expect(applyFilter(state, "all").has("b.txt")).toBe(false)
  })
})

describe("summaryText / actionHint / commitEnabled", () => {
  it("汇总文案", () => {
    expect(summaryText(makeState())).toBe("共 1 个变更 · 已选 1")
  })

  it("有变更未勾选时提示勾选", () => {
    expect(actionHint(makeState({ checked: new Set() }))).toBe("请先勾选要提交的文件")
  })

  it("已勾选但没写信息时提示填信息", () => {
    expect(actionHint(makeState({ checked: new Set(["a.txt"]) }))).toBe("请填写提交信息")
  })

  it("提交按钮可用性矩阵", () => {
    expect(commitEnabled(makeState({ checked: new Set(["a.txt"]), message: "x" }))).toBe(true)
    expect(commitEnabled(makeState({ checked: new Set(["a.txt"]), message: "" }))).toBe(false)
    expect(commitEnabled(makeState({ checked: new Set(), message: "x" }))).toBe(false)
    expect(commitEnabled(makeState({ checked: new Set(["a.txt"]), message: "x", busy: "commit" }))).toBe(false)
    expect(commitEnabled(makeState({ checked: new Set(["a.txt"]), message: "   " }))).toBe(false)
  })

  it("工作区干净时提交按钮不可用（回归：曾可点）", () => {
    const state = makeState({ changes: [], checked: new Set(), message: "x" })
    expect(commitEnabled(state)).toBe(false)
    expect(actionHint(state)).toBe("")
  })
})
