# Electron 重写 M4：打包与切换 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打出便携目录（`dist/win-unpacked/`），把 HKCU 右键菜单从 `pythonw.exe app\main.py` 改为指向打包后的 exe，删除 Python 实现与测试，重写 README，并用真实右键菜单完成验收。

**Architecture:** `electron-builder` 的 `dir` target 产出免安装目录；`install/*.ps1` 只写 `HKCU\Software\Classes`（免管理员、免 COM）；exe 文件名用 ASCII（`git-ai-commit.exe`）避免中文路径带来的脚本转义风险，显示名仍是「AI 提交」。

**Tech Stack:** electron-builder 26.15.3、Electron 44.4.1、PowerShell 7（脚本需兼容 Windows PowerShell 5.1 的写法）。

## Global Constraints

- 平台仅 Windows；脚本免管理员（只写 `HKCU`）；所有脚本与文档用中文。
- exe 文件名固定 `git-ai-commit.exe`；注册表键沿用 `HKCU\Software\Classes\Directory\shell\AIGitCommit`（含 `Directory\Background`），默认值「AI 提交」。
- 配置路径与键名不变：`%USERPROFILE%\.git_ai_commit\config.json`（旧配置必须继续可用）。
- 删除 Python 实现时**不要**动 `docs/`、`THIRD-PARTY-NOTICES.md`、`install/`。
- 每个任务结束提交；提交信息中文 `chore(pkg): ...` / `feat(install): ...` / `docs: ...`。

---

### Task 1: 图标

**Files:**
- Create: `scripts/make-icon.mjs`、`build/icon.ico`（生成物，提交入库）

**Interfaces:**
- Consumes: 无
- Produces: `build/icon.ico`（256/48/32/16 四个尺寸，32bpp BGRA DIB 格式，供 electron-builder 与 exe 使用）

- [ ] **Step 1: 写 `scripts/make-icon.mjs`**

要点：手写 ICO 容器（6 字节头 + 每个尺寸 16 字节目录项 + DIB 数据），DIB = `BITMAPINFOHEADER`(40) + BGRA 像素（自下而上）+ AND 掩码（每行按 4 字节对齐）。图形：`#2563eb` 圆角方块 + 白色对勾（点到线段距离 < 笔画半宽则着白色，边缘做 1px 抗锯齿）。

```js
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const SIZES = [256, 48, 32, 16]
const ACCENT = [0x25, 0x63, 0xeb]
const PAD = (size) => Math.round(size * 0.06)
const RADIUS = (size) => size * 0.22

function roundedAlpha(x, y, size) {
  const p = PAD(size)
  const r = RADIUS(size)
  const left = p + r
  const right = size - p - r
  const top = p + r
  const bottom = size - p - r
  const cx = x < left ? left : x > right ? right : x
  const cy = y < top ? top : y > bottom ? bottom : y
  const distance = Math.hypot(x - cx, y - cy)
  return Math.max(0, Math.min(1, r + 0.5 - distance))
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const length2 = vx * vx + vy * vy
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / length2))
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy))
}

function renderPixels(size) {
  const stroke = size * 0.11
  const a = [size * 0.27, size * 0.53]
  const b = [size * 0.43, size * 0.69]
  const c = [size * 0.74, size * 0.33]
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cx = x + 0.5
      const cy = y + 0.5
      const bg = roundedAlpha(cx, cy, size)
      const d = Math.min(
        segmentDistance(cx, cy, a[0], a[1], b[0], b[1]),
        segmentDistance(cx, cy, b[0], b[1], c[0], c[1]),
      )
      const check = Math.max(0, Math.min(1, stroke / 2 + 0.5 - d))
      const alpha = bg
      const r = Math.round(ACCENT[0] * (1 - check) + 255 * check)
      const g = Math.round(ACCENT[1] * (1 - check) + 255 * check)
      const bl = Math.round(ACCENT[2] * (1 - check) + 255 * check)
      const offset = (y * size + x) * 4
      pixels[offset] = bl
      pixels[offset + 1] = g
      pixels[offset + 2] = r
      pixels[offset + 3] = Math.round(alpha * 255)
    }
  }
  return pixels
}

function dibFor(size) {
  const pixels = renderPixels(size)
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // 高度含 AND 掩码
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16)
  header.writeUInt32LE(pixels.length, 20)
  const rows = []
  for (let y = size - 1; y >= 0; y -= 1) {
    rows.push(pixels.subarray(y * size * 4, (y + 1) * size * 4))
  }
  const xor = Buffer.concat(rows)
  const maskRow = Math.ceil(size / 32) * 4
  const and = Buffer.alloc(maskRow * size)
  return Buffer.concat([header, xor, and])
}

const images = SIZES.map((size) => ({ size, data: dibFor(size) }))
const directory = Buffer.alloc(6 + images.length * 16)
directory.writeUInt16LE(0, 0)
directory.writeUInt16LE(1, 2)
directory.writeUInt16LE(images.length, 4)
let offset = directory.length
images.forEach((image, index) => {
  const entry = 6 + index * 16
  directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry)
  directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1)
  directory.writeUInt8(0, entry + 2)
  directory.writeUInt8(0, entry + 3)
  directory.writeUInt16LE(1, entry + 4)
  directory.writeUInt16LE(32, entry + 6)
  directory.writeUInt32LE(image.data.length, entry + 8)
  directory.writeUInt32LE(offset, entry + 12)
  offset += image.data.length
})
mkdirSync(join(process.cwd(), "build"), { recursive: true })
writeFileSync(join(process.cwd(), "build", "icon.ico"), Buffer.concat([directory, ...images.map((i) => i.data)]))
console.log("已生成 build/icon.ico")
```

- [ ] **Step 2: 生成并核验**

Run: `node scripts/make-icon.mjs`
Run: `node -e "const s=require('node:fs').statSync('build/icon.ico'); console.log(s.size)"` → Expected: 约 270000 字节（>200000）
Run: `Add-Type -AssemblyName System.Drawing; [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path build/icon.ico)).Size` → 或人工右键查看图标不是空白

- [ ] **Step 3: 提交**

```bash
git add scripts/make-icon.mjs build/icon.ico
git commit -m "chore(pkg): generate app icon (blue rounded square with check)"
```

---

### Task 2: electron-builder 打包

**Files:**
- Create: `electron-builder.yml`
- Modify: `package.json`（加 `package` 脚本）

**Interfaces:**
- Consumes: Task 1 的 `build/icon.ico`；`out/**`（electron-vite 产物）
- Produces: `dist/win-unpacked/git-ai-commit.exe`

- [ ] **Step 1: 写 `electron-builder.yml`**

```yaml
appId: com.xingqiong.git-ai-commit
productName: AI 提交
executableName: git-ai-commit
copyright: Copyright (c) 2026
directories:
  output: dist
  buildResources: build
files:
  - out/**/*
  - package.json
win:
  target:
    - target: dir
      arch:
        - x64
  icon: build/icon.ico
```

- [ ] **Step 2: 加脚本并打包**

`package.json` 脚本加：`"package": "electron-vite build && electron-builder --win --dir"`

Run: `npm run package`
Expected: `dist/win-unpacked/git-ai-commit.exe` 存在

- [ ] **Step 3: 冒烟：直接用打包产物打开一个真仓库**

Run: `& "dist\win-unpacked\git-ai-commit.exe" "D:\wlr\ai\git-ai-commit"`
Expected: 窗口出现、列出真实变更；任务管理器里没有 electron.exe 之外的残留（打包后进程名是 git-ai-commit.exe）

- [ ] **Step 4: 实测冷启动**

用 PowerShell 记录从进程启动到窗口出现的时间（轮询主窗口标题非空）：

```powershell
$exe = "dist\win-unpacked\git-ai-commit.exe"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$p = Start-Process $exe -ArgumentList "D:\wlr\ai\git-ai-commit" -PassThru
while ($sw.Elapsed.TotalSeconds -lt 20) {
  $p.Refresh()
  if ($p.MainWindowTitle) { break }
  Start-Sleep -Milliseconds 50
}
"冷启动: $([math]::Round($sw.Elapsed.TotalMilliseconds)) ms (窗口标题: $($p.MainWindowTitle))"
Stop-Process -Name git-ai-commit -Force -ErrorAction SilentlyContinue
```

Expected: 冷启动 < 2000 ms（设计目标是 ~1s；把实测值记进 README）

- [ ] **Step 5: 体积**

Run: `"{0:N1} MB" -f ((Get-ChildItem dist\win-unpacked -Recurse | Measure-Object Length -Sum).Sum / 1MB)`
Expected: 约 220–300 MB（对照：Python 版依赖 PySide6 632 MB）

- [ ] **Step 6: 提交**

```bash
git add electron-builder.yml package.json
git commit -m "chore(pkg): portable build via electron-builder (dir target)"
```

---

### Task 3: 右键菜单改指向 exe

**Files:**
- Modify: `install/install.ps1`、`install/uninstall.ps1`、`install/verify.ps1`

**Interfaces:**
- Consumes: `dist/win-unpacked/git-ai-commit.exe`
- Produces: `HKCU\Software\Classes\Directory\shell\AIGitCommit\command` = `"«Dir»\git-ai-commit.exe" "%V"`

- [ ] **Step 1: 重写 `install/install.ps1`**

```powershell
param(
    [string]$Dir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\win-unpacked')
)

$ErrorActionPreference = 'Stop'

$exe = Join-Path $Dir 'git-ai-commit.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    throw "找不到 $exe。请先运行 npm run package，或用 -Dir 指向便携目录。"
}

$command = "`"$exe`" `"%V`""
$bases = @(
    'HKCU:\Software\Classes\Directory\shell\AIGitCommit',
    'HKCU:\Software\Classes\Directory\Background\shell\AIGitCommit'
)

foreach ($base in $bases) {
    New-Item -Path $base -Force | Out-Null
    Set-ItemProperty -Path $base -Name '(default)' -Value 'AI 提交'
    Set-ItemProperty -Path $base -Name 'Icon' -Value "`"$exe`""
    New-Item -Path "$base\command" -Force | Out-Null
    Set-ItemProperty -Path "$base\command" -Name '(default)' -Value $command
}

Write-Host "已安装右键菜单（免管理员，仅写入 HKCU）："
Write-Host "  $command"
Write-Host "Windows 11 中请在「显示更多选项」里查看。"
```

- [ ] **Step 2: 更新 `uninstall.ps1`（保持原逻辑，提示语改为新版）**

在原有基础上仅把提示语改为中文一致描述，并在末尾提示「便携目录可直接删除」：

```powershell
$ErrorActionPreference = 'Stop'

$bases = @(
    'HKCU:\Software\Classes\Directory\shell\AIGitCommit',
    'HKCU:\Software\Classes\Directory\Background\shell\AIGitCommit'
)

foreach ($base in $bases) {
    if (Test-Path $base) {
        Remove-Item -Path $base -Recurse -Force
        Write-Host "已删除 $base"
    } else {
        Write-Host "未安装 $base"
    }
}

Write-Host '右键菜单已移除；便携目录（dist\win-unpacked）可直接删除。'
```

- [ ] **Step 3: 更新 `verify.ps1`（校验 exe 真实存在）**

```powershell
$ErrorActionPreference = 'Stop'

$keys = @(
    'HKCU:\Software\Classes\Directory\shell\AIGitCommit\command',
    'HKCU:\Software\Classes\Directory\Background\shell\AIGitCommit\command'
)

$ok = $true
foreach ($key in $keys) {
    if (-not (Test-Path $key)) {
        Write-Host "MISS $key"
        $ok = $false
        continue
    }
    $cmd = (Get-ItemProperty -Path $key).'(default)'
    $exe = ($cmd -split '"')[1]
    if ($exe -and (Test-Path -LiteralPath $exe)) {
        Write-Host "OK   $key -> $cmd"
    } else {
        Write-Host "BAD  $key -> $cmd（exe 不存在）"
        $ok = $false
    }
}
if (-not $ok) { exit 1 }
Write-Host '右键菜单注册校验通过'
```

- [ ] **Step 4: 真机验收（关键）**

先卸掉旧的 Python 版菜单并确认：

```powershell
pwsh -NoProfile -File install\uninstall.ps1
Test-Path 'HKCU:\Software\Classes\Directory\shell\AIGitCommit'   # 期望 False
```

再装新版并校验：

```powershell
pwsh -NoProfile -File install\install.ps1
pwsh -NoProfile -File install\verify.ps1                          # 期望「校验通过」
```

最后**真实右键**：在资源管理器里对 `D:\wlr\ai\git-ai-commit` 右键 → 「AI 提交」→ 新窗口打开且列出真实变更（Windows 11 需点「显示更多选项」）。截图留档。

- [ ] **Step 5: 提交**

```bash
git add install
git commit -m "feat(install): point the shell menu at the packaged exe"
```

---

### Task 4: 删除 Python 实现与测试

**Files:**
- Delete: `app/`（整目录）、`tests/*.py`、`tests/__init__.py`、`tests/conftest.py`、`requirements.txt`
- Modify: `.gitignore`（去掉 Python 专用项，保留 `node_modules/`、`out/`、`dist/` 等）

**Interfaces:**
- Consumes: M1 翻译后的 `tests/core/*.test.ts`（已覆盖 core 行为）
- Produces: 纯 Node 工程

- [ ] **Step 1: 确认翻译测试已覆盖被删代码**

Run: `npm test` → Expected: 全绿（Python core 的行为已由 `tests/core` 覆盖）
人工核对：`app/core` 的四个模块与 `tests/*.py` 的每一条断言都能在 `tests/core/*.test.ts` 找到对应（M1 Task 10 的对照表）。

- [ ] **Step 2: 删除**

```bash
git rm -r app tests/__init__.py tests/conftest.py tests/test_*.py requirements.txt
```

- [ ] **Step 3: 清理 `.gitignore`**

保留：`node_modules/`、`out/`、`dist/`、`coverage/`、`test-results/`、`playwright-report/`、`build/`（electron-builder 输出目录与我们的 `build/icon.ico` 冲突——`icon.ico` 已被跟踪，`build/` 的忽略规则不影响已跟踪文件，但要在 README 说明）。
删除：`__pycache__/`、`*.pyc`、`.pytest_cache/`、`.venv/`、`*.spec`。

- [ ] **Step 4: 验证工程仍可构建与测试**

Run: `npm test`、`npm run typecheck`、`npm run e2e`
Expected: 全部通过（不再依赖任何 Python）

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "chore: drop the python implementation now that core is ported"
```

---

### Task 5: 文档

**Files:**
- Modify: `README.md`（重写为 Electron 版）
- Modify: `THIRD-PARTY-NOTICES.md`

**Interfaces:**
- Consumes: Task 2 的实测冷启动/体积数据
- Produces: 面向使用者的安装与使用说明

- [ ] **Step 1: 重写 `README.md`**

结构（中文）：

1. 简介：资源管理器右键唤起的小工具，列出变更、勾选、AI 生成提交信息、查看 diff、提交
2. 安装：`npm install` → `npm run package` → `pwsh -File install\install.ps1`；免管理员；如何卸载；Windows 11 的「显示更多选项」
3. 使用：界面分区说明（头部/提交信息/变更列表/diff 面板/动作行/状态栏）、勾选与过滤（全部/无/已添加/已删除/已修改，后三者累加）、默认不显示未受版本控制的文件、快捷键（F5/A/N/U/Esc）、diff 面板行为（红绿/截断/二进制提示）、提交只包含勾选项（重命名带旧路径）
4. 配置：表格列出 `%USERPROFILE%\.git_ai_commit\config.json` 的全部键与默认值（api.url/api_key/model/prompt/max_tokens/language/timeout、git.max_diff_lines、ui.window_width/window_height/show_untracked/style、selection.checked_by_default）；**API Key 明文存储**的提醒；主题目录 `%USERPROFILE%\.git_ai_commit\themes\*.css`（首行 `/* 名称: xxx */`）
5. 从 Python 版升级：配置与路径不变；旧的右键菜单会被新 `install.ps1` 覆盖
6. 开发：`npm run dev` / `npm test` / `npm run typecheck` / `npm run e2e` / `npm run shots` / `npm run package`；目录结构简述；`GIT_AI_COMMIT_CONFIG` 仅供测试
7. 环境要求：Windows + 已安装 Git（PATH 中可找到 `git`）；运行不需要本机 Python/Node
8. 许可与致谢

把 Task 2 实测的冷启动毫秒数与体积写进「安装」小节。

- [ ] **Step 2: 更新 `THIRD-PARTY-NOTICES.md`**

补充：打包产物内含 Electron（MIT）与 Chromium（BSD-3-Clause）及其第三方许可，声明不再依赖 PySide6/Qt。

- [ ] **Step 3: 提交**

```bash
git add README.md THIRD-PARTY-NOTICES.md
git commit -m "docs: rewrite readme for the electron version"
```

---

### Task 6: 收尾验证与验收清单

- [ ] **Step 1: 全量命令**

Run: `npm test`（期望：`tests/core` + `tests/renderer` 全绿）
Run: `npm run typecheck`（期望：无输出）
Run: `npm run e2e`（期望：8 条全绿）
Run: `npm run shots`（期望：三张截图生成）

- [ ] **Step 2: 打包产物全链路**

Run: `npm run package && pwsh -NoProfile -File install\install.ps1 && pwsh -NoProfile -File install\verify.ps1`
Expected: 校验通过；真实右键打开窗口并**真的提交一次**（在临时仓库里做，确认 `git log`）

- [ ] **Step 3: 对照设计文档 §12 验收标准逐条打勾**

1. 右键 → 1s 内出窗口、列出仓库名/路径/分支/变更
2. 勾选与过滤行为一致（含累加勾选、默认勾选已跟踪）
3. 点行显示 diff（红绿 + 行号 + `+/-`，截断/二进制/未跟踪提示）
4. AI 生成成功可编辑、失败弹层不丢输入、生成可取消
5. 提交只含勾选项（重命名带旧路径）、成功后刷新、提交中关窗被拦截
6. 设置改主题即时生效、取消还原、保存写回且不丢其它键
7. `npm test` / `npm run typecheck` / `npm run e2e` 全绿
8. 便携目录在无 Python 的机器可运行；install/uninstall 干净
9. git/AI 调用不阻塞界面（生成中可滚动、切行、看 diff）

- [ ] **Step 4: 合并回 master（需用户确认）**

完成后用 `superpowers:finishing-a-development-branch` 提供合并/保留分支的选项，由用户选择。

## Self-Review

**Spec coverage**：§9 M4（打包/菜单/README/删 Python/MIT 复核）→ T2/T3/T4/T5；§10（便携目录、注册表键、升级覆盖、verify）→ T2/T3；§2 的 Electron/electron-builder 版本 → T2；§11 的「未签名 exe 在他人机器有 SmartScreen 警告」→ T5 在 README 中提示。

**Placeholder scan**：无 TBD；T2 的冷启动数据在 T5 之前由 T2 实测填入（T5 Step 1 明确标注「把实测值写进 README」）。

**Type consistency**：`git-ai-commit.exe` 在 T2/T3/T5 中一致；注册表键在 T3 三个脚本中一致；`GIT_AI_COMMIT_CONFIG` 与 M2/M3 实现一致。
