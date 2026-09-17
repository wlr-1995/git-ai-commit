# Git AI Commit（资源管理器右键 AI 提交工具）— 设计文档

- 日期：2026-09-17
- 状态：待评审
- 目标平台：Windows（开发机 Win10/11，Python 3.12+）

## 1. 背景与目标

TortoiseGit 提交窗口的 AI 插件（如 TSvnCMG）需要注册 COM 组件，安装麻烦且会阻塞界面。本项目提供一个**零注册**的替代：

- 在资源管理器右键菜单里加一项「AI 提交」，唤起一个独立小程序
- 程序显示当前仓库的变更文件列表（可勾选、带状态标记），用本地/远程 OpenAI 兼容接口生成提交信息，确认后提交

### 目标（v1）
1. 右键文件夹直接唤起程序（免管理员、免 COM 注册）
2. 显示变更文件列表，每个文件可勾选，带状态标记（M/A/D/R/?）
3. 点按钮用 AI 生成提交信息，结果可手动编辑
4. 提交**仅勾选**的文件

### 非目标（v2 或以后）
- diff 预览
- amend（修正上次提交）
- push
- 提交信息历史下拉
- 新式（Windows 11 一级）右键菜单
- 多仓库/批量操作

## 2. 约束

- 机器上没有 .NET SDK、没有 dotnet、没有 Visual Studio；有 Python 3.13、Node 24、PowerShell 7、git 2.55
- 不安装 Ollama（由使用者自行提供 AI 服务）；程序只按 OpenAI 兼容协议对接
- 右键菜单必须免管理员 → 写 `HKCU\Software\Classes`
- 生成过程不得阻塞界面（要能取消）

## 3. 技术选型

- 语言/运行时：Python（开发机为 3.13）
- GUI：PySide6
- HTTP：requests
- Git：调用 `git.exe` 子进程（不引 libgit2 绑定）
- 新增依赖：`PySide6`、`requests`

### 开源底座（复用，MIT）
以 [`duolabmeng6/ai_git_commit_gui`](https://github.com/duolabmeng6/ai_git_commit_gui)（MIT）为底座，复用其三个核心模块：

| 原文件 | 复用内容 |
|---|---|
| `git_diff_analyzer.py` | `git status --porcelain` 解析、逐文件 diff、二进制识别、diff 截断 |
| `ai_interface.py` | OpenAI 兼容 `POST {base_url}/chat/completions`、重试、超时、提示词 |
| `config.py` | JSON 配置读写与深合并 |

需保留 MIT 许可与第三方声明（`THIRD-PARTY-NOTICES.md`）。

参考（不复制代码）：
- `sourcegit-scm/sourcegit`（MIT）— AI 服务与 Git GUI 设计参考
- `gitextensions/gitextensions`（GPL-3.0）— **仅作 UI/UX 参考，禁止复制代码**

## 4. 目录结构

```
git-ai-commit/
├─ app/
│  ├─ main.py                 # 入口：argv 接收仓库路径，定位仓库根，启动窗口
│  ├─ ui/
│  │  ├─ main_window.py       # 主窗口：文件列表(勾选+状态) + 信息框 + 按钮
│  │  └─ worker.py            # QThread 工作线程：分析 / 生成 / 提交，支持取消
│  └─ core/
│     ├─ repo.py              # 仓库操作：status / diff / stage 选中 / commit 选中
│     ├─ ai.py                # OpenAI 兼容调用（含 <think> 剥离）
│     ├─ config.py            # 配置读写
│     └─ gitcmd.py            # git 子进程安全封装
├─ install/
│  ├─ install.ps1             # 写 HKCU 右键菜单（免管理员）
│  └─ uninstall.ps1           # 删除右键菜单
├─ tests/
├─ docs/superpowers/specs/
├─ requirements.txt           # PySide6, requests
├─ THIRD-PARTY-NOTICES.md
└─ README.md
```

## 5. 组件职责

### 5.1 `core/gitcmd.py`
- `run_git(args, cwd, check)`：封装 `subprocess.run`，统一超时、编码（UTF-8）、错误信息
- 保证路径含空格/中文时正确传参（参数列表，不经 shell）

### 5.2 `core/repo.py`
- `find_repo_root(path) -> str`：`git rev-parse --show-toplevel`；失败抛「非 Git 仓库」
- `list_changes() -> list[FileChange]`：解析 `git status --porcelain`
  - `path: str`
  - `status: enum(modified|added|deleted|renamed|untracked|conflicted)`
- `diff_for(paths) -> str`：对给定路径取 diff（含未跟踪文件全文），按 `max_diff_lines` 截断
- `stage(paths)`：`git add -A -- <paths>`（处理新增/修改/删除）
- `commit(message, paths)`：`git commit -m <message> -- <paths>`
- `has_commits()`：仓库是否已有提交（空仓库时 diff 基线为 index）

### 5.3 `core/ai.py`
- `generate_commit_message(diff_text) -> str`
- 读取配置里的 `url / api_key / model / prompt / max_tokens / language`
- 剥离思考模型输出中的 `<think>...</think>`
- 失败抛出带原因的异常（供 UI 展示）

### 5.4 `core/config.py`
- 位置：`%USERPROFILE%\.git_ai_commit\config.json`
- schema：
```json
{
  "api": {
    "url": "http://localhost:11434/v1",
    "api_key": "ollama",
    "model": "qwen2.5-coder:7b",
    "prompt": "",
    "max_tokens": 8192,
    "language": "中文"
  },
  "git": { "max_diff_lines": 200 },
  "ui": { "window_width": 720, "window_height": 520 },
  "selection": { "checked_by_default": "tracked" }
  // checked_by_default 取值： "tracked"(已跟踪改动勾选、未跟踪不勾) | "all" | "none"
}
```
- 首次运行若文件不存在则写出默认值
- 深合并：缺失键回退默认值

### 5.5 `ui/main_window.py`
- 顶部：仓库路径 + 当前分支（只读文本）
- 中部：`QListWidget`，每项左侧复选框，文本 `[M] src/a.py`
  - 状态到字母映射：modified→`M`、added/untracked→`A`/`?`、deleted→`D`、renamed→`R`、conflicted→`!`
  - 默认勾选策略：**已跟踪改动默认勾选，未跟踪文件默认不勾选**（`selection.checked_by_default = "tracked"`）
  - 「全选」「全不选」按钮
- 下部：提交信息多行编辑框
- 按钮区：「AI 生成」（生成中禁用 + 显示进度 + 「取消」）、「提交」
- 状态栏：提示信息

### 5.6 `ui/worker.py`
- `AnalyzeWorker`：列出变更（线程执行）
- `GenerateWorker`：取 diff + 调 AI
- `CommitWorker`：stage + commit
- 均继承 `QThread`，通过 signal 回传成功/失败；支持 `cancel()`

## 6. 数据流

```
Explorer 右键文件夹
   → pythonw app\main.py "<folder>"
   → find_repo_root() 失败则提示并退出
   → AnalyzeWorker: git status --porcelain → 文件列表(默认勾选)
   → 用户勾选文件
   → 点「AI 生成」→ GenerateWorker: 取勾选文件 diff(截断) → POST AI → 回填信息框
   → 用户编辑信息
   → 点「提交」→ CommitWorker: stage(勾选) → commit(信息, 勾选路径)
   → 成功提示并关闭
```

### commit 语义（关键，需测试验证）
目标：**只提交勾选的文件**，不影响其它已暂存内容。
- 勾选的未跟踪文件：先 `git add -A -- <path>`
- 然后 `git commit -m <msg> -- <勾选路径列表>`
- 待验证：纯删除、重命名、路径含空格/中文、部分提交、仓库无初始提交

## 7. 右键菜单集成

`install.ps1`（免管理员）写入：

```
HKCU\Software\Classes\Directory\shell\AIGitCommit
  (Default) = "AI 提交"
  Icon = <pythonw 或程序图标>
  command
    (Default) = pythonw "<install_dir>\app\main.py" "%V"

HKCU\Software\Classes\Directory\Background\shell\AIGitCommit   (同上)
```

- `%V` 对目录项为所选文件夹路径；`Directory\Background` 用于文件夹内空白处右键
- 安装脚本需自解析自身所在目录，避免硬编码
- `uninstall.ps1` 删除上述键
- 备注：Windows 11 默认折叠在「显示更多选项」中，属已知限制

## 8. 错误处理

| 场景 | 行为 |
|---|---|
| 不是 Git 仓库 | 提示「该目录不是 Git 仓库」并退出 |
| 无任何变更 | 列表为空，提示，禁用「提交」 |
| AI 连接失败/超时 | 状态栏红色错误信息，**不清空**已填内容，可重试 |
| 未配置 api_key/url | 提示先填写配置，并给「打开配置文件」按钮 |
| git commit 失败（钩子拒绝、无 user.name/email） | 展示 git stderr 原文 |
| 用户取消生成 | 线程安全终止，恢复按钮状态 |

## 9. 测试策略

- 单元测试（pytest）
  - `git status --porcelain` 各状态解析（含重命名）
  - 路径含空格、中文、特殊字符
  - diff 截断逻辑
  - 配置深合并与默认值
  - `<think>` 剥离
- 集成测试：在临时目录 `git init`，构造改动，断言「只提交勾选文件」
- 手工冒烟：右键菜单唤起 → 勾选 → 生成 → 提交

## 10. 交付物 / 里程碑

1. M1：core 三层（gitcmd/repo/config/ai）完成 + 单测通过
2. M2：UI 窗口完成，可分析/勾选/生成/提交
3. M3：`install.ps1` / `uninstall.ps1`，右键菜单可用
4. M4：README + 第三方声明；手工冒烟通过

## 11. 风险

- `git commit -- <paths>` 的部分提交语义在边界场景下需实测（M1 验证）
- 大 diff 超出本地模型上下文 → 通过 `max_diff_lines` 截断缓解
- PySide6 体积较大（约 200MB 安装），仅开发/运行环境需要
- Windows 11 右键菜单层级问题（见 §7）

## 12. 许可

- 本项目沿用底座代码的 MIT 许可；保留 `THIRD-PARTY-NOTICES.md`
- 明确不复制 GPL 项目（Git Extensions 等）的代码
