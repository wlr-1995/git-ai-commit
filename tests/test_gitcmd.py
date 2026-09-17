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
