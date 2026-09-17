# Electron 重写 — 设计文档

- 日期：2026-09-17
- 状态：待评审
- 目标平台：Windows（开发机 Win10/11，Node 24.18.0 / npm 11.16.0 / Electron 44.4.1）
- 取代：`app/` 下的 PySide6 实现，以及 `2026-09-17-styles-as-files-design.md`、`2026-09-17-settings-dialog-design.md` 两阶段的成果（两阶段已合并 master，其代码与测试保留在 git 历史中）

## 1. 背景与目标

现有 PySide6 实现功能完整（变更列表勾选、AI 生成提交信息、按勾选提交、设置界面、多套样式），但**界面观感不可接受**（用户判定「Qt 界面太丑」）。用 Electron + TypeScript 全量重写。

目标：

1. 功能对齐现有实现（含已确立的行为细节，见 §6）
2. **新增 diff 预览**：点左侧列表某一行，右栏显示该文件的 unified diff
3. 视觉：左右分栏布局 + 「克制工具」风格（白底、1px 浅灰描边、圆角 6px、行高 30px、蓝色强调、除弹层外无阴影）
4. 分发：electron-builder 出**便携目录**，无需本机 Python/Node，`install.ps1` 注册 HKCU 右键菜单指向 exe

### 已确认的决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 核心逻辑 | **TypeScript 全量重写**，不用 sidecar 保留 Python | 避免双运行时（打包体积 + 环境耦合）、避免跨语言 IPC 序列化面、测试可全在一套 vitest 里跑；Python 版留在 git 历史可查 |
| 移植验收 | 现有 **594 行 core 测试逐条翻译**成 vitest | 用既有行为当规格，避免重写时悄悄改变语义 |
| 功能边界 | 现有功能 + diff 预览 | 历史/amend 不做 |
| 配色 | 放开色彩但克制 | diff 红绿、状态语义色、单一强调色；整体仍浅色干净 |
| 打包 | 便携目录（`win-unpacked`） | 冷启 ~1s（单文件自解压要 2-4s，右键唤起体验不可接受） |

### 非目标

- 跨平台（只 Windows）、自动更新、代码签名
- 深色主题（本次不做；主题机制已支持外置 CSS，后续加不需改架构）
- 提交历史浏览、amend、多仓库管理
- Python 版继续维护（M4 从工作树删除，历史保留）

## 2. 技术栈

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | 24.18.0 | 已安装（`node -v` 实测） |
| npm | 11.16.0 | 已安装 |
| Electron | 44.4.1 | `npm view electron version` 实测，无代理延迟 |
| TypeScript | 7.0.2 | `strict: true`；若 electron-vite / vitest 与之不兼容，回退 `^5.9`（见 §11） |
| electron-vite | 5.0.0 | main / preload / renderer 一体化构建 + 渲染层 HMR |
| electron-builder | 26.15.3 | `win` target = `dir`（便携目录） |
| vitest | 5.0.1 | core 单测（node 环境）+ 渲染层逻辑测（jsdom 30.1.0） |
| @playwright/test | 1.63.0 | `electron.launch()` 端到端 |
| 运行时依赖 | **无** | 不引入 UI 框架、不引入 HTTP 库（用主进程内置 `fetch`） |

**不引入 UI 框架**（React/Vue）：界面只有「一个主窗口 + 一个设置弹层 + 一个 diff 面板 + 一个错误弹层」，手写 TS + DOM 足够；省掉一层构建链、减少体积与冷启动开销。渲染层用一个 ~150 行的 `render(state)` 全量重绘模型（列表最多几百行，性能无关）。

## 3. 目录结构

```
git-ai-commit/
├─ package.json
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ tsconfig.json
├─ src/
│  ├─ core/                     # 纯逻辑，禁止 import electron
│  │  ├─ gitcmd.ts
│  │  ├─ repo.ts
│  │  ├─ ai.ts
│  │  ├─ config.ts
│  │  ├─ diff.ts                # 新增
│  │  └─ types.ts               # FileChange / RepoSnapshot / IPC 结果类型
│  ├─ main/
│  │  ├─ index.ts               # 入口：argv 解析、仓库校验、建窗口、生命周期
│  │  └─ ipc.ts                 # 通道注册与参数校验
│  ├─ preload/
│  │  └─ index.ts               # contextBridge 白名单
│  └─ renderer/
│     ├─ index.html
│     ├─ main.ts                # 启动、状态管理、事件绑定
│     ├─ render.ts              # render(state) 全量重绘
│     ├─ components/
│     │  ├─ change-list.ts
│     │  ├─ diff-view.ts
│     │  ├─ settings-dialog.ts
│     │  └─ error-dialog.ts
│     └─ styles/
│        ├─ tokens.css          # 设计令牌（唯一颜色来源）
│        ├─ app.css
│        └─ themes/light.css    # 内置主题「克制工具」
├─ tests/
│  ├─ core/*.test.ts
│  ├─ renderer/*.test.ts
│  ├─ e2e/*.spec.ts
│  └─ helpers/                  # 临时仓库构造、假 HTTP 服务
├─ install/{install,uninstall,verify}.ps1
└─ docs/
```

## 4. 进程边界与 IPC

### 4.1 安全设置

`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`。渲染层拿不到 `require`/`fs`/`child_process`，只能调用 preload 暴露的白名单。

### 4.2 通道契约

所有 handler 返回**判别联合**而非抛异常（Electron 对 Error 的序列化会丢掉 `code` 与自定义字段）：

```ts
type Ok<T> = { ok: true; value: T }
type Err = { ok: false; error: { code: ErrorCode; message: string } }
type Result<T> = Ok<T> | Err
```

| 通道 | 入参 | 返回 |
|---|---|---|
| `repo:load` | — | `Result<RepoSnapshot>`，`RepoSnapshot = { branch, changes: FileChange[], stats: Record<string, [number\|null, number\|null]> }` |
| `diff:read` | `path: string` | `Result<{ path, lines: DiffLine[], truncated: boolean, note?: string }>` |
| `ai:generate` | `paths: string[]` | `Result<{ message: string }>`（可被 `ai:cancel` 中止） |
| `ai:cancel` | — | `Result<void>` |
| `commit` | `{ paths: string[], message: string }` | `Result<{ stdout: string }>` |
| `config:get` | — | `Result<AppConfig>` |
| `config:save` | `partial: Partial<AppConfig>` | `Result<AppConfig>`（返回重载后的完整配置） |
| `themes:list` | — | `Result<{ key, label }[]>` |

错误码：`GIT_NOT_FOUND` / `GIT_TIMEOUT` / `GIT_FAILED` / `NOT_A_REPO` / `PATH_OUTSIDE_REPO` / `NO_SELECTION` / `EMPTY_MESSAGE` / `AI_NO_URL` / `AI_HTTP` / `AI_BAD_RESPONSE` / `CONFIG_WRITE` / `UNKNOWN`。

### 4.3 路径校验（关键）

`diff:read` 的 `path` 来自渲染层，必须：

1. `path.resolve(repoRoot, p)` 后判断是否在 `repoRoot` 之内（用 `path.relative` 结果不以 `..` 开头且不是绝对路径；Windows 下大小写不敏感比较）
2. 拒绝含 `\0` 的字符串
3. 越界 → `PATH_OUTSIDE_REPO`

理由：diff 面板会渲染仓库内容，虽然本机工具，也不给注入可乘之机；渲染层一律用 `textContent` 写入，不碰 `innerHTML`。

### 4.4 启动与窗口

- 起始路径：`process.argv` 中第一个非 `-` 开头的参数，否则 `process.cwd()`（对齐现有 `resolve_start_path`）
- 打包后 argv 形态变化需处理：Electron 打包 exe 的 `argv[0]` 是 exe 路径，右键菜单传的 `"%V"` 会是 `argv[1]`；实现里统一「跳过 electron/exe 自身与所有 `-` 开头的参数」的取法，并在 M4 用真实右键菜单验证
- 不是 git 仓库 → 用 `dialog.showErrorBox` 提示「该目录不是 Git 仓库：<path>」，退出码 1（对齐现有行为，避免右键「毫无反应」）
- 启动阶段的任何异常（仓库校验、配置读取、窗口创建）都必须弹窗后再退出：从资源管理器拉起时**没有控制台**（现有 Python 版用 `pythonw.exe` 时踩过同一个坑，`show_fatal` 即为此存在）
- 允许同一仓库多开窗口（与现有「每次右键一个新进程」一致），不做单实例锁
- 窗口标题 `«仓库名» — AI 提交`，尺寸读 `config.ui.window_width/height`（默认 **1100×640**，最小 560×420；Qt 版是 720×520，这里放大是因为左右分栏需要更多横向空间）；不做自动保存尺寸（现有实现也不回写）

## 5. core 移植规格

逐函数对齐；下表「要点」列是移植时必须保持的语义（也是翻译测试的断言点）。

### 5.1 `core/gitcmd.ts`

| 项 | 规格 |
|---|---|
| `runGit(args, { cwd, timeoutMs = 60_000, check = true })` | 返回 `{ code, stdout, stderr }` |
| 命令前缀 | `["git", "-c", "core.quotepath=false", ...args]` |
| 环境变量 | 继承 `process.env` 并置 `GIT_LITERAL_PATHSPECS=1`（文件名里的 `* ? [` 不作通配） |
| 解码 | stdout/stderr 用 `utf8` 解码，非法字节替换（`Buffer.toString("utf8")` 语义等同 Python 的 `errors="replace"`） |
| 实现 | `child_process.spawn` + 收集 chunk（**不用 `execFile`**：其默认 `maxBuffer` 1 MB 会在大仓库 `status -z` 时截断，这是相对 Python 版的必要差异） |
| 超时 | `setTimeout` 到点 `kill()`，抛 `GitError("git 命令超时: <args>")` |
| 错误映射 | 工作目录不存在/不是目录 → `工作目录无效（不存在或不是目录）: <cwd>`；`ENOENT` → `找不到 git 命令，请确认已安装 Git 并加入 PATH`；其它 spawn 失败 → `git 命令无法执行: <msg>`；`check && code !== 0` → `GitError(stderr.trim() \|\| \`git 退出码 ${code}: ${args}\`)` |

### 5.2 `core/repo.ts`

| 导出 | 规格与要点 |
|---|---|
| 状态常量 | `MODIFIED/ADDED/DELETED/RENAMED/UNTRACKED/CONFLICTED` = 现有字符串值；`STATUS_LETTER`、`STATUS_TEXT` 映射原样（`M/A/D/R/?/!`，`已修改/已添加/已删除/已重命名/未版本控制/冲突`） |
| `UNKNOWN_BRANCH` | `"未知"` |
| `MAX_UNTRACKED_BYTES` | `512 * 1024` |
| `FileChange` | `{ path: string; status: string; origPath: string \| null }` |
| `findRepoRoot(startPath)` | `rev-parse --show-toplevel`；非零退出或 spawn 失败 → `null`；结果 `trim()` 后为空 → `null` |
| `currentBranch(repoRoot)` | 先 `symbolic-ref --short -q HEAD`；失败再 `rev-parse --short HEAD` 返回 `游离 HEAD (<sha>)`；都失败 `未知` |
| `statusOf(xy)` | `??`→未跟踪；含 `U` 或 `AA`/`DD`→冲突；含 `R`→重命名；含 `D`→删除；含 `A`→添加；否则修改（**顺序不能变**） |
| `parsePorcelainZ(text)` | 按 `\0` 切分；跳过空串与 `!!` 开头；`xy = entry.slice(0,2)`、`path = entry.slice(3)`；`xy` 含 `R` 或 `C` 时**消费下一段**为 `origPath`（无论该段是否为空都要 `index++`）；重命名为「先新路径后旧路径」 |
| `listChanges(repoRoot)` | `status --porcelain -z` → `parsePorcelainZ` |
| `hasCommits(repoRoot)` | `rev-parse --verify HEAD` 退出码 0 |
| `truncate(text, maxLines)` | `maxLines <= 0` 原样返回；按 `\r\n`/`\r`/`\n` 切分，**输入以换行结尾时丢弃末尾空串**（对齐 Python `splitlines()` 的可观察行为）；超出则 `lines.slice(0, maxLines).join("\n") + "\n... (已截断，省略 " + omitted + " 行)"`。注：Python `splitlines()` 还认 `\v \f \x85 \u2028`，git 输出中不会出现，不额外仿真（翻译测试如需覆盖再加） |
| `_diffOne(repoRoot, path)` | 先 `diff HEAD -- <path>`，成功且`trim()` 非空则返回；否则读工作区文件：最多读 `512KiB + 1` 字节；读失败 → `### 新增或不可读文件: <path>`；超限 → `### 新增文件过大，已跳过: <path>（超过 512 KB）`；含 `\0` → `### 新增疑似二进制文件，已跳过: <path>`；否则逐行加 `+` 前缀 → `### 新增文件: <path>\n<body>` |
| `diffFor(repoRoot, paths, maxLines = 200)` | 逐个 `_diffOne`，丢弃空段，`\n` 连接后 `truncate`（AI 提示词用的字符串 API） |
| `readDiff(repoRoot, path, maxLines)` | 新增（供 diff 面板）：`_diffOne` 后按行切分，返回 `{ text, truncated, omitted }`；`truncate()` 在它之上实现，保证两条路径的省略语义完全一致 |
| `numstatNewPath(raw)` | 含 `{...}` 时取 `{}` 内 ` => ` 之后的新名并拼回前后缀；否则取 ` => ` 之后 |
| `diffNumstat(repoRoot)` | `diff --numstat HEAD`；非零退出 → `{}`；按 `\t` 切分且段数 ≥3；`added/deleted` 为纯数字串才转 number，否则 `null`（二进制）；路径 = `parts.slice(2).join("\t")` 再过 `numstatNewPath`；键为新路径 |
| `commitPathspecs(changes)` | 每个 change 带 `path`；`status === RENAMED && origPath` 且旧路径未出现过时追加 `origPath` |
| `stage(repoRoot, paths)` | 空数组直接返回；`add -A -- <paths>`，`check: false`（尽力而为，真正校验在 commit） |
| `commit(repoRoot, message, paths)` | 空数组抛 `GitError("没有勾选任何文件")`；`commit -m <message> -- <paths>`；非零退出抛 `GitError(stderr \|\| stdout \|\| "git commit 失败")`；成功返回 `stdout.trim()` |

### 5.3 `core/ai.ts`

| 导出 | 规格与要点 |
|---|---|
| `stripThink(text)` | 移除 `<think>...</think>`（跨行，正则 `s` 语义）后 `trim()` |
| `buildPrompt(cfg)` | `prompt` 非空优先；否则「你是一个专业程序员。请根据提供的 git diff 生成一条简洁、准确的提交信息，使用<language>，只输出提交信息本身，不要输出解释、引号或 markdown 标记。」，`language` 默认 `中文` |
| `generateCommitMessage(diffText, cfg, { signal })` | `url` 缺失 → `未配置 api.url，请先填写配置文件`；POST `«url.rstrip('/')»/chat/completions`，body `{ model, messages: [system, user], stream: false }`，`max_tokens > 0` 才带上；头 `Content-Type: application/json` + `Authorization: Bearer <api_key ?? ''>`；超时用 `AbortSignal.timeout(cfg.timeout ?? 60) * 1000` 与外部 `signal` 组合；错误文案：网络/超时 → `AI 请求失败：<原因>`，状态码非 200 → `AI 返回 <code>：<body 前 500 字>`，JSON 解析失败 → `AI 返回的不是合法 JSON`，无 `choices` → `AI 返回缺少 choices`，内容空 → `AI 未返回有效内容` |

用 Node 原生 `fetch`（Electron 主进程内置），不引第三方 HTTP 库。

### 5.4 `core/config.ts`

| 项 | 规格 |
|---|---|
| `DEFAULT_CONFIG` | 逐键与现有一致：`api { url: "http://localhost:11434/v1", api_key: "ollama", model: "qwen2.5-coder:7b", prompt: "", max_tokens: 8192, language: "中文", timeout: 60 }`、`git { max_diff_lines: 200 }`、`ui { window_width: 720, window_height: 520, show_untracked: false, style: "light" }`、`selection { checked_by_default: "tracked" }` |
| `CONFIG_FILE` | `path.join(os.homedir(), ".git_ai_commit", "config.json")`（**路径不变**，现有用户的配置继续可用） |
| `deepMerge(base, override)` | 递归合并，返回新对象，不改入参 |
| `loadConfig(path?)` | 文件不存在 → 写默认并返回；JSON 解析失败 / 读失败 / 顶层不是对象 → 返回默认副本 |
| `saveConfig(config, path?)` | `mkdir -p` 父目录；`JSON.stringify(config, null, 2)`（UTF-8、不转义中文、**无尾随换行**，与 Python `json.dump` 输出一致） |

`ui.style` 的兼容映射：旧值 `"traditional"`（Qt 时代的 key）→ `"light"`；未知值 → `"light"`（对应现有的「未知样式回退默认」）。

### 5.5 `core/diff.ts`（新增）

```ts
type DiffLineKind = "meta" | "hunk" | "add" | "del" | "ctx" | "note"
interface DiffLine { kind: DiffLineKind; text: string }
function parseDiff(text: string): DiffLine[]
```

分类规则（**两段式，避免 `+++` 歧义**）：首个 `@@` 出现之前属文件头，`diff --git` / `index ` / `--- ` / `+++ ` / `\ No newline` 全部归 `meta`；首个 `@@` 之后属正文，按 `@@` → `hunk`、`+` 开头 → `add`、`-` 开头 → `del`、`\ No newline` → `meta`、其余 → `ctx` 判定（即正文里 `+++foo` 是「新增行 `++foo`」，不会被误判成文件头）。`### ` 开头（未跟踪文件的提示行）无论位置都归 `note`。行号由渲染层按 `add`/`del`/`ctx` 顺序计算展示。

## 6. 界面规格

### 6.1 布局（左右分栏）

```
┌──────────────────────────────────────────────────────────────────┐
│ «仓库名»            C:\...\repo-path                  分支 [main] │  头部
├────────────────────────┬─────────────────────────────────────────┤
│ 提交信息               │ README.md                               │
│ [                        │ ─────────────────────────────────────  │
│   textarea 3 行          │ @@ -1,2 +1,2 @@                        │
│ ]                        │ +hello world            (淡绿)          │
│                        │ -hello                  (淡红)          │
│ 变更列表   选中 全部(A) 无(N) │                                       │
│ 已添加 已删除 已修改  F5 刷新│                                       │
│ ┌──────────────────────┐ │                                      │
│ │☑ README.md  .md 已修改 +1 -1│                                 │
│ │☑ 新建…txt  .txt 已添加 +0 -0│                                 │
│ └──────────────────────┘ │                                      │
│ ☐ 显示未受版本控制的文件  │                                       │
├────────────────────────┴─────────────────────────────────────────┤
│ [设置] [AI 生成] [取消]  hint ………………                       [提交] │  动作行
│ 共 2 个变更 · 已选 2                                              │  状态栏
└──────────────────────────────────────────────────────────────────┘
```

- 分栏比例：左栏 `min 320px / 默认 380px / max 50%`，中间为可拖拽分隔条（拖拽结果不持久化）
- 窗口宽度 < 760px 时右栏自动折叠为「按需滑出」形态（点行后覆盖左栏，Esc 关闭）——保证窄窗口可用。阈值 760px 同时写在 `app.css` 的 `@media` 与 `main.ts` 的 `matchMedia`（媒体查询不吃 CSS 变量），默认开窗 1100px 因此始终是分栏形态

### 6.2 组件与行为（对齐现有实现）

| 区域 | 行为 |
|---|---|
| 头部 | 仓库名 + 完整路径（中间省略 + `title` 提示）；分支胶囊，`title` = 「当前分支：<branch>」 |
| 提交信息 | `textarea`，占位符「填写提交信息，或用「AI 生成」按改动生成」；输入变化触发汇总刷新 |
| 变更列表 | 列：路径 / 扩展名 / 状态 / 添加行数 / 删除行数；数字列右对齐；`null` 显示 `-`，未统计留空；路径列中间省略 + `title` |
| 勾选交互 | 点勾选框切换勾选；点行其它位置 = 选中该行并加载其 diff（**不**切换勾选）；支持 Shift 连选？**不做**（现有实现也没有） |
| 过滤 | `全部(A)` / `无(N)` / `已添加` / `已删除` / `已修改`；前三者之外的三个是**累加勾选**，不取消其它已勾选项；`已修改` 同时匹配「已修改」与「已重命名」 |
| 快捷键 | `F5` 刷新；表格聚焦时 `A`/`N` 应用过滤、`U` 切换未跟踪开关；`Esc` 关闭 diff 滑出/弹层 |
| 未跟踪开关 | 默认取 `config.ui.show_untracked`（默认 `false`）；切换只影响显示，不写回配置（现有实现亦不写回） |
| 勾选默认值 | 取 `config.selection.checked_by_default`（`tracked` / `all` / `none`，默认 `tracked`）；**刷新拿到新快照时**按默认值重算；切换未跟踪开关只重绘并按路径**保留**已有勾选（对齐现有 `_render_rows` 的 previous 语义） |
| 空状态 | 无可见行时覆盖提示：无变更 → 「工作区干净 / 没有需要提交的改动」；被过滤 → 「未显示任何文件 / 可勾选「显示未受版本控制的文件」后再看」 |
| 状态栏 | `共 {total} 个变更 · 已选 {selected}`；忙碌时改为操作文案（「正在生成…」/「正在提交…」）；出错时「错误：<摘要>」 |
| 动作提示 | `hint`：有行未勾选 → 「请先勾选要提交的文件」；有行无信息 → 「请填写提交信息」 |
| 提交按钮 | 可用条件 = `已勾选数 > 0 && 信息非空 && !busy`（现有实现曾出现「工作区干净时仍可点」的回归，测试要钉住） |
| 忙碌态 | 生成中：生成按钮禁用、取消按钮可用；提交中：生成与取消都禁用（提交不可取消） |
| 关窗 | 提交进行中 → 拦截关闭并提示「正在提交，请稍候…」（避免隐藏真实发生的提交）；生成进行中 → 先 `ai:cancel` 再关 |
| 设置弹层 | 模态；分组「外观」（主题下拉，切换**即时预览**）与「模型」（接口地址 / 模型名 / API Key（`type=password`）/ 超时（1–600 秒））；保存禁用条件 = 接口地址为空 + 提示「接口地址不能为空」；保存失败（写盘 OSError）→ 保持打开、保留输入；取消/Esc → 还原原主题；保存成功 → 状态栏「设置已保存」 |
| 错误弹层 | 摘要 = 首行截断 120 字符（超出加 `…`，空则「发生未知错误」）；下方可展开完整信息；替代 `QMessageBox` |

### 6.3 设计令牌（`styles/tokens.css`，样式 1「克制工具」）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--bg` | `#ffffff` | 窗口底色 |
| `--surface-muted` | `#f8fafc` | 表头、hunk 行底色 |
| `--border` | `#e4e7ec` | 1px 描边、分隔线 |
| `--border-strong` | `#d0d5dd` | 输入框、按钮描边 |
| `--text` | `#0f172a` | 正文 |
| `--text-muted` | `#64748b` | 次级信息、数字列、扩展名列 |
| `--accent` | `#2563eb` | 主按钮、选中态、链接 |
| `--accent-ink` | `#ffffff` | 强调色上的文字 |
| `--add-bg` / `--add-fg` | `#dcfce7` / `#14532d` | diff 新增行 |
| `--del-bg` / `--del-fg` | `#fee2e2` / `#7f1d1d` | diff 删除行 |
| `--status-modified` | `#b45309` | 状态列「已修改」 |
| `--status-added` | `#15803d` | 「已添加」 |
| `--status-deleted` | `#b91c1c` | 「已删除」 |
| `--status-renamed` | `#6d28d9` | 「已重命名」 |
| `--status-untracked` | `--text-muted` | 「未版本控制」 |
| `--status-conflicted` | `#b91c1c` + 加粗 | 「冲突」 |
| 行高 / 圆角 / 间距 | `30px` / `6px` / 4·8·12·16·24 | 与现有 4/8/12/16/24 刻度一致 |
| 字体 | `"Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif`；等宽 `Consolas, "Cascadia Mono", monospace` | 基准 13px，表头 12px |

主题机制：`tokens.css` 定义变量，`themes/light.css` 提供一套赋值；外置主题扫 `%USERPROFILE%\.git_ai_commit\themes\*.css`（文件名 → key，首行 `/* 名称: xxx */` → 显示名，缺省用文件名；与 Qt 版 `.qss` 的约定一致），在 `<head>` 里挂 `<link>` 切换。外置主题 key 与内置同名时**外置优先**（可覆盖内置样式）。写入 `config.ui.style`。

### 6.4 diff 面板

- 标题行：文件路径 + （截断时）「已截断」标记
- 行号列：`add`/`del`/`ctx` 各显示对应新旧行号（Git 风格：新增行显示新行号、删除行显示旧行号），`+`/`-` 前缀保留（不只靠颜色区分）
- 截断：面板与 AI 用**同一个** `config.git.max_diff_lines`（单旋钮，不新增配置）；`truncated === true` 时标题行显示「已截断，省略 N 行」
- 二进制文件与超限文件：显示 core 返回的 `note` 文本（`### ...` 行渲染为提示条）
- 切换文件时给请求打序号，乱序返回的旧响应丢弃
- 空选区（未选中任何行）：显示「选择左侧文件查看改动」

## 7. 数据流

| 流程 | 步骤 |
|---|---|
| 启动 | 解析 argv → `findRepoRoot`（失败弹窗 + 退出码 1）→ 建窗口 → 渲染层 ready → `repo:load` → `render(state)` |
| 刷新 | `repo:load`（主进程内 `currentBranch` / `listChanges` / `diffNumstat` 并发执行；均为只读，无索引锁风险）；提交/AI 进行中则置 `pendingRefresh`，结束后再跑（对齐现有排队语义） |
| 勾选 / 过滤 / 未跟踪开关 | 纯渲染层状态变更 + 重绘，**不**走 IPC |
| 点行看 diff | `diff:read(path)` → `parseDiff` → 渲染；请求序号防乱序 |
| AI 生成 | 主进程 `diffFor(勾选路径, max_diff_lines)` → 空则报「勾选的文件没有可分析的改动」→ `generateCommitMessage`；成功填入 textarea 并提示「已生成，可编辑后提交」；失败弹错误层且**不清空**已有输入；`ai:cancel` → `AbortController.abort()`，状态栏「已取消」 |
| 提交 | 「提交信息不能为空」「请先勾选至少一个文件」前置校验 → `stage(勾选路径)` → `commit(message, commitPathspecs)` → 成功弹「提交成功」+ 刷新；失败弹错误层 |
| 设置保存 | `config:save(partial)`（只含 `api` 四键 + `ui.style`）→ 主进程 `deepMerge` + 写盘 + 返回重载配置 → 渲染层应用主题 + 状态栏「设置已保存」 |

## 8. 测试策略

| 层 | 工具 | 内容 |
|---|---|---|
| core | vitest（node 环境） | **现有 594 行 Python core 测试逐条翻译**：`test_gitcmd.py`、`test_repo_status.py`、`test_repo_commit.py`、`test_repo_numdiff_*`、`test_config.py`、`test_ai.py`；`test_worker.py` 的语义映射为「AI 生成可取消、取消不报错」，并入 `ai` 相关测试 |
| core 新增 | vitest | `parseDiff` 分类规则（含 `+++`/`---` 与 `@@` 消歧、`\ No newline`、`### ` 提示行）；`truncate` 边界；`numstatNewPath` 花括号形式；`commitPathspecs` 重命名去重 |
| 渲染层逻辑 | vitest + jsdom | `render(state)` 的输出结构：状态文案、「共 N 个变更 · 已选 M」、hint 文案、提交按钮可用性矩阵、空状态两种文案、表格行数受未跟踪开关影响 |
| IPC | vitest | `gitcmd`/`repo`/`ai` 错误 → 错误码映射表；`diff:read` 路径逃逸（`../`、绝对路径、`\0`）被拒 |
| 端到端 | Playwright + `electron.launch()` | ① 启动加载列表（真临时仓库）② 勾选 + 提交（断言 `git log`）③ AI 生成（本地假 HTTP 服务，含 `<think>` 剥离）④ 设置保存回环（写临时 `CONFIG_FILE`）⑤ 点行看 diff（断言加/删行渲染） |
| 人工 | 截图 | 2-3 张验收图（列表 + diff、设置弹层、错误弹层），不做像素级断言 |

**现有 125 个 Python 测试的处置**：约 40 个 core 测试翻译保留；约 85 个 Qt 控件/样式/像素测试（`test_main_window.py` 793 行、`test_theme.py` 311 行、`test_settings_dialog.py` 138 行）**作废**，能力由上面的 jsdom + E2E 两层替代。M4 删除 `app/`、`tests/*.py`、`conftest.py`、`requirements.txt`。

覆盖率门：`src/core` 行覆盖 ≥ 90%（翻译测试的实质要求）。

## 9. 里程碑

| 里程碑 | 内容 | 验收门 |
|---|---|---|
| M1 脚手架 + core | electron-vite/vitest/tsconfig 就位；`src/core` 全部实现；翻译测试 + 新增 core 测试 | **已完成**（2026-09-17）：`tests/core` 9 文件 96 用例全绿、`tsc --noEmit` 干净、core 行覆盖 96.6%；4 处变异检查（porcelain 偏移、numstat 花括号、readDiff 截断标记、diff 的 `###` 块）均如预期失败 |
| M2 骨架 + 最小界面 | main/preload/renderer；列表、勾选、过滤、未跟踪开关、刷新、提交、空状态、状态栏、动作行；Playwright 启动冒烟 | **已完成**（2026-09-17）：E2E 8 条覆盖 ①②③④④b⑤⑤b⑥，真临时仓库上「勾选 → 提交」用 `git log` 断言通过 |
| M3 完整界面 | diff 面板、AI 生成 + 取消、设置弹层 + 主题、错误弹层、忙碌态、快捷键、窄窗折叠 | **已完成**（2026-09-17）：`npm run shots` 三张截图逐张人工核对通过；期间修掉 5 个真实缺陷（见下方「实现期发现的问题」） |
| M4 打包与切换 | electron-builder 便携目录；`install.ps1`/`uninstall.ps1`/`verify.ps1` 改指向 exe；README 重写；删除 Python 实现与测试；MIT 声明复核 | 卸旧菜单 → 跑新 `install.ps1` → 资源管理器右键「AI 提交」打开新窗口并能提交真实改动；`verify.ps1` 通过 |

## 10. 打包与分发
- `electron-builder.yml`：`appId: com.xingqiong.git-ai-commit`、`productName: AI 提交`、`win.target: dir`（输出 `dist/win-unpacked/`）、`files` 只含构建产物、`asar: true`、图标 `build/icon.ico`
- 目录内容：`AI 提交.exe` + `resources/app.asar` + Electron 运行时，约 220–260 MB
- 右键菜单：`HKCU\Software\Classes\Directory\shell\AIGitCommit`
  - 默认值 `"AI 提交"`
  - `command` 默认值 `"«安装目录»\AI 提交.exe" "%V"`
  - `Icon` = exe 路径（自带图标）
  - 旧的 `pythonw.exe app\main.py` command 会被同键覆盖，天然完成升级；`uninstall.ps1` 删除整个 `AIGitCommit` 键
- `verify.ps1`：检查注册表 command 指向的文件存在、打印结果
- 升级：覆盖安装目录即可（无安装器）；`%USERPROFILE%\.git_ai_commit\config.json` 不动，配置与主题跨版本保留

### 实现期发现的问题（M2/M3 期间修掉，均为设计盲区）

| 现象 | 根因 | 处置 |
|---|---|---|
| 启动后打开了**项目目录**而不是被点选的仓库 | `electron . <dir>` 时 `argv[1]` 是应用目录本身 | `resolveStartPath` 用 `process.defaultApp` 跳过它（§4.4） |
| 头部路径与被点选路径不一致（`C:/x` vs `C:\x`） | git `--show-toplevel` 在 Windows 返回正斜杠 | 拿到后 `normalize()`（对齐 Qt 版的 `os.path.normpath`） |
| 渲染层构建失败：`node:child_process` 被打进浏览器包 | 渲染层 import 了 `core/repo` 的**值**（状态常量/中文名） | 抽出零依赖的 `src/shared/changes.ts`，core 与渲染层共用 |
| 表格被空状态整片盖住 | `[hidden]` 的 `display: none` 被 `.empty-state { display: flex }` 压过 | 补 `.empty-state[hidden] { display: none }` |
| 默认窗口下右栏 diff 一直折叠 | 默认宽 720px 小于窄窗阈值 820px | 默认改 1100×640、阈值改 760px（§4.4/§6.1） |
| 路径列宽度塌成 0、状态列显示「已修…」 | `td { max-width: 0 }` + 自动表格布局 + 左栏 380px 装不下 5 列 | 改 `table-layout: fixed` + 显式列宽 + 左栏默认 560px（最小 420px） |
| 点行只切换了勾选、diff 不出现 | 点击命中了行内的 checkbox（事件绑在 `td`） | 点击事件绑到 `tr`，`event.target === checkbox` 时跳过 |
| 网络错误只显示 `fetch failed` | Node 的 fetch 把真实原因放在 `error.cause` | 错误文案优先取 `cause.message` |

## 11. 风险

| 风险 | 缓解 |
|---|---|
| 冷启动 ~1s（Qt 约 0.4s） | 便携目录不做自解压；主进程不加载重型依赖（core 只有 `child_process`/`fs`/`fetch`）；M4 实测右键到窗口可见的耗时并记录 |
| `porcelain -z` 与 numstat 在 JS 里的字节/编码细节 | 逐条翻译的测试钉死（引号路径、含空格/中文/`*` 的文件名、重命名、二进制、空仓库） |
| `spawn` 收集 stdout 的编码与分片 | `Buffer.concat` 后一次性解码（不在 chunk 边界解码，避免多字节字符被截断） |
| Node `fetch` 与 `requests` 的异常文案不同 | 测试只断言前缀「AI 请求失败：」，底层原因不写死 |
| TypeScript 7 是原生重写版（`tsgo`），工具链可能尚未完全跟上 | M1 第一步就验证 `electron-vite` + `vitest` + `tsc --noEmit` 三者同时可用；有任一不兼容立即回退 `^5.9`，此时只影响版本号不影响设计 |
| `sandbox: true` 下 preload 的能力限制 | preload 只做 `contextBridge` + `ipcRenderer.invoke`，不用 Node 模块；若不兼容可退到 `sandbox: false` 但仍保持 `contextIsolation: true`（M2 验证） |
| 长路径（>260 字符）与 8.3 短名导致路径比较误判 | 路径校验用 `fs.realpath` 归一后再比较；测试覆盖含空格/中文路径 |
| Playwright + Electron 在 Windows 上的稳定性 | E2E 只覆盖 5 条关键流程，失败时保留 trace 截图；不做像素断言 |
| 一次重写面大（893 行 UI + 440 行 core + 594 行测试） | M1-M4 分段，每段可运行可验收；core 先可信再动界面 |
| 未签名 exe 在他人机器有 SmartScreen 警告 | 本机不受影响；要对外分发时再谈签名（非目标） |
| 现有 `.qss` 样式文件与 `ui.style` 旧值 | `traditional` 映射为 `light`，未知值回退 `light`；主题机制改为 CSS，旧的 `.qss` 文件在 M4 随 Python 版删除 |

## 12. 验收标准
1. 资源管理器右键仓库目录 → 窗口 1s 内出现，显示仓库名、路径、分支与变更列表
2. 勾选/过滤/快捷键/未跟踪开关行为与现有一致（含「累加勾选」与「默认勾选已跟踪」）
3. 点某行右栏显示该文件 diff：加行淡绿、删行淡红、`@@` 灰底、行号 + `+/-` 前缀；超限/二进制/未跟踪新增文件给提示条
4. AI 生成：成功填入可编辑；失败弹错误层且不丢已有输入；生成可取消
5. 提交：只提交勾选路径（重命名带旧路径）、成功后刷新；提交中关窗被拦截
6. 设置：改主题当场生效、取消还原、保存写回 `%USERPROFILE%\.git_ai_commit\config.json`，未暴露的键（`prompt`/`max_tokens`/`max_diff_lines` 等）不被改写
7. `npm test` 全绿（core 覆盖 ≥90%）、`npm run typecheck` 干净、Playwright E2E 5 条全绿
8. 便携目录在**未装 Python**的机器上可直接运行；`install.ps1` 注册菜单、`uninstall.ps1` 干净移除
9. 所有 git/AI 调用不阻塞界面：AI 生成期间可滚动列表、切换选中、查看 diff
