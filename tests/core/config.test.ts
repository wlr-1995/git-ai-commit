import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { DEFAULT_CONFIG, deepMerge, loadConfig, saveConfig } from "../../src/core/config"
import { makeTempDir } from "../helpers/repo"

describe("deepMerge", () => {
  it("缺失键保留默认值", () => {
    const base = { a: { x: 1, y: 2 }, b: 3 }
    expect(deepMerge(base, { a: { y: 9 } })).toEqual({ a: { x: 1, y: 9 }, b: 3 })
  })

  it("不改动入参", () => {
    const base = { a: { x: 1 } }
    const override = { a: { y: 2 } }
    deepMerge(base, override)
    expect(base).toEqual({ a: { x: 1 } })
    expect(override).toEqual({ a: { y: 2 } })
  })
})

describe("loadConfig", () => {
  it("文件不存在时写出默认配置", () => {
    const cfgFile = join(makeTempDir(), "sub", "config.json")
    const cfg = loadConfig(cfgFile)
    expect(cfg.selection.checked_by_default).toBe("tracked")
    expect(readFileSync(cfgFile, "utf8")).toContain("checked_by_default")
  })

  it("部分文件与默认值合并", () => {
    const cfgFile = join(makeTempDir(), "config.json")
    writeFileSync(cfgFile, JSON.stringify({ api: { model: "custom" } }), "utf8")
    const cfg = loadConfig(cfgFile)
    expect(cfg.api.model).toBe("custom")
    expect(cfg.api.url).toBe(DEFAULT_CONFIG.api.url)
  })

  it("坏 JSON 回退默认", () => {
    const cfgFile = join(makeTempDir(), "config.json")
    writeFileSync(cfgFile, "{ this is not json", "utf8")
    expect(loadConfig(cfgFile).git.max_diff_lines).toBe(200)
  })

  it("非 UTF-8 文件回退默认", () => {
    const cfgFile = join(makeTempDir(), "config.json")
    writeFileSync(cfgFile, Buffer.from([0xff, 0xfe, 0x7b, 0x20, 0x78]))
    const cfg = loadConfig(cfgFile)
    expect(cfg.git.max_diff_lines).toBe(200)
    expect(cfg.api.model).toBe(DEFAULT_CONFIG.api.model)
  })

  it("顶层不是对象时回退默认", () => {
    const cfgFile = join(makeTempDir(), "config.json")
    writeFileSync(cfgFile, "[1,2,3]", "utf8")
    expect(loadConfig(cfgFile).api.model).toBe(DEFAULT_CONFIG.api.model)
  })

  it("旧配置的 traditional 样式键被保留（映射由主题层负责）", () => {
    const cfgFile = join(makeTempDir(), "config.json")
    writeFileSync(cfgFile, JSON.stringify({ ui: { style: "traditional" } }), "utf8")
    expect(loadConfig(cfgFile).ui.style).toBe("traditional")
  })
})

describe("saveConfig", () => {
  it("中文往返", () => {
    const cfgFile = join(makeTempDir(), "config.json")
    const cfg = loadConfig(cfgFile)
    cfg.api.language = "中文"
    saveConfig(cfg, cfgFile)
    const raw = readFileSync(cfgFile, "utf8")
    expect(raw).toContain("中文")
    expect(loadConfig(cfgFile).api.language).toBe("中文")
  })

  it("无尾随换行且缩进 2", () => {
    const cfgFile = join(makeTempDir(), "config.json")
    saveConfig(loadConfig(cfgFile), cfgFile)
    const raw = readFileSync(cfgFile, "utf8")
    expect(raw).not.toMatch(/\n$/)
    expect(raw).toContain('\n  "api"')
  })

  it("默认配置与规格一致", () => {
    expect(DEFAULT_CONFIG.api).toEqual({
      url: "http://localhost:11434/v1",
      api_key: "ollama",
      model: "qwen2.5-coder:7b",
      prompt: "",
      max_tokens: 8192,
      language: "中文",
      timeout: 60,
    })
    expect(DEFAULT_CONFIG.git.max_diff_lines).toBe(200)
    // 窗口尺寸是 Electron 版独有的界面键：左右分栏需要更宽的开窗（Python 版是 720x520）
    expect(DEFAULT_CONFIG.ui.window_width).toBe(1100)
    expect(DEFAULT_CONFIG.ui.window_height).toBe(640)
    expect(DEFAULT_CONFIG.ui.show_untracked).toBe(false)
    expect(DEFAULT_CONFIG.ui.style).toBe("light")
    expect(DEFAULT_CONFIG.selection.checked_by_default).toBe("tracked")
  })
})
