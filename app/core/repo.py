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
    """返回仓库根目录；不是仓库（含路径无效）则返回 None。"""
    try:
        code, out, _ = run_git(["rev-parse", "--show-toplevel"], cwd=start_path, check=False)
    except GitError:
        return None
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
