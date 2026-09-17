# Git AI Commit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个免注册的 Windows 资源管理器右键工具，显示 Git 变更文件（可勾选、带状态），用 OpenAI 兼容接口生成提交信息，并只提交勾选的文件。

**Architecture:** Python 包 `app/` 分三层：`core/`（无 UI 的纯逻辑，全部可单测）、`ui/`（PySide6 窗口与 QThread 工作线程）、入口 `main.py`。Git 一律通过 `git.exe` 子进程调用；AI 通过 `requests` 打 `POST {url}/chat/completions`。右键菜单写 `HKCU`，免管理员。

**Tech Stack:** Python 3.12+、PySide6、requests、pytest、git.exe、PowerShell（安装脚本）

## Global Constraints

- 平台：Windows（Win10/11），不得依赖 .NET / Visual Studio
- Python 版本：3.12+（开发机 3.13.13）
- 运行时依赖仅：`PySide6`、`requests`；开发依赖：`pytest`
- Git 必须走参数列表调用 `git.exe`，禁止 `shell=True`
- 注册表只写 `HKCU\Software\Classes`，禁止需要管理员
- 所有 git/AI 调用不得在 UI 主线程执行（必须放 `QThread`）
- 配置文件路径：`%USERPROFILE%\.git_ai_commit\config.json`
- 文案使用中文
- 复用 MIT 底座 `duolabmeng6/ai_git_commit_gui` 的思路，保留 `THIRD-PARTY-NOTICES.md`；禁止复制 GPL 项目代码

---

### Task 1: 项目骨架 + 配置模块

**Files:**
- Create: `.gitignore`
- Create: `requirements.txt`
- Create: `app/__init__.py`
- Create: `app/core/__init__.py`
- Create: `app/ui/__init__.py`
- Create: `app/core/config.py`
- Create: `tests/__init__.py`
- Create: `tests/test_config.py`
- Create: `THIRD-PARTY-NOTICES.md`

**Interfaces:**
- Consumes: 无
- Produces:
  - `DEFAULT_CONFIG: dict`、`CONFIG_FILE: pathlib.Path`
  - `load_config(path: Path | None = None) -> dict`
  - `save_config(config: dict, path: Path | None = None) -> None`
  - `deep_merge(base: dict, override: dict) -> dict`

- [ ] **Step 1: 创建骨架文件**

`.gitignore`
```
__pycache__/
*.pyc
.pytest_cache/
.venv/
build/
dist/
*.spec
```

`requirements.txt`
```
PySide6
requests
pytest
```

`THIRD-PARTY-NOTICES.md`
```markdown
# Third-Party Notices

本项目的 Git 变更分析与 AI 调用思路参考了以下 MIT 许可项目，代码为改写实现：

- **duolabmeng6/ai_git_commit_gui** — MIT — https://github.com/duolabmeng6/ai_git_commit_gui

以下项目仅作设计参考，未复制任何代码：

- **sourcegit-scm/sourcegit** — MIT — https://github.com/sourcegit-scm/sourcegit
- **gitextensions/gitextensions** — GPL-3.0 — 仅参考 UI/UX，未复制代码
```

`app/__init__.py`、`app/core/__init__.py`、`app/ui/__init__.py`、`tests/__init__.py` 均为空文件。

- [ ] **Step 2: 安装开发依赖**

Run: `python -m pip install -r requirements.txt`
Expected: 成功安装（PySide6 较大，约需 1-3 分钟）

- [ ] **Step 3: 写失败的测试 `tests/test_config.py`**

```python
import json
from pathlib import Path

from app.core.config import DEFAULT_CONFIG, deep_merge, load_config, save_config


def test_deep_merge_keeps_defaults_for_missing_keys():
    base = {"a": {"x": 1, "y": 2}, "b": 3}
    merged = deep_merge(base, {"a": {"y": 9}})
    assert merged == {"a": {"x": 1, "y": 9}, "b": 3}


def test_load_config_creates_file_with_defaults(tmp_path: Path):
    cfg_file = tmp_path / "sub" / "config.json"
    cfg = load_config(cfg_file)
    assert cfg["selection"]["checked_by_default"] == "tracked"
    assert cfg_file.exists()


def test_load_config_merges_partial_file(tmp_path: Path):
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps({"api": {"model": "custom"}}), encoding="utf-8")
    cfg = load_config(cfg_file)
    assert cfg["api"]["model"] == "custom"
    assert cfg["api"]["url"] == DEFAULT_CONFIG["api"]["url"]


def test_load_config_survives_broken_json(tmp_path: Path):
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text("{ this is not json", encoding="utf-8")
    cfg = load_config(cfg_file)
    assert cfg["git"]["max_diff_lines"] == 200


def test_save_config_roundtrip_unicode(tmp_path: Path):
    cfg_file = tmp_path / "config.json"
    cfg = load_config(cfg_file)
    cfg["api"]["language"] = "中文"
    save_config(cfg, cfg_file)
    raw = cfg_file.read_text(encoding="utf-8")
    assert "中文" in raw
    assert load_config(cfg_file)["api"]["language"] == "中文"
```

- [ ] **Step 4: 运行测试确认失败**

Run: `python -m pytest tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.core.config'`

- [ ] **Step 5: 实现 `app/core/config.py`**

```python
"""配置读写：JSON 文件 + 默认值深合并。"""

import copy
import json
from pathlib import Path

DEFAULT_CONFIG: dict = {
    "api": {
        "url": "http://localhost:11434/v1",
        "api_key": "ollama",
        "model": "qwen2.5-coder:7b",
        "prompt": "",
        "max_tokens": 8192,
        "language": "中文",
        "timeout": 60,
    },
    "git": {"max_diff_lines": 200},
    "ui": {"window_width": 720, "window_height": 520},
    "selection": {"checked_by_default": "tracked"},
}

CONFIG_FILE: Path = Path.home() / ".git_ai_commit" / "config.json"


def deep_merge(base: dict, override: dict) -> dict:
    """递归合并 override 到 base 的副本上。"""
    result = copy.deepcopy(base)
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def load_config(path: Path | None = None) -> dict:
    """读取配置；文件不存在则写出默认配置。坏文件回退默认值。"""
    path = Path(path) if path else CONFIG_FILE
    if not path.exists():
        config = copy.deepcopy(DEFAULT_CONFIG)
        save_config(config, path)
        return config
    try:
        with path.open("r", encoding="utf-8") as handle:
            loaded = json.load(handle)
    except (json.JSONDecodeError, OSError):
        return copy.deepcopy(DEFAULT_CONFIG)
    if not isinstance(loaded, dict):
        return copy.deepcopy(DEFAULT_CONFIG)
    return deep_merge(DEFAULT_CONFIG, loaded)


def save_config(config: dict, path: Path | None = None) -> None:
    """写出配置（UTF-8，保留中文）。"""
    path = Path(path) if path else CONFIG_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2, ensure_ascii=False)
```

- [ ] **Step 6: 运行测试确认通过**

Run: `python -m pytest tests/test_config.py -v`
Expected: PASS（5 passed）

- [ ] **Step 7: 提交**

```bash
git add .gitignore requirements.txt THIRD-PARTY-NOTICES.md app tests
git commit -m "feat: project scaffold and config module"
```

---

### Task 2: Git 子进程封装

**Files:**
- Create: `app/core/gitcmd.py`
- Create: `tests/test_gitcmd.py`

**Interfaces:**
- Consumes: 无
- Produces:
  - `class GitError(RuntimeError)`
  - `run_git(args: list[str], cwd, timeout: int = 60, check: bool = True) -> tuple[int, str, str]`

- [ ] **Step 1: 写失败的测试 `tests/test_gitcmd.py`**

```python
import subprocess

import pytest

from app.core.gitcmd import GitError, run_git


def _git_available() -> bool:
    try:
        subprocess.run(["git", "--version"], capture_output=True, check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


pytestmark = pytest.mark.skipif(not _git_available(), reason="需要 git")


def test_run_git_returns_stdout(tmp_path):
    code, out, err = run_git(["--version"], cwd=tmp_path)
    assert code == 0
    assert "git version" in out


def test_run_git_raises_on_failure(tmp_path):
    with pytest.raises(GitError):
        run_git(["rev-parse", "--verify", "HEAD"], cwd=tmp_path)


def test_run_git_check_false_does_not_raise(tmp_path):
    code, out, err = run_git(["rev-parse", "--verify", "HEAD"], cwd=tmp_path, check=False)
    assert code != 0


def test_run_git_handles_non_ascii_and_space_paths(tmp_path):
    import os

    repo = tmp_path / "含 空格 的 目录"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
    target = repo / "文 件.txt"
    target.write_text("hello", encoding="utf-8")
    code, out, err = run_git(["status", "--porcelain"], cwd=repo)
    assert "文 件.txt" in out
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest tests/test_gitcmd.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.core.gitcmd'`

- [ ] **Step 3: 实现 `app/core/gitcmd.py`**

```python
"""git.exe 子进程封装：统一编码、超时与错误信息。"""

import subprocess
from pathlib import Path

_GIT_PREFIX = ["git", "-c", "core.quotepath=false"]


class GitError(RuntimeError):
    """git 命令失败。"""


def run_git(
    args: list[str],
    cwd,
    timeout: int = 60,
    check: bool = True,
) -> tuple[int, str, str]:
    """执行 git 命令，返回 (returncode, stdout, stderr)。

    check=True 时非零退出码抛 GitError。
    """
    command = [*_GIT_PREFIX, *args]
    try:
        proc = subprocess.run(
            command,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise GitError("找不到 git 命令，请确认已安装 Git 并加入 PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise GitError(f"git 命令超时: {' '.join(args)}") from exc

    stdout = proc.stdout.decode("utf-8", errors="replace")
    stderr = proc.stderr.decode("utf-8", errors="replace")
    if check and proc.returncode != 0:
        raise GitError(stderr.strip() or f"git 退出码 {proc.returncode}: {' '.join(args)}")
    return proc.returncode, stdout, stderr


def ensure_dir(path) -> Path:
    """规范化目录路径。"""
    return Path(path).resolve()
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m pytest tests/test_gitcmd.py -v`
Expected: PASS（4 passed）

- [ ] **Step 5: 提交**

```bash
git add app/core/gitcmd.py tests/test_gitcmd.py
git commit -m "feat: git subprocess wrapper"
```

---

### Task 3: 仓库发现与变更列表

**Files:**
- Create: `app/core/repo.py`
- Create: `tests/test_repo_status.py`

**Interfaces:**
- Consumes: `run_git`, `GitError`（Task 2）
- Produces:
  - 状态常量：`MODIFIED/ADDED/DELETED/RENAMED/UNTRACKED/CONFLICTED`
  - `STATUS_LETTER: dict[str, str]`
  - `@dataclass FileChange(path: str, status: str, orig_path: str | None = None)`
  - `find_repo_root(start_path) -> str | None`
  - `parse_porcelain(text: str) -> list[FileChange]`
  - `list_changes(repo_root) -> list[FileChange]`
  - `has_commits(repo_root) -> bool`

- [ ] **Step 1: 写失败的测试 `tests/test_repo_status.py`**

```python
import subprocess
import pytest

from app.core.repo import (
    ADDED,
    DELETED,
    MODIFIED,
    UNTRACKED,
    FileChange,
    find_repo_root,
    has_commits,
    list_changes,
    parse_porcelain,
)


def _init_repo(path):
    subprocess.run(["git", "init"], cwd=path, capture_output=True, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=path, capture_output=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=path, capture_output=True)


def test_parse_porcelain_basic():
    text = " M a.py\n?? b 文件.txt\n D c.py\n"
    changes = parse_porcelain(text)
    assert changes == [
        FileChange(path="a.py", status=MODIFIED),
        FileChange(path="b 文件.txt", status=UNTRACKED),
        FileChange(path="c.py", status=DELETED),
    ]


def test_parse_porcelain_rename():
    text = "R  old.py -> new.py\n"
    changes = parse_porcelain(text)
    assert changes[0].status == "renamed"
    assert changes[0].path == "new.py"
    assert changes[0].orig_path == "old.py"


def test_parse_porcelain_ignores_ignored():
    assert parse_porcelain("!! cache/\n") == []


def test_find_repo_root_returns_none_outside_repo(tmp_path):
    assert find_repo_root(tmp_path) is None


def test_find_repo_root_inside_repo(tmp_path):
    _init_repo(tmp_path)
    sub = tmp_path / "sub"
    sub.mkdir()
    root = find_repo_root(sub)
    assert root is not None
    assert find_repo_root(tmp_path) == root


def test_list_changes_reports_untracked_and_modified(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "tracked.txt").write_text("v1", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=tmp_path, capture_output=True, check=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=tmp_path, capture_output=True, check=True)
    (tmp_path / "tracked.txt").write_text("v2", encoding="utf-8")
    (tmp_path / "new.txt").write_text("x", encoding="utf-8")

    changes = {c.path: c.status for c in list_changes(tmp_path)}
    assert changes["tracked.txt"] == MODIFIED
    assert changes["new.txt"] == UNTRACKED


def test_has_commits(tmp_path):
    _init_repo(tmp_path)
    assert has_commits(tmp_path) is False
    (tmp_path / "a.txt").write_text("a", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=tmp_path, capture_output=True, check=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=tmp_path, capture_output=True, check=True)
    assert has_commits(tmp_path) is True
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest tests/test_repo_status.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.core.repo'`

- [ ] **Step 3: 实现 `app/core/repo.py`（本任务只含状态部分）**

```python
"""Git 仓库操作：变更列表、diff、暂存、提交。"""

from dataclasses import dataclass
from pathlib import Path

from .gitcmd import GitError, run_git

MODIFIED = "modified"
ADDED = "added"
DELETED = "deleted"
RENAMED = "renamed"
UNTRACKED = "untracked"
CONFLICTED = "conflicted"

STATUS_LETTER = {
    MODIFIED: "M",
    ADDED: "A",
    DELETED: "D",
    RENAMED: "R",
    UNTRACKED: "?",
    CONFLICTED: "!",
}


@dataclass(frozen=True)
class FileChange:
    path: str
    status: str
    orig_path: str | None = None


def find_repo_root(start_path) -> str | None:
    """返回仓库根目录；不是仓库则返回 None。"""
    code, out, _ = run_git(["rev-parse", "--show-toplevel"], cwd=start_path, check=False)
    if code != 0:
        return None
    root = out.strip()
    return root or None


def _status_of(xy: str) -> str:
    if xy == "??":
        return UNTRACKED
    if "U" in xy or xy in ("AA", "DD"):
        return CONFLICTED
    if "R" in xy:
        return RENAMED
    if "D" in xy:
        return DELETED
    if "A" in xy:
        return ADDED
    return MODIFIED


def parse_porcelain(text: str) -> list[FileChange]:
    """解析 `git status --porcelain` 输出。"""
    changes: list[FileChange] = []
    for line in text.splitlines():
        if not line or line.startswith("!!"):
            continue
        xy = line[:2]
        raw = line[3:]
        orig: str | None = None
        if "R" in xy and " -> " in raw:
            orig, raw = raw.split(" -> ", 1)
        changes.append(FileChange(path=raw, status=_status_of(xy), orig_path=orig))
    return changes


def list_changes(repo_root) -> list[FileChange]:
    """列出未提交的变更。"""
    _, out, _ = run_git(["status", "--porcelain"], cwd=repo_root)
    return parse_porcelain(out)


def has_commits(repo_root) -> bool:
    """仓库是否已有 HEAD 提交。"""
    code, _, _ = run_git(["rev-parse", "--verify", "HEAD"], cwd=repo_root, check=False)
    return code == 0
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m pytest tests/test_repo_status.py -v`
Expected: PASS（7 passed）

- [ ] **Step 5: 提交**

```bash
git add app/core/repo.py tests/test_repo_status.py
git commit -m "feat: repo discovery and change listing"
```

---

### Task 4: 变更 diff 采集与截断

**Files:**
- Modify: `app/core/repo.py`（追加函数）
- Create: `tests/test_repo_diff.py`

**Interfaces:**
- Consumes: Task 2、Task 3
- Produces:
  - `diff_for(repo_root, paths: list[str], max_lines: int = 200) -> str`
  - `truncate(text: str, max_lines: int) -> str`

- [ ] **Step 1: 写失败的测试 `tests/test_repo_diff.py`**

```python
import subprocess

from app.core.repo import diff_for, truncate


def _init_repo(path):
    subprocess.run(["git", "init"], cwd=path, capture_output=True, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=path, capture_output=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=path, capture_output=True)


def test_truncate_returns_text_when_short():
    assert truncate("a\nb", 10) == "a\nb"


def test_truncate_keeps_head_and_marks_omitted():
    text = "\n".join(f"line{i}" for i in range(10))
    result = truncate(text, 3)
    assert result.startswith("line0\nline1\nline2")
    assert "省略 7 行" in result


def test_diff_for_modified_file(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "a.py").write_text("one\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=tmp_path, capture_output=True, check=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=tmp_path, capture_output=True, check=True)
    (tmp_path / "a.py").write_text("one\ntwo\n", encoding="utf-8")

    diff = diff_for(tmp_path, ["a.py"])
    assert "+two" in diff


def test_diff_for_untracked_file_shows_content(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "new 文件.txt").write_text("hello\nworld\n", encoding="utf-8")

    diff = diff_for(tmp_path, ["new 文件.txt"])
    assert "新增文件" in diff
    assert "+hello" in diff
    assert "+world" in diff


def test_diff_for_multiple_paths(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "a.txt").write_text("a\n", encoding="utf-8")
    (tmp_path / "b.txt").write_text("b\n", encoding="utf-8")

    diff = diff_for(tmp_path, ["a.txt", "b.txt"])
    assert "+a" in diff
    assert "+b" in diff
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest tests/test_repo_diff.py -v`
Expected: FAIL — `ImportError: cannot import name 'diff_for'`

- [ ] **Step 3: 在 `app/core/repo.py` 追加实现**

```python
def truncate(text: str, max_lines: int) -> str:
    """超过 max_lines 时保留前 max_lines 行并标注省略数。"""
    if max_lines <= 0:
        return text
    lines = text.splitlines()
    if len(lines) <= max_lines:
        return text
    omitted = len(lines) - max_lines
    return "\n".join(lines[:max_lines]) + f"\n... (已截断，省略 {omitted} 行)"


def _diff_one(repo_root, path: str) -> str:
    code, out, _ = run_git(["diff", "HEAD", "--", path], cwd=repo_root, check=False)
    if code == 0 and out.strip():
        return out

    full = Path(repo_root) / path
    if not full.is_file():
        return ""
    try:
        content = full.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return f"### 新增或不可读文件: {path}"
    body = "\n".join("+" + line for line in content.splitlines())
    return f"### 新增文件: {path}\n{body}"


def diff_for(repo_root, paths: list[str], max_lines: int = 200) -> str:
    """采集指定路径的 diff 文本并截断。"""
    sections = [section for section in (_diff_one(repo_root, p) for p in paths) if section]
    return truncate("\n".join(sections), max_lines)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m pytest tests/test_repo_diff.py -v`
Expected: PASS（5 passed）

- [ ] **Step 5: 提交**

```bash
git add app/core/repo.py tests/test_repo_diff.py
git commit -m "feat: diff collection and truncation"
```

---

### Task 5: 只提交勾选的文件（关键语义）

**Files:**
- Modify: `app/core/repo.py`（追加 `stage`、`commit`）
- Create: `tests/test_repo_commit.py`

**Interfaces:**
- Consumes: Task 2、Task 3、Task 4
- Produces:
  - `stage(repo_root, paths: list[str]) -> None`
  - `commit(repo_root, message: str, paths: list[str]) -> str`

- [ ] **Step 1: 写失败的测试 `tests/test_repo_commit.py`**

```python
import subprocess

import pytest

from app.core.repo import commit, stage
from app.core.gitcmd import GitError


def _init_repo(path):
    subprocess.run(["git", "init"], cwd=path, capture_output=True, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=path, capture_output=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=path, capture_output=True)
    (path / "seed.txt").write_text("seed", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=path, capture_output=True, check=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=path, capture_output=True, check=True)


def _files_in_head(path):
    out = subprocess.run(
        ["git", "show", "--name-only", "--pretty=format:", "HEAD"],
        cwd=path, capture_output=True, text=True, check=True,
    ).stdout
    return [line for line in out.splitlines() if line.strip()]


def test_commit_only_checked_paths_ignores_other_staged(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "a.txt").write_text("a", encoding="utf-8")
    (tmp_path / "b.txt").write_text("b", encoding="utf-8")
    subprocess.run(["git", "add", "b.txt"], cwd=tmp_path, capture_output=True, check=True)

    stage(tmp_path, ["a.txt"])
    commit(tmp_path, "只提交 a", ["a.txt"])

    assert "a.txt" in _files_in_head(tmp_path)
    assert "b.txt" not in _files_in_head(tmp_path)


def test_commit_handles_deletion(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "gone.txt").write_text("x", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=tmp_path, capture_output=True, check=True)
    subprocess.run(["git", "commit", "-m", "add gone"], cwd=tmp_path, capture_output=True, check=True)
    (tmp_path / "gone.txt").unlink()

    stage(tmp_path, ["gone.txt"])
    commit(tmp_path, "删除 gone", ["gone.txt"])

    names = _files_in_head(tmp_path)
    assert "gone.txt" not in names
    status = subprocess.run(["git", "status", "--porcelain"], cwd=tmp_path,
                            capture_output=True, text=True).stdout
    assert "gone.txt" not in status


def test_commit_unicode_path(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "中文 文件.txt").write_text("hi", encoding="utf-8")

    stage(tmp_path, ["中文 文件.txt"])
    commit(tmp_path, "新增中文文件", ["中文 文件.txt"])

    assert "中文 文件.txt" in _files_in_head(tmp_path)


def test_commit_raises_when_nothing_to_commit(tmp_path):
    _init_repo(tmp_path)
    with pytest.raises(GitError):
        commit(tmp_path, "空提交", ["seed.txt"])
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest tests/test_repo_commit.py -v`
Expected: FAIL — `ImportError: cannot import name 'commit'`

- [ ] **Step 3: 在 `app/core/repo.py` 追加实现**

```python
def stage(repo_root, paths: list[str]) -> None:
    """暂存指定路径（含新增、修改、删除），不影响其它路径。"""
    if not paths:
        return
    run_git(["add", "-A", "--", *paths], cwd=repo_root)


def commit(repo_root, message: str, paths: list[str]) -> str:
    """只提交指定路径，保留其它已暂存内容不动。"""
    if not paths:
        raise GitError("没有勾选任何文件")
    code, out, err = run_git(
        ["commit", "-m", message, "--", *paths],
        cwd=repo_root,
        check=False,
    )
    if code != 0:
        raise GitError(err.strip() or out.strip() or "git commit 失败")
    return out.strip()
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m pytest tests/test_repo_commit.py -v`
Expected: PASS（4 passed）

若 `test_commit_only_checked_paths_ignores_other_staged` 失败（说明 `git commit -- <paths>` 语义不符合预期），改用临时索引方案：为本次提交设置 `GIT_INDEX_FILE` 环境变量指向临时索引，从 HEAD 读取后仅 `git add` 勾选路径，再用该索引 `git commit`。先记录失败输出再改实现。

- [ ] **Step 5: 全量测试**

Run: `python -m pytest -v`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add app/core/repo.py tests/test_repo_commit.py
git commit -m "feat: stage and commit only selected paths"
```

---

### Task 6: AI 客户端（OpenAI 兼容）

**Files:**
- Create: `app/core/ai.py`
- Create: `tests/test_ai.py`

**Interfaces:**
- Consumes: `load_config`（Task 1）
- Produces:
  - `class AIError(RuntimeError)`
  - `strip_think(text: str) -> str`
  - `build_prompt(cfg: dict) -> str`
  - `generate_commit_message(diff_text: str, cfg: dict, session=None) -> str`

- [ ] **Step 1: 写失败的测试 `tests/test_ai.py`**

```python
import pytest

from app.core.ai import AIError, build_prompt, generate_commit_message, strip_think


class FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


class FakeSession:
    def __init__(self, response):
        self._response = response
        self.calls = []

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        return self._response


CFG = {
    "url": "http://localhost:11434/v1",
    "api_key": "ollama",
    "model": "qwen2.5-coder:7b",
    "prompt": "",
    "max_tokens": 8192,
    "language": "中文",
    "timeout": 60,
}


def test_strip_think_removes_reasoning_block():
    assert strip_think("a<think>secret\nlines</think>b") == "ab"


def test_build_prompt_uses_custom_prompt():
    cfg = dict(CFG, prompt="只输出一句话")
    assert build_prompt(cfg) == "只输出一句话"


def test_build_prompt_defaults_to_language():
    assert "中文" in build_prompt(CFG)


def test_generate_commit_message_posts_to_chat_completions():
    response = FakeResponse(payload={"choices": [{"message": {"content": " 修复登录bug "}}]})
    session = FakeSession(response)
    result = generate_commit_message("diff text", CFG, session=session)
    assert result == "修复登录bug"
    call = session.calls[0]
    assert call["url"] == "http://localhost:11434/v1/chat/completions"
    assert call["headers"]["Authorization"] == "Bearer ollama"
    assert call["json"]["model"] == "qwen2.5-coder:7b"
    assert call["json"]["stream"] is False
    assert call["json"]["max_tokens"] == 8192


def test_generate_commit_message_strips_think_in_response():
    response = FakeResponse(payload={"choices": [{"message": {"content": "<think>x</think>真正内容"}}]})
    assert generate_commit_message("d", CFG, session=FakeSession(response)) == "真正内容"


def test_generate_commit_message_raises_on_http_error():
    response = FakeResponse(status_code=500, text="boom")
    with pytest.raises(AIError) as exc:
        generate_commit_message("d", CFG, session=FakeSession(response))
    assert "500" in str(exc.value)


def test_generate_commit_message_raises_on_empty_choices():
    response = FakeResponse(payload={"choices": []})
    with pytest.raises(AIError):
        generate_commit_message("d", CFG, session=FakeSession(response))


def test_generate_commit_message_raises_without_url():
    with pytest.raises(AIError):
        generate_commit_message("d", dict(CFG, url=""))
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest tests/test_ai.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.core.ai'`

- [ ] **Step 3: 实现 `app/core/ai.py`**

```python
"""OpenAI 兼容的提交信息生成客户端。"""

import re

import requests

_THINK_RE = re.compile(r"<think>.*?</think>", re.S)


class AIError(RuntimeError):
    """AI 调用失败。"""


def strip_think(text: str) -> str:
    """移除思考模型的 <think>...</think> 段落。"""
    return _THINK_RE.sub("", text).strip()


def build_prompt(cfg: dict) -> str:
    """自定义提示词优先，否则按语言生成默认提示词。"""
    custom = (cfg.get("prompt") or "").strip()
    if custom:
        return custom
    language = cfg.get("language") or "中文"
    return (
        "你是一个专业程序员。请根据提供的 git diff 生成一条简洁、准确的提交信息，"
        f"使用{language}，只输出提交信息本身，不要输出解释、引号或 markdown 标记。"
    )


def generate_commit_message(diff_text: str, cfg: dict, session=None) -> str:
    """调用 {url}/chat/completions 生成提交信息。"""
    url = (cfg.get("url") or "").strip().rstrip("/")
    if not url:
        raise AIError("未配置 api.url，请先填写配置文件")

    payload: dict = {
        "model": cfg.get("model") or "",
        "messages": [
            {"role": "system", "content": build_prompt(cfg)},
            {"role": "user", "content": diff_text},
        ],
        "stream": False,
    }
    max_tokens = cfg.get("max_tokens") or 0
    if max_tokens > 0:
        payload["max_tokens"] = max_tokens

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {cfg.get('api_key') or ''}",
    }
    http = session or requests
    try:
        response = http.post(
            f"{url}/chat/completions",
            json=payload,
            headers=headers,
            timeout=cfg.get("timeout", 60),
        )
    except requests.RequestException as exc:
        raise AIError(f"AI 请求失败：{exc}") from exc

    if response.status_code != 200:
        raise AIError(f"AI 返回 {response.status_code}：{response.text[:500]}")

    try:
        data = response.json()
    except ValueError as exc:
        raise AIError("AI 返回的不是合法 JSON") from exc

    choices = data.get("choices") or []
    if not choices:
        raise AIError("AI 返回缺少 choices")

    content = strip_think((choices[0].get("message") or {}).get("content") or "")
    if not content:
        raise AIError("AI 未返回有效内容")
    return content
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m pytest tests/test_ai.py -v`
Expected: PASS（8 passed）

- [ ] **Step 5: 提交**

```bash
git add app/core/ai.py tests/test_ai.py
git commit -m "feat: OpenAI-compatible AI client"
```

---

### Task 7: 工作线程（非阻塞）

**Files:**
- Create: `app/ui/worker.py`
- Create: `tests/test_worker.py`

**Interfaces:**
- Consumes: 无（依赖 PySide6）
- Produces:
  - `class FunctionWorker(QThread)`，构造 `FunctionWorker(fn, *args, **kwargs)`
  - 信号：`succeeded = Signal(object)`、`failed = Signal(str)`
  - 方法：`cancel() -> None`、`is_cancelled() -> bool`

- [ ] **Step 1: 写失败的测试 `tests/test_worker.py`**

```python
import pytest

pytest.importorskip("PySide6")

from app.ui.worker import FunctionWorker


def test_worker_emits_success():
    received = []
    worker = FunctionWorker(lambda: 42)
    worker.succeeded.connect(received.append)
    worker.run()
    assert received == [42]


def test_worker_emits_failure_message():
    errors = []

    def boom():
        raise ValueError("炸了")

    worker = FunctionWorker(boom)
    worker.failed.connect(errors.append)
    worker.run()
    assert errors == ["炸了"]


def test_worker_cancel_suppresses_signals():
    received = []
    worker = FunctionWorker(lambda: "done")
    worker.cancel()
    worker.succeeded.connect(received.append)
    worker.run()
    assert received == []
    assert worker.is_cancelled() is True
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest tests/test_worker.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.ui.worker'`

- [ ] **Step 3: 实现 `app/ui/worker.py`**

```python
"""QThread 工作线程：把耗时调用挪出 UI 主线程。"""

from PySide6.QtCore import QThread, Signal


class FunctionWorker(QThread):
    """在后台线程执行一个函数，通过信号回传结果。"""

    succeeded = Signal(object)
    failed = Signal(str)

    def __init__(self, fn, *args, **kwargs):
        super().__init__()
        self._fn = fn
        self._args = args
        self._kwargs = kwargs
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    def is_cancelled(self) -> bool:
        return self._cancelled

    def run(self) -> None:
        try:
            result = self._fn(*self._args, **self._kwargs)
        except Exception as exc:  # noqa: BLE001 - 需要把任意异常回传给 UI
            if not self._cancelled:
                self.failed.emit(str(exc))
            return
        if not self._cancelled:
            self.succeeded.emit(result)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m pytest tests/test_worker.py -v`
Expected: PASS（3 passed）

- [ ] **Step 5: 提交**

```bash
git add app/ui/worker.py tests/test_worker.py
git commit -m "feat: background function worker"
```

---

### Task 8: 主窗口与入口

**Files:**
- Create: `app/ui/main_window.py`
- Create: `app/main.py`

**Interfaces:**
- Consumes: Task 1、Task 3、Task 4、Task 5、Task 6、Task 7
- Produces:
  - `class MainWindow(QMainWindow)`，构造 `MainWindow(repo_root: str)`
  - 方法：`refresh() -> None`、`checked_paths() -> list[str]`
  - `resolve_start_path(argv: list[str]) -> str`（在 `app/main.py`）

- [ ] **Step 1: 实现 `app/ui/main_window.py`**

```python
"""主窗口：变更文件勾选 + AI 生成 + 提交。"""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from ..core import ai, repo
from ..core.config import load_config
from .worker import FunctionWorker


class MainWindow(QMainWindow):
    def __init__(self, repo_root: str):
        super().__init__()
        self.repo_root = repo_root
        self.config = load_config()
        self._worker: FunctionWorker | None = None
        self._changes: list[repo.FileChange] = []

        self.setWindowTitle("AI 提交")
        size = self.config.get("ui", {})
        self.resize(size.get("window_width", 720), size.get("window_height", 520))
        self._build_ui()
        self.refresh()

    def _build_ui(self) -> None:
        central = QWidget(self)
        layout = QVBoxLayout(central)

        self.header = QLabel(f"仓库：{self.repo_root}")
        self.header.setWordWrap(True)
        layout.addWidget(self.header)

        buttons = QHBoxLayout()
        self.btn_all = QPushButton("全选")
        self.btn_none = QPushButton("全不选")
        self.btn_all.clicked.connect(lambda: self._set_all(True))
        self.btn_none.clicked.connect(lambda: self._set_all(False))
        buttons.addWidget(self.btn_all)
        buttons.addWidget(self.btn_none)
        buttons.addStretch(1)
        layout.addLayout(buttons)

        self.list_widget = QListWidget()
        layout.addWidget(self.list_widget, 3)

        layout.addWidget(QLabel("提交信息"))
        self.message_edit = QPlainTextEdit()
        layout.addWidget(self.message_edit, 2)

        actions = QHBoxLayout()
        self.btn_generate = QPushButton("AI 生成")
        self.btn_cancel = QPushButton("取消")
        self.btn_commit = QPushButton("提交")
        self.btn_cancel.setEnabled(False)
        self.btn_generate.clicked.connect(self.on_generate)
        self.btn_cancel.clicked.connect(self.on_cancel)
        self.btn_commit.clicked.connect(self.on_commit)
        actions.addWidget(self.btn_generate)
        actions.addWidget(self.btn_cancel)
        actions.addStretch(1)
        actions.addWidget(self.btn_commit)
        layout.addLayout(actions)

        self.status = QLabel("就绪")
        layout.addWidget(self.status)

        self.setCentralWidget(central)

    # --- 数据 ---

    def refresh(self) -> None:
        try:
            self._changes = repo.list_changes(self.repo_root)
        except Exception as exc:  # noqa: BLE001
            self._error(f"读取变更失败：{exc}")
            return
        self.list_widget.clear()
        checked_default = self.config.get("selection", {}).get("checked_by_default", "tracked")
        for change in self._changes:
            letter = repo.STATUS_LETTER.get(change.status, "?")
            item = QListWidgetItem(f"[{letter}] {change.path}")
            item.setData(Qt.UserRole, change.path)
            if checked_default == "all":
                item.setCheckState(Qt.Checked)
            elif checked_default == "none":
                item.setCheckState(Qt.Unchecked)
            else:
                item.setCheckState(Qt.Unchecked if change.status == repo.UNTRACKED else Qt.Checked)
            self.list_widget.addItem(item)
        self.status.setText(f"共 {len(self._changes)} 个变更")
        self.btn_commit.setEnabled(bool(self._changes))
        if not self._changes:
            self.message_edit.setPlainText("")

    def checked_paths(self) -> list[str]:
        paths = []
        for index in range(self.list_widget.count()):
            item = self.list_widget.item(index)
            if item.checkState() == Qt.Checked:
                paths.append(item.data(Qt.UserRole))
        return paths

    def _set_all(self, checked: bool) -> None:
        state = Qt.Checked if checked else Qt.Unchecked
        for index in range(self.list_widget.count()):
            self.list_widget.item(index).setCheckState(state)

    # --- 动作 ---

    def on_generate(self) -> None:
        paths = self.checked_paths()
        if not paths:
            self._error("请先勾选至少一个文件")
            return
        api_cfg = self.config.get("api", {})
        if not (api_cfg.get("url") or "").strip():
            self._error("未配置 api.url，请编辑配置文件后重试")
            return

        max_lines = self.config.get("git", {}).get("max_diff_lines", 200)

        def job():
            diff_text = repo.diff_for(self.repo_root, paths, max_lines=max_lines)
            if not diff_text.strip():
                raise RuntimeError("勾选的文件没有可分析的改动")
            return ai.generate_commit_message(diff_text, api_cfg)

        self._run_worker(job, self._on_generated, start_text="正在生成…")

    def on_commit(self) -> None:
        paths = self.checked_paths()
        message = self.message_edit.toPlainText().strip()
        if not paths:
            self._error("请先勾选至少一个文件")
            return
        if not message:
            self._error("提交信息不能为空")
            return

        def job():
            repo.stage(self.repo_root, paths)
            return repo.commit(self.repo_root, message, paths)

        self._run_worker(job, self._on_committed, start_text="正在提交…")

    def on_cancel(self) -> None:
        if self._worker is not None:
            self._worker.cancel()
            self.status.setText("已取消")

    # --- 线程辅助 ---

    def _run_worker(self, fn, on_success, start_text: str) -> None:
        self._set_busy(True)
        self.status.setText(start_text)
        worker = FunctionWorker(fn)
        worker.succeeded.connect(on_success)
        worker.failed.connect(self._error)
        worker.finished.connect(lambda: self._set_busy(False))
        self._worker = worker
        worker.start()

    def _set_busy(self, busy: bool) -> None:
        self.btn_generate.setEnabled(not busy)
        self.btn_commit.setEnabled(not busy and bool(self._changes))
        self.btn_cancel.setEnabled(busy)

    def _on_generated(self, text: str) -> None:
        self.message_edit.setPlainText(text)
        self.status.setText("已生成，可编辑后提交")

    def _on_committed(self, output: str) -> None:
        self.status.setText("提交成功")
        QMessageBox.information(self, "AI 提交", "提交成功")
        self.refresh()

    def _error(self, message: str) -> None:
        self.status.setText(f"错误：{message}")
        QMessageBox.warning(self, "AI 提交", message)
```

- [ ] **Step 2: 实现 `app/main.py`**

```python
"""入口：从资源管理器右键传入目录，定位仓库并打开窗口。"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def resolve_start_path(argv: list[str]) -> str:
    """取第一个非选项参数作为起始路径，否则用当前目录。"""
    for arg in argv[1:]:
        if not arg.startswith("-"):
            return arg
    return str(Path.cwd())


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv if argv is None else argv)
    start = resolve_start_path(argv)

    from PySide6.QtWidgets import QApplication, QMessageBox

    from app.core.repo import find_repo_root
    from app.ui.main_window import MainWindow

    app = QApplication(argv)
    root = find_repo_root(start)
    if root is None:
        QMessageBox.critical(None, "AI 提交", f"该目录不是 Git 仓库：\n{start}")
        return 1

    window = MainWindow(root)
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 3: 冒烟验证（无 UI 断言，只验证可导入与仓库定位）**

Run: `python -c "import sys; sys.argv=['x','.']; from app.main import resolve_start_path; print(resolve_start_path(sys.argv))"`
Expected: 输出 `.`

Run: `python -m pytest -v`
Expected: 全部 PASS（不应有回归）

- [ ] **Step 4: 手工冒烟（记录结果）**

在一个测试仓库目录执行：
`python app\main.py "<测试仓库路径>"`
Expected: 窗口打开，列出变更文件（已跟踪默认勾选、未跟踪默认不勾选），点「AI 生成」在未配置可用 AI 时给出明确错误，配置好 AI 后能生成并提交。

- [ ] **Step 5: 提交**

```bash
git add app/ui/main_window.py app/main.py
git commit -m "feat: main window and entry point"
```

---

### Task 9: 右键菜单安装/卸载脚本

**Files:**
- Create: `install/install.ps1`
- Create: `install/uninstall.ps1`
- Create: `install/verify.ps1`

**Interfaces:**
- Consumes: `app/main.py`（Task 8）
- Produces: 注册表键
  - `HKCU\Software\Classes\Directory\shell\AIGitCommit`
  - `HKCU\Software\Classes\Directory\Background\shell\AIGitCommit`

- [ ] **Step 1: 实现 `install/install.ps1`**

```powershell
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $projectRoot 'app\main.py'
if (-not (Test-Path -LiteralPath $entry)) {
    throw "找不到入口文件: $entry"
}

$python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
if (-not $python) { throw '找不到 python.exe，请先安装 Python 并加入 PATH' }
$pythonw = Join-Path (Split-Path -Parent $python) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonw)) { $pythonw = $python }

$command = "`"$pythonw`" `"$entry`" `"%V`""
$bases = @(
    'HKCU:\Software\Classes\Directory\shell\AIGitCommit',
    'HKCU:\Software\Classes\Directory\Background\shell\AIGitCommit'
)

foreach ($base in $bases) {
    New-Item -Path $base -Force | Out-Null
    Set-ItemProperty -Path $base -Name '(default)' -Value 'AI 提交'
    Set-ItemProperty -Path $base -Name 'Icon' -Value $pythonw
    New-Item -Path "$base\command" -Force | Out-Null
    Set-ItemProperty -Path "$base\command" -Name '(default)' -Value $command
}

Write-Host "已安装右键菜单。命令: $command"
Write-Host "Windows 11 中请在「显示更多选项」里查看。"
```

- [ ] **Step 2: 实现 `install/uninstall.ps1`**

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
```

- [ ] **Step 3: 实现 `install/verify.ps1`**

```powershell
$ErrorActionPreference = 'Stop'

$bases = @(
    'HKCU:\Software\Classes\Directory\shell\AIGitCommit\command',
    'HKCU:\Software\Classes\Directory\Background\shell\AIGitCommit\command'
)

$ok = $true
foreach ($key in $bases) {
    if (Test-Path $key) {
        $cmd = (Get-ItemProperty -Path $key).'(default)'
        Write-Host "OK   $key -> $cmd"
    } else {
        Write-Host "MISS $key"
        $ok = $false
    }
}
if (-not $ok) { exit 1 }
Write-Host '右键菜单注册校验通过'
```

- [ ] **Step 4: 运行安装并校验**

Run: `pwsh -File install\install.ps1`
Expected: 输出「已安装右键菜单」

Run: `pwsh -File install\verify.ps1`
Expected: 两行 `OK`，末行「右键菜单注册校验通过」，退出码 0

- [ ] **Step 5: 验证卸载再装回**

Run: `pwsh -File install\uninstall.ps1; pwsh -File install\verify.ps1; echo "exit=$LASTEXITCODE"`
Expected: 删除提示后 verify 输出两条 `MISS`，`exit=1`

Run: `pwsh -File install\install.ps1; pwsh -File install\verify.ps1`
Expected: 恢复为两条 `OK`

- [ ] **Step 6: 提交**

```bash
git add install
git commit -m "feat: explorer context menu install/uninstall scripts"
```

---

### Task 10: 文档与收尾

**Files:**
- Create: `README.md`
- Modify: `THIRD-PARTY-NOTICES.md`（如需要补充）

**Interfaces:**
- Consumes: 前 9 个任务
- Produces: 使用说明

- [ ] **Step 1: 写 `README.md`**

内容必须覆盖：
- 功能简介（v1：文件勾选 + AI 生成 + 只提交勾选项）
- 环境要求（Windows、Python 3.12+、git）
- 安装：`python -m pip install -r requirements.txt`、`pwsh -File install\install.ps1`
- 配置：`%USERPROFILE%\.git_ai_commit\config.json` 的字段说明（`api.url` 必须是 OpenAI 兼容且以 `/v1` 结尾的地址；`api.api_key`；`api.model`；`api.language`；`api.prompt`；`api.max_tokens`；`api.timeout`；`git.max_diff_lines`；`selection.checked_by_default`）
- 使用：右键文件夹 →「AI 提交」→ 勾选文件 → AI 生成 → 编辑 → 提交
- 卸载：`pwsh -File install\uninstall.ps1`
- 已知限制：Windows 11 需「显示更多选项」；不做 diff 预览/amend/push（v2）
- 测试：`python -m pytest -v`

- [ ] **Step 2: 全量测试**

Run: `python -m pytest -v`
Expected: 全部 PASS

- [ ] **Step 3: 手工验收清单（逐条执行并记录）**

1. 右键菜单出现「AI 提交」
2. 在非 Git 目录点击 → 弹出「该目录不是 Git 仓库」
3. 在 Git 仓库点击 → 列出变更，状态字母正确，已跟踪默认勾选、未跟踪默认不勾选
4. 「全选」「全不选」有效
5. 未配置 AI 时点「AI 生成」→ 明确错误提示
6. 配置可用 AI 后点「AI 生成」→ 信息框出现生成内容，界面不卡死，可「取消」
7. 只勾选部分文件提交 → `git show --name-only HEAD` 只含勾选文件
8. 其它已暂存但未勾选的文件仍保持暂存状态

- [ ] **Step 4: 提交**

```bash
git add README.md THIRD-PARTY-NOTICES.md
git commit -m "docs: usage and configuration guide"
```

---

## Self-Review

**1. Spec coverage**

| Spec 章节 | 对应任务 |
|---|---|
| §1 目标 1（右键唤起，免注册） | Task 8、Task 9 |
| §1 目标 2（文件列表勾选+状态） | Task 3、Task 8 |
| §1 目标 3（AI 生成可编辑） | Task 4、Task 6、Task 8 |
| §1 目标 4（只提交勾选） | Task 5 |
| §2 约束（无 .NET、HKCU、非阻塞） | Global Constraints、Task 7、Task 9 |
| §3 技术选型与依赖 | Task 1 |
| §5.1 gitcmd | Task 2 |
| §5.2 repo | Task 3、Task 4、Task 5 |
| §5.3 ai | Task 6 |
| §5.4 config | Task 1 |
| §5.5 main_window | Task 8 |
| §5.6 worker | Task 7 |
| §6 数据流与 commit 语义 | Task 5、Task 8 |
| §7 右键菜单 | Task 9 |
| §8 错误处理 | Task 6（异常）、Task 8（`_error`） |
| §9 测试策略 | 各任务测试 + Task 10 验收 |
| §10 里程碑 | M1=Task1-6，M2=Task7-8，M3=Task9，M4=Task10 |
| §12 许可 | Task 1 `THIRD-PARTY-NOTICES.md`、Task 10 |

**2. Placeholder scan**：无 TBD/TODO；每个代码步骤均给出完整代码与预期输出。

**3. Type consistency**：`run_git`/`GitError`/`FileChange`/`find_repo_root`/`list_changes`/`diff_for`/`truncate`/`stage`/`commit`/`has_commits`/`load_config`/`save_config`/`DEFAULT_CONFIG`/`generate_commit_message`/`AIError`/`strip_think`/`build_prompt`/`FunctionWorker`/`MainWindow` 在各任务间命名与签名一致。`has_commits` 已实现但 v1 未被 UI 使用（`diff_for` 的未跟踪回退已覆盖空仓库场景），保留为后续 v2 备用，属有意保留而非悬空引用。
