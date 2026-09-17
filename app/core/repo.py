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
