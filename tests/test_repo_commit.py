import subprocess

import pytest

from app.core.repo import commit, commit_pathspecs, list_changes, stage
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
        ["git", "-c", "core.quotepath=false", "ls-tree", "-r", "HEAD", "--name-only"],
        cwd=path, capture_output=True, text=True, encoding="utf-8", check=True,
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


def _porcelain(path):
    return subprocess.run(
        ["git", "-c", "core.quotepath=false", "status", "--porcelain"],
        cwd=path, capture_output=True, text=True, encoding="utf-8", check=True,
    ).stdout


def test_commit_succeeds_after_already_staged_deletion(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "gone.txt").write_text("x", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=tmp_path, capture_output=True, check=True)
    subprocess.run(["git", "commit", "-m", "add gone"], cwd=tmp_path, capture_output=True, check=True)
    # 删除已由 git rm 暂存；此时 `git add -A -- gone.txt` 会以 128 退出。
    subprocess.run(["git", "rm", "-q", "gone.txt"], cwd=tmp_path, capture_output=True, check=True)

    stage(tmp_path, ["gone.txt"])
    commit(tmp_path, "删除 gone", ["gone.txt"])

    assert "gone.txt" not in _files_in_head(tmp_path)
    assert _porcelain(tmp_path) == ""


def test_commit_rename_includes_orig_path(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "old.txt").write_text("content", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=tmp_path, capture_output=True, check=True)
    subprocess.run(["git", "commit", "-m", "add old"], cwd=tmp_path, capture_output=True, check=True)
    subprocess.run(["git", "mv", "old.txt", "new.txt"], cwd=tmp_path, capture_output=True, check=True)

    changes = list_changes(tmp_path)
    paths = commit_pathspecs(changes)
    assert set(paths) == {"new.txt", "old.txt"}

    stage(tmp_path, [c.path for c in changes])
    commit(tmp_path, "重命名", paths)

    names = _files_in_head(tmp_path)
    assert "new.txt" in names
    assert "old.txt" not in names
    assert _porcelain(tmp_path) == ""


def test_commit_treats_glob_characters_literally(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "file1.txt").write_text("one", encoding="utf-8")
    (tmp_path / "file[1].txt").write_text("bracket", encoding="utf-8")

    stage(tmp_path, ["file[1].txt"])
    commit(tmp_path, "新增方括号文件", ["file[1].txt"])

    names = _files_in_head(tmp_path)
    assert "file[1].txt" in names
    assert "file1.txt" not in names
