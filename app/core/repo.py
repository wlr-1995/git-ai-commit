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

#: 无法判断当前分支时的显示文本。
UNKNOWN_BRANCH = "未知"

#: 未跟踪文件参与 diff 分析时的大小上限；超过则只给标记，不读取内容。
_MAX_UNTRACKED_BYTES = 512 * 1024

STATUS_LETTER = {
    MODIFIED: "M",
    ADDED: "A",
    DELETED: "D",
    RENAMED: "R",
    UNTRACKED: "?",
    CONFLICTED: "!",
}

#: 状态的中文显示名（界面表格「状态」列）。
STATUS_TEXT = {
    MODIFIED: "已修改",
    ADDED: "已添加",
    DELETED: "已删除",
    RENAMED: "已重命名",
    UNTRACKED: "未版本控制",
    CONFLICTED: "冲突",
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


def current_branch(repo_root) -> str:
    """返回当前分支名；游离 HEAD 返回短 SHA，无法判断时返回「未知」。"""
    code, out, _ = run_git(["symbolic-ref", "--short", "-q", "HEAD"], cwd=repo_root, check=False)
    if code == 0 and out.strip():
        return out.strip()
    code, out, _ = run_git(["rev-parse", "--short", "HEAD"], cwd=repo_root, check=False)
    if code == 0 and out.strip():
        return f"游离 HEAD ({out.strip()})"
    return UNKNOWN_BRANCH


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


def parse_porcelain_z(text: str) -> list[FileChange]:
    """解析 ``git status --porcelain -z`` 输出。

    使用 ``-z``（NUL 分隔）而非默认格式：默认格式会给含空格的路径加引号
    （``"a b.txt"``），即使设置了 ``core.quotepath=false`` 也一样，会让路径
    与后续的 ``git add``/``git commit`` 不匹配。``-z`` 输出原始路径。

    重命名条目为两段：先新路径，后旧路径。
    """
    fields = text.split("\0")
    changes: list[FileChange] = []
    index = 0
    while index < len(fields):
        entry = fields[index]
        index += 1
        if not entry or entry.startswith("!!"):
            continue
        xy = entry[:2]
        path = entry[3:]
        orig: str | None = None
        if "R" in xy or "C" in xy:
            if index < len(fields) and fields[index]:
                orig = fields[index]
            index += 1
        changes.append(FileChange(path=path, status=_status_of(xy), orig_path=orig))
    return changes


def list_changes(repo_root) -> list[FileChange]:
    """列出未提交的变更。"""
    _, out, _ = run_git(["status", "--porcelain", "-z"], cwd=repo_root)
    return parse_porcelain_z(out)


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
    # 只读取上限 +1 字节：既避免超大文件整体读入内存，也用于判断是否超限。
    try:
        with full.open("rb") as handle:
            data = handle.read(_MAX_UNTRACKED_BYTES + 1)
    except OSError:
        return f"### 新增或不可读文件: {path}"
    if len(data) > _MAX_UNTRACKED_BYTES:
        limit_kb = _MAX_UNTRACKED_BYTES // 1024
        return f"### 新增文件过大，已跳过: {path}（超过 {limit_kb} KB）"
    if b"\x00" in data:
        return f"### 新增疑似二进制文件，已跳过: {path}"
    content = data.decode("utf-8", errors="replace")
    body = "\n".join("+" + line for line in content.splitlines())
    return f"### 新增文件: {path}\n{body}"


def diff_for(repo_root, paths: list[str], max_lines: int = 200) -> str:
    """采集指定路径的 diff 文本并截断。"""
    sections = [section for section in (_diff_one(repo_root, p) for p in paths) if section]
    return truncate("\n".join(sections), max_lines)


def _numstat_new_path(raw: str) -> str:
    """把 numstat 的路径字段归一为新路径（重命名形如 ``old => new``）。"""
    if " => " not in raw:
        return raw
    if "{" in raw and "}" in raw:
        prefix, rest = raw.split("{", 1)
        middle, suffix = rest.split("}", 1)
        _, new = middle.split(" => ", 1)
        return f"{prefix}{new}{suffix}"
    _, new = raw.split(" => ", 1)
    return new


def diff_numstat(repo_root) -> dict[str, tuple[int | None, int | None]]:
    """返回 {路径: (添加行数, 删除行数)}，键为重命名后的新路径。

    - 只覆盖已跟踪的变更；未跟踪文件不在结果里（调用方留空即可）。
    - 二进制文件返回 ``(None, None)``，界面显示为 ``-``。
    - 空仓库（无 HEAD）返回空字典。
    """
    code, out, _ = run_git(["diff", "--numstat", "HEAD"], cwd=repo_root, check=False)
    if code != 0:
        return {}

    stats: dict[str, tuple[int | None, int | None]] = {}
    for line in out.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        added_raw, deleted_raw, raw_path = parts[0], parts[1], "\t".join(parts[2:])
        added = int(added_raw) if added_raw.isdigit() else None
        deleted = int(deleted_raw) if deleted_raw.isdigit() else None
        stats[_numstat_new_path(raw_path)] = (added, deleted)
    return stats


def commit_pathspecs(changes: list[FileChange]) -> list[str]:
    """构造提交用 pathspec：重命名同时包含新路径与旧路径。

    重命名在索引中是「删除旧路径 + 新增新路径」，只提交新路径会把旧路径的
    删除遗留在暂存区；因此提交时需要带上 ``orig_path``。
    """
    paths: list[str] = []
    for change in changes:
        paths.append(change.path)
        if change.status == RENAMED and change.orig_path and change.orig_path not in paths:
            paths.append(change.orig_path)
    return paths


def stage(repo_root, paths: list[str]) -> None:
    """暂存指定路径（含新增、修改、删除），不影响其它路径。

    尽力而为：删除一旦被暂存（例如先 ``git rm``），再次 ``git add`` 会因
    pathspec 不匹配而报错；此时放行，由 ``commit`` 作为真正的校验关卡。
    """
    if not paths:
        return
    run_git(["add", "-A", "--", *paths], cwd=repo_root, check=False)


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
