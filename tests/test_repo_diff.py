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
