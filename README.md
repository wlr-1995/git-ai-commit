# AI 提交

在资源管理器里右键任意 Git 仓库目录，勾选要提交的文件 → 让 AI 写提交信息 → 提交。顺手能看每个文件的 diff。

- 平台：Windows（Win10 / Win11）
- 技术栈：Electron + TypeScript（核心逻辑零运行时依赖）
- 免安装、免管理员：只往 `HKCU\Software\Classes` 写一个右键菜单项
- **运行不需要本机装 Python / Node**（打包产物自带 Electron 运行时）

## 安装

### 本机（从源码）

```powershell
# 1. 取源码后安装依赖并打包（需要 Node 20+ 与 Git）
npm install
npm run package          # 产出 dist\win-unpacked\（约 368 MB）

# 2. 注册右键菜单（免管理员）
pwsh -NoProfile -File install\install.ps1

# 3. 校验注册与启动链路
pwsh -NoProfile -File install\verify.ps1
pwsh -NoProfile -File install\verify-launch.ps1
```

### 拷到别的电脑

`dist\win-unpacked\` 就是那个「便携目录」。把它**整个目录**拷过去（放哪都行，如 `D:\Tools\git-ai-commit\`），
里面已经带了 `安装右键菜单.cmd` / `卸载右键菜单.cmd`，**双击「安装右键菜单.cmd」**即可 —— 免管理员，只写当前用户的注册表。

- 别只拷 exe：它依赖同目录的 dll、`resources\`、`locales\`、`version` 等（整个目录 368 MB）
- 目标机器只要有 **Git** 在 PATH 里就行，不需要装 Node / Python
- 目录挪过位置后要**重新双击一次**（注册表里存的是绝对路径）
- 不带 cmd 的场合（如脚本部署）：`powershell -NoProfile -File install.ps1 -Dir "D:\Tools\git-ai-commit"`

装好后在资源管理器里对仓库目录右键 → **AI 提交**（Windows 11 需先点「显示更多选项」）。
`Directory` 与 `Directory\Background`（目录空白处右键）两处都会注册。

### 卸载

```powershell
pwsh -NoProfile -File install\uninstall.ps1    # 移除右键菜单
```

便携目录直接删除即可。用户配置与主题在 `%USERPROFILE%\.git_ai_commit\`，需要彻底清理时手动删除该目录。

### 实测数据（开发机 Win11，打包产物）

| 指标 | 值 |
|---|---|
| 冷启动（首次） | 约 0.6 s |
| 冷启动（之后） | 约 0.4 s |
| 便携目录体积 | 约 368 MB |
| 对照：旧 Python 版依赖 | PySide6 单独 632 MB（另加 Python 本体） |

> 产物未做代码签名，拷到**其它**机器首次运行会有 SmartScreen 提示（本机不影响）。

## 使用

```
┌──────────────────────────────────────────────────────────────┐
│ «仓库名»                  C:\...\repo-path   分支 [main]  [≡]  │
├───────────────────────┬──────────────────────────────────────┤
│ 提交信息              │ README.md                            │
│ [                   ] │ ──────────────────────────────────── │
│ 变更列表  选中  F5 刷新│ @@ -1,2 +1,2 @@                     │
│ 全部(A) 无(N) 已添加… │ +新增行            （淡绿）           │
│ ┌───────────────────┐ │ -删掉的行          （淡红）           │
│ │☑ README.md  … 已修改│ │                                     │
│ └───────────────────┘ │                                      │
│ ☐ 显示未受版本控制的文件│                                     │
├───────────────────────┴──────────────────────────────────────┤
│ [AI 生成] [取消]                   提示…            [提交]   │
│ 共 3 个变更 · 已选 2                                          │
└──────────────────────────────────────────────────────────────┘
```

- **勾选**：点勾选框切换；点行的其它位置 = 选中该行并在右侧显示它的 diff（不影响勾选）
- **过滤**：`全部(A)` / `无(N)` 是全选 / 全不选；`已添加` / `已删除` / `已修改` 只**累加勾选**，不会取消别的勾选
- **默认不显示未受版本控制的文件**（它们也不会被提交）；勾上开关才列出
- **快捷键**：`F5` 刷新；`Ctrl+,` 打开设置；表格聚焦时 `A` 全选 / `N` 全不选 / `U` 切换未跟踪开关；`Esc` 关闭弹层
- **设置**在顶栏右上角（次级工具，图标按钮）；打开设置也可按 `Ctrl+,`
- **diff 面板**：加行淡绿、删行淡红、`@@` 行灰底；行首保留 `+` / `-` 前缀（不只靠颜色）；只显示文本前 `git.max_diff_lines` 行并在标题处标注「已截断」；二进制与超大未跟踪文件给出说明条而不是乱码
- **AI 生成**：按勾选的改动调用 OpenAI 兼容接口（`/chat/completions`），结果填进输入框可继续编辑；生成中可取消；失败弹层提示且不清空你已写的内容
- **提交**：只提交勾选的路径（重命名会自动带上旧路径，避免旧文件删除被留在暂存区）；提交不可取消，提交中关闭窗口会被拦下并提示「正在提交，请稍候…」
- 所有 git / AI 调用都在主进程异步执行，界面不会卡住

## 配置

配置文件：`%USERPROFILE%\.git_ai_commit\config.json`（不存在时自动写入默认值；坏文件/缺键自动回退或补齐）

| 键 | 默认值 | 说明 |
|---|---|---|
| `api.url` | `http://localhost:11434/v1` | OpenAI 兼容接口地址，会拼 `/chat/completions` |
| `api.api_key` | `ollama` | 请求头 `Authorization: Bearer <key>` |
| `api.model` | `qwen2.5-coder:7b` | 模型名 |
| `api.prompt` | `""` | 自定义提示词；为空则按 `api.language` 生成默认提示词 |
| `api.max_tokens` | `8192` | 大于 0 才随请求发送 |
| `api.language` | `中文` | 默认提示词里要求的输出语言 |
| `api.timeout` | `60` | 请求超时（秒），设置界面限制 1–600 |
| `git.max_diff_lines` | `200` | 送给 AI 与 diff 面板共用的最大行数 |
| `ui.window_width` / `ui.window_height` | `1100` / `640` | 开窗尺寸（最小 560×420） |
| `ui.show_untracked` | `false` | 启动时是否显示未受版本控制的文件 |
| `ui.style` | `light` | 主题 key（见下） |
| `selection.checked_by_default` | `tracked` | 默认勾选策略：`tracked` / `all` / `none` |

**API Key 是明文存在配置文件里的**：本机小工具，不做加密（加密材料同样在本机）。建议用权限受限的密钥。

### 主题

- 内置：`light`「克制工具（浅色）」
- 外置：把任意 `.css` 丢进 `%USERPROFILE%\.git_ai_commit\themes\`，就是一个新主题；文件名（去 `.css`）即 key，首行写 `/* 名称: 我的主题 */` 决定下拉里的显示名；与内置同名时以外置为准
- 设置界面里切换主题会**当场生效**，取消则还原，保存才写进配置

CSS 变量见 `src/renderer/styles/tokens.css`（例如 `--accent`、`--add-bg`、`--row-height`）。

## 从旧 Python 版升级

- **配置与主题路径不变**，`config.json` 直接继续用
- 旧的 `ui.style` 值 `traditional` 会自动回退到内置的 `light`（旧 `.qss` 样式文件不再使用，可删除）
- 右键菜单会被新的 `install.ps1` 覆盖（同一个注册表键），无需先手动清理
- 旧 Python 实现已从仓库移除，需要时可在 git 历史里查到

## 开发

```powershell
npm install            # 依赖（postinstall 会下载 Electron 二进制）
npm run dev            # 开发模式（渲染层热更新）
npm test               # 单元测试（vitest：核心逻辑 + 界面纯逻辑）
npm run typecheck      # tsc --noEmit
npm run e2e            # 端到端（Playwright 驱动真实 Electron + 真临时仓库）
npm run shots          # 抓三张界面截图到 %TEMP%\electron-shots\
npm run package        # 打包便携目录
```

### 目录结构

```
src/
  core/        git 子进程、状态解析、diff、AI 客户端、配置（纯逻辑，禁止 import electron）
  shared/      三端共用的通道常量与类型（含渲染层要用的状态常量，零依赖）
  main/        Electron 主进程：窗口、IPC 处理、主题扫描
  preload/     contextBridge 白名单（渲染层拿不到 Node）
  renderer/    界面：state.ts（纯函数）/ render.ts（DOM）/ components/ / styles/
tests/
  core/        移植自旧 Python 测试的核心行为测试
  renderer/    界面纯逻辑测试
  e2e/         Playwright 端到端
install/       右键菜单安装/卸载/校验脚本
docs/          设计文档与实施计划（含各里程碑的取舍与实测记录）
```

### 说明

- 渲染层开了 `contextIsolation` + `sandbox`，所有能力都经 preload 白名单暴露；仓库路径先做「必须落在仓库内」校验，diff 一律用 `textContent` 写入
- `GIT_AI_COMMIT_CONFIG` 环境变量可覆盖配置文件路径，仅供端到端测试隔离使用
- `npm test` 的覆盖率门：`src/core` 行覆盖 ≥ 90%（当前 96%+）

## 许可与致谢

见 `THIRD-PARTY-NOTICES.md`。
