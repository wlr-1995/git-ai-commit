"""`diff_numstat`：每个文件的添加/删除行数（未跟踪文件不统计）。"""

import subprocess

from app.core.repo import diff_numstat


def _init_repo(path):
    subprocess.run(["git", "init", "-b", "trunk"], cwd=path, capture_output=True, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=path, capture_output=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=path, capture_output=True)


def _commit_all(path, message="init"):
    subprocess.run(["git", "add", "-A"], cwd=path, capture_output=True, check=True)
    subprocess.run(["git", "commit", "-m", message], cwd=path, capture_output=True, check=True)


def test_numstat_counts_modified_file(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "a.txt").write_text("one\ntwo\n", encoding="utf-8")
    _commit_all(tmp_path)
    (tmp_path / "a.txt").write_text("one\nTWO\nthree\n", encoding="utf-8")

    stats = diff_numstat(tmp_path)

    assert stats["a.txt"] == (2, 1)


def test_numstat_counts_added_and_deleted(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "gone.txt").write_text("x\ny\n", encoding="utf-8")
    _commit_all(tmp_path)
    (tmp_path / "new.txt").write_text("p\nq\nr\n", encoding="utf-8")
    subprocess.run(["git", "add", "new.txt"], cwd=tmp_path, capture_output=True, check=True)
    (tmp_path / "gone.txt").unlink()

    stats = diff_numstat(tmp_path)

    assert stats["new.txt"] == (3, 0)
    assert stats["gone.txt"] == (0, 2)


def test_numstat_binary_reports_none(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "b.bin").write_bytes(bytes(range(256)))
    _commit_all(tmp_path)
    (tmp_path / "b.bin").write_bytes(bytes(range(255, -1, -1)))

    stats = diff_numstat(tmp_path)

    assert stats["b.bin"] == (None, None)


def test_numstat_omits_untracked_files(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "a.txt").write_text("a\n", encoding="utf-8")
    _commit_all(tmp_path)
    (tmp_path / "untracked.txt").write_text("z\n", encoding="utf-8")

    stats = diff_numstat(tmp_path)

    assert "untracked.txt" not in stats


def test_numstat_maps_renamed_file_to_new_path(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "old.txt").write_text("a\nb\nc\n", encoding="utf-8")
    _commit_all(tmp_path)
    subprocess.run(["git", "mv", "old.txt", "new.txt"], cwd=tmp_path, capture_output=True, check=True)
    (tmp_path / "new.txt").write_text("a\nb\nc\nd\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, capture_output=True, check=True)

    stats = diff_numstat(tmp_path)

    assert "new.txt" in stats
    assert "old.txt" not in stats


def test_numstat_empty_repo_returns_empty(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "a.txt").write_text("a\n", encoding="utf-8")

    assert diff_numstat(tmp_path) == {}
