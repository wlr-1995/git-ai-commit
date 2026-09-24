import { describe, expect, it } from "vitest"

import { buildSettingsValues } from "../../src/renderer/components/settings"

describe("buildSettingsValues", () => {
  it("包含 tools.winmerge_path（留空也落盘，表示自动探测）", () => {
    const values = buildSettingsValues({
      url: "http://x/v1",
      model: "m",
      apiKey: "k",
      timeout: 60,
      style: "light",
      winmergePath: "",
      enableThinking: false,
    }) as { tools: { winmerge_path: string } }
    expect(values.tools.winmerge_path).toBe("")
  })

  it("去掉首尾空格", () => {
    const values = buildSettingsValues({
      url: "http://x/v1",
      model: "m",
      apiKey: "k",
      timeout: 60,
      style: "light",
      winmergePath: "  D:\\W\\WinMergeU.exe  ",
      enableThinking: false,
    }) as { tools: { winmerge_path: string } }
    expect(values.tools.winmerge_path).toBe("D:\\W\\WinMergeU.exe")
  })

  it("保留既有键：api 四键与 ui.style 原样出现在返回值里", () => {
    const values = buildSettingsValues({
      url: "http://x/v1",
      model: "m",
      apiKey: "secret",
      timeout: 42,
      style: "dark",
      winmergePath: "",
      enableThinking: false,
    }) as {
      api: { url: string; model: string; api_key: string; timeout: number; enable_thinking: boolean }
      ui: { style: string }
    }
    expect(values.api).toEqual({
      url: "http://x/v1",
      model: "m",
      api_key: "secret",
      timeout: 42,
      enable_thinking: false,
    })
    expect(values.ui).toEqual({ style: "dark" })
  })

  it("enableThinking 落盘为 api.enable_thinking", () => {
    const values = buildSettingsValues({
      url: "http://x/v1",
      model: "m",
      apiKey: "k",
      timeout: 60,
      style: "light",
      winmergePath: "",
      enableThinking: true,
    }) as { api: { enable_thinking: boolean } }
    expect(values.api.enable_thinking).toBe(true)
  })
})
