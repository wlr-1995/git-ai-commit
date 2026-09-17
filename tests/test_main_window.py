"""主窗口行为回归：关闭窗口与重命名 pathspec。"""

import copy
import os
import subprocess

import pytest

pytest.importorskip("PySide6")

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtGui import QCloseEvent, QKeySequence, QShortcut  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from app.core import repo  # noqa: E402
from app.core.config import DEFAULT_CONFIG  # noqa: E402
from app.ui import main_window as mw  # noqa: E402


@pytest.fixture(scope="module")
def qapp():
    app = QApplication.instance() or QApplication([])
    yield app


def _make_window(tmp_path, monkeypatch):
    monkeypatch.setattr(mw.MainWindow, "refresh", lambda self: None)
    monkeypatch.setattr(mw, "load_config", lambda: copy.deepcopy(DEFAULT_CONFIG))
    return mw.MainWindow(str(tmp_path))


class _FakeWorker:
    def __init__(self, running=True, wait_result=True):
        self._running = running
        self._wait_result = wait_result
        self.cancelled = False
        self.waits = []

    def isRunning(self):  # noqa: N802 - Qt 命名
        return self._running

    def cancel(self):
        self.cancelled = True

    def wait(self, ms):
        self.waits.append(ms)
        return self._wait_result


def test_close_during_commit_is_ignored(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    worker = _FakeWorker()
    window._worker = worker
    window._operation = mw.COMMIT

    event = QCloseEvent()
    window.closeEvent(event)

    assert event.isAccepted() is False
    assert worker.cancelled is False
    assert worker.waits == []
    assert "正在提交" in window.status.text()


def test_close_during_generate_cancels_and_accepts(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    worker = _FakeWorker(wait_result=True)
    window._worker = worker
    window._operation = mw.GENERATE

    event = QCloseEvent()
    window.closeEvent(event)

    assert worker.cancelled is True
    assert worker.waits == [5000]
    assert event.isAccepted() is True


def test_close_without_worker_accepts(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    window._worker = None

    event = QCloseEvent()
    window.closeEvent(event)

    assert event.isAccepted() is True


def test_layout_puts_message_above_file_list(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    layout = window.centralWidget().layout()

    assert layout.indexOf(window.message_edit) < layout.indexOf(window.changes_table)


def test_table_has_expected_columns(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    table = window.changes_table
    headers = [table.horizontalHeaderItem(i).text() for i in range(table.columnCount())]

    assert headers == ["路径", "扩展名", "状态", "添加行数", "删除行数"]


def test_changes_loaded_fills_table(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    changes = [
        repo.FileChange(path="a.md", status=repo.MODIFIED),
        repo.FileChange(path="new.txt", status=repo.UNTRACKED),
    ]
    stats = {"a.md": (1, 1)}

    window._on_changes_loaded(changes, stats)

    table = window.changes_table
    assert table.rowCount() == 2
    assert [table.item(0, c).text() for c in range(5)] == ["a.md", ".md", "已修改", "1", "1"]
    # 未跟踪文件不统计行数，留空
    assert [table.item(1, c).text() for c in range(5)] == ["new.txt", ".txt", "未版本控制", "", ""]
    # 二进制行数显示 -
    window._on_changes_loaded([repo.FileChange(path="b.bin", status=repo.MODIFIED)], {"b.bin": (None, None)})
    assert table.item(0, 3).text() == "-"
    assert table.item(0, 4).text() == "-"


def test_default_checks_tracked_not_untracked(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    window._on_changes_loaded(
        [
            repo.FileChange(path="a.txt", status=repo.MODIFIED),
            repo.FileChange(path="b.txt", status=repo.UNTRACKED),
        ]
    )

    assert window.checked_paths() == ["a.txt"]


def test_filter_links_check_matching_statuses(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    window._on_changes_loaded(
        [
            repo.FileChange(path="a.txt", status=repo.MODIFIED),
            repo.FileChange(path="new.txt", status=repo.UNTRACKED),
            repo.FileChange(path="gone.txt", status=repo.DELETED),
            repo.FileChange(path="moved.txt", status=repo.RENAMED, orig_path="old.txt"),
        ]
        + [],
        {},
    )

    window._apply_filter("untracked")
    assert window.checked_paths() == ["new.txt"]

    window._apply_filter("modified")
    assert set(window.checked_paths()) == {"a.txt", "moved.txt"}

    window._apply_filter("none")
    assert window.checked_paths() == []

    window._apply_filter("all")
    assert len(window.checked_paths()) == 4


def test_f5_shortcut_triggers_refresh(qapp, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(mw.MainWindow, "refresh", lambda self: calls.append(1))
    monkeypatch.setattr(mw, "load_config", lambda: copy.deepcopy(DEFAULT_CONFIG))
    window = mw.MainWindow(str(tmp_path))

    shortcits = [
        s for s in window.findChildren(QShortcut) if s.key() == QKeySequence("F5")
    ]
    assert shortcits, "F5 快照键未注册"
    shortcits[0].activated.emit()

    assert calls


def test_snapshot_loaded_shows_branch(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)

    window._on_snapshot_loaded({"branch": "trunk", "changes": []})

    assert "trunk" in window.branch_label.text()


def test_error_summary_truncates_long_text():
    summary = mw._error_summary("a" * 400)
    assert summary.endswith("…")
    assert len(summary) <= mw._ERROR_SUMMARY_LIMIT + 1


def test_error_summary_keeps_short_text_and_first_line():
    assert mw._error_summary("连接失败") == "连接失败"
    assert mw._error_summary("第一行\n第二行") == "第一行"
    assert mw._error_summary("   ") == "发生未知错误"


def test_wrap_for_dialog_bounds_display_width():
    wrapped = mw._wrap_for_dialog("a" * 200)
    lines = wrapped.splitlines()
    assert len(lines) > 1
    assert all(mw._display_width(line) <= mw._DIALOG_WRAP_COLUMNS for line in lines)
    # 全角字符按两列计算
    assert mw._display_width("中") == 2
    assert mw._display_width("a") == 1


def test_wrap_for_dialog_prefers_space_breaks():
    wrapped = mw._wrap_for_dialog("alpha beta gamma delta", columns=11)
    assert wrapped.splitlines() == ["alpha beta", "gamma delta"]


def test_wrap_for_dialog_hard_splits_oversized_token():
    lines = mw._wrap_for_dialog("x" * 25, columns=10).splitlines()
    assert lines == ["x" * 10, "x" * 10, "x" * 5]


def test_error_dialog_width_is_bounded(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    long_msg = (
        "AI 请求失败：HTTPConnectionPool(host=localhost, port=11434): "
        "Max retries exceeded with url: /v1/chat/completions (Caused by NewConnectionError)"
    )

    box = window._build_error_box(long_msg)

    # 完整信息进详情，对话框本身只按短摘要计算宽度，不能被长错误撑宽。
    assert box.detailedText() == long_msg
    assert box.text() != long_msg
    assert box.sizeHint().width() < 600


def test_checked_commit_paths_includes_rename_orig(qapp, tmp_path, monkeypatch):
    subprocess.run(["git", "init"], cwd=tmp_path, capture_output=True, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=tmp_path, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "t@example.com"], cwd=tmp_path, capture_output=True
    )
    (tmp_path / "old.txt").write_text("content", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=tmp_path, capture_output=True, check=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=tmp_path, capture_output=True, check=True)
    subprocess.run(["git", "mv", "old.txt", "new.txt"], cwd=tmp_path, capture_output=True, check=True)

    window = _make_window(tmp_path, monkeypatch)
    window._on_changes_loaded(repo.list_changes(tmp_path))

    assert set(window.checked_commit_paths()) == {"new.txt", "old.txt"}
