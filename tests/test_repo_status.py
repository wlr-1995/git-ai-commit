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


def test_find_repo_root_returns_none_for_nonexistent_path(tmp_path):
    assert find_repo_root(tmp_path / "does_not_exist") is None


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
