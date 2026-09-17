# Git AI 提交

在 Windows 资源管理器里右键一个文件夹，勾选要提交的改动，让 AI 根据 diff 生成提交信息，然后只提交勾选的文件。

## 功能简介

- 右键文件夹 →「AI 提交」，自动定位该目录所属的 Git 仓库。
- 列出所有未提交的变更，每项前显示状态字母（`M` 修改 / `A` 新增 / `D` 删除 / `R` 重命名 / `?` 未跟踪 / `!` 冲突）。
- 按配置决定默认勾选：已跟踪文件默认勾选、未跟踪文件默认不勾选。
- 调用 OpenAI 兼容接口，根据勾选文件的 diff 生成提交信息，可人工编辑后再提交。
- **只提交勾选的文件**：其它已暂存但未勾选的内容会保持原样，不受影响。
- AI 生成在后台线程执行，界面不会卡死；生成过程可「取消」。提交过程不可取消，以免隐藏已经发生的提交。

## 环境要求

- Windows
- Python 3.12 或更高版本（已在 Python 3.13 上验证）
- Git 已安装并加入 `PATH`
- 一个 OpenAI 兼容的模型接口（例如本地 Ollama、各类云端服务）

## 安装

在项目根目录执行：

```powershell
python -m pip install -r requirements.txt
pwsh -File install\install.ps1
```

- `requirements.txt` 包含 `PySide6`、`requests`、`pytest`。
- `install\install.ps1` 会在 **当前用户**（`HKCU`）下写入注册表，为「文件夹」和「文件夹空白处」注册右键菜单项「AI 提交」，**无需管理员权限**。
- 安装后 Windows 11 需在右键菜单的「显示更多选项」里才能看到该条目（见「已知限制」）。

入口命令为：

```
pythonw.exe "<项目路径>\app\main.py" "%V"
```

## 配置

配置文件位于：

```
%USERPROFILE%\.git_ai_commit\config.json
```

首次运行时若文件不存在，程序会按默认值自动创建。文件为 UTF-8 编码的 JSON，缺失的字段会自动用默认值补齐。字段说明：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `api.url` | `http://localhost:11434/v1` | OpenAI 兼容接口的 base 地址，**必须以 `/v1` 结尾**。程序会请求 `{api.url}/chat/completions`。 |
| `api.api_key` | `ollama` | 接口密钥，会作为 `Authorization: Bearer <key>` 发送。本地服务可留任意值。 |
| `api.model` | `qwen2.5-coder:7b` | 使用的模型名。 |
| `api.language` | `中文` | 未自定义提示词时，生成提交信息使用的语言。 |
| `api.prompt` | `""`（空） | 自定义系统提示词。非空时优先于 `api.language`；留空则使用内置默认提示词。 |
| `api.max_tokens` | `8192` | 生成的最大 token 数；`<= 0` 时该参数不发送。 |
| `api.timeout` | `60` | 请求超时（秒）。 |
| `git.max_diff_lines` | `200` | 送入模型的 diff 最大行数，超出部分会截断并标注省略行数。 |
| `selection.checked_by_default` | `tracked` | 默认勾选策略：`tracked` = 已跟踪默认勾选、未跟踪默认不勾选；`all` = 全部勾选；`none` = 全部不勾选。 |
| `ui.window_width` | `720` | 主窗口初始宽度（像素）。 |
| `ui.window_height` | `520` | 主窗口初始高度（像素）。 |

示例：

```json
{
  "api": {
    "url": "https://api.openai.com/v1",
    "api_key": "sk-xxxx",
    "model": "gpt-4o-mini",
    "language": "中文",
    "prompt": "",
    "max_tokens": 8192,
    "timeout": 60
  },
  "git": { "max_diff_lines": 200 },
  "ui": { "window_width": 720, "window_height": 520 },
  "selection": { "checked_by_default": "tracked" }
}
```

> 注意：`api.url` 必须以 `/v1` 结尾，不要再自行拼接 `/chat/completions`。

## 使用步骤

1. 在资源管理器中右键点击一个 Git 仓库内的文件夹（或其空白处）。
2. 选择「AI 提交」（Windows 11 在「显示更多选项」中）。
3. 在列表中勾选要提交的文件，可用「全选」「全不选」快速操作。
4. 点击「AI 生成」，等待后台生成提交信息（此过程可「取消」）。未配置 `api.url` 时会给出明确错误提示。
5. 在「提交信息」框中按需编辑。
6. 点击「提交」。**只有勾选的文件会被提交**，其它已暂存内容保持不变。

若选择的目录不在任何 Git 仓库内，会弹出「该目录不是 Git 仓库」提示。

## 卸载

```powershell
pwsh -File install\uninstall.ps1
```

该脚本会删除 `HKCU` 下注册的右键菜单项。配置文件 `%USERPROFILE%\.git_ai_commit\config.json` 不会被删除，可手动清理；Python 依赖可用 `python -m pip uninstall PySide6 requests` 移除。

## 已知限制

- **Windows 11**：右键菜单项位于「显示更多选项」（经典菜单）中，不会出现在精简菜单里。
- v1 不提供 diff 预览、不提供 `git commit --amend`、不提供 `push`（计划在 v2）。
- 只根据勾选文件的 diff 生成信息；一次只处理一个仓库。

## 测试

```powershell
python -m pytest -v
```

覆盖配置读写、git 命令封装、变更解析、diff 采集与截断、仅提交勾选路径、AI 客户端以及后台 worker 等逻辑。

## Windows / conda 的 PySide6 环境说明

在 conda 基础环境（例如 `C:\Users\<你>\miniconda3`）中，conda 自带的 `Library\bin\icuuc.dll`（ICU 78，只导出带版本号的符号，如 `ucnv_open_78`）会遮蔽 Windows 系统自带的 `icuuc.dll`（导出不带版本号的 `ucnv_open` 等）。PySide6 的 `Qt6Core.dll` 依赖后者不带版本号的符号，于是 `import PySide6` 会抛出 `ImportError: DLL load failed ... (0xc0000139)`。

程序已自动处理该问题：`app/bootstrap.py` 会在导入 PySide6 之前把系统 `System32` 注册为 DLL 搜索目录，从而让系统 ICU 优先命中。该逻辑在 `app/__init__.py` 中被触发，`app/main.py` 也会显式调用，因此产品和测试都能正常工作。

如果仍遇到 DLL 加载问题，使用一个干净的独立虚拟环境是更彻底的做法，例如：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```
