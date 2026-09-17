"""主窗口行为回归：关闭窗口与重命名 pathspec。"""

import copy
import os
import subprocess

import pytest

pytest.importorskip("PySide6")

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt  # noqa: E402
from PySide6.QtGui import QCloseEvent, QKeySequence, QShortcut  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from app.core import repo  # noqa: E402
from app.core.config import DEFAULT_CONFIG  # noqa: E402
from app.ui import main_window as mw  # noqa: E402
from app.ui import theme  # noqa: E402


@pytest.fixture(scope="module")
def qapp():
    app = QApplication.instance() or QApplication([])
    yield app


def _make_window(tmp_path, monkeypatch):
    monkeypatch.setattr(mw.MainWindow, "refresh", lambda self: None)
    monkeypatch.setattr(mw, "load_config", lambda: copy.deepcopy(DEFAULT_CONFIG))
    return mw.MainWindow(str(tmp_path))


def _mouse(kind, local, buttons=Qt.MouseButton.LeftButton):
    from PySide6.QtCore import QPointF
    from PySide6.QtGui import QMouseEvent

    point = QPointF(local[0], local[1])
    return QMouseEvent(
        kind,
        point,
        point,
        Qt.MouseButton.LeftButton,
        buttons,
        Qt.KeyboardModifier.NoModifier,
    )


def _send_click(viewport, x, y, qapp, double=False):
    """在视口坐标 (x, y) 投递一次真实点击。

    double=True 模拟快速连点的第二次按下（带 DoubleClick 标记）。
    """
    from PySide6.QtCore import QEvent

    local = (x, y)
    QApplication.sendEvent(viewport, _mouse(QEvent.Type.MouseButtonPress, local))
    QApplication.sendEvent(
        viewport, _mouse(QEvent.Type.MouseButtonRelease, local, Qt.MouseButton.NoButton)
    )
    if double:
        QApplication.sendEvent(viewport, _mouse(QEvent.Type.MouseButtonDblClick, local))
        QApplication.sendEvent(
            viewport, _mouse(QEvent.Type.MouseButtonRelease, local, Qt.MouseButton.NoButton)
        )
    qapp.processEvents()


def _indicator_border_lightness() -> int:
    """勾选框描边的灰度：从样式文件里读，避免和样式脱节。"""
    import re

    from PySide6.QtGui import QColor

    match = re.search(
        r"QCheckBox::indicator[^{]*\{[^}]*border:\s*1px solid (#[0-9a-fA-F]{6})",
        theme.load_stylesheet(),
    )
    assert match, "样式里找不到勾选框描边色"
    return QColor(match.group(1)).lightness()


def _indicator_box(window):
    """从渲染结果里量出勾选框的左右边界与中心行。"""
    table = window.changes_table
    row = table.visualItemRect(table.item(0, 0))
    image = table.viewport().grab().toImage()
    border = _indicator_border_lightness()
    xs = sorted(
        x
        for x in range(0, 30)
        for y in range(row.top() + 1, row.bottom())
        if abs(image.pixelColor(x, y).lightness() - border) <= 25
    )
    return xs[0], xs[-1], row.center().y()


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
    window.show_untracked_check.setChecked(True)  # 本用例要检查未跟踪行的列内容
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
    window.show_untracked_check.setChecked(True)  # 未跟踪默认不显示，这里要看它的勾选态
    window._on_changes_loaded(
        [
            repo.FileChange(path="a.txt", status=repo.MODIFIED),
            repo.FileChange(path="b.txt", status=repo.UNTRACKED),
        ]
    )

    assert window.changes_table.rowCount() == 2
    assert window.checked_paths() == ["a.txt"]


def test_untracked_hidden_by_default(qapp, tmp_path, monkeypatch):
    """默认不显示未受版本控制的文件。"""
    window = _make_window(tmp_path, monkeypatch)

    assert window.show_untracked_check.isChecked() is False
    window._on_changes_loaded(_changes_fixture())

    assert [window.changes_table.item(row, 0).text() for row in range(3)] == [
        "a.txt",
        "gone.txt",
        "moved.txt",
    ]
    assert window.changes_table.rowCount() == 3


def test_show_untracked_can_be_enabled_by_config(qapp, tmp_path, monkeypatch):
    config = copy.deepcopy(DEFAULT_CONFIG)
    config["ui"]["show_untracked"] = True
    monkeypatch.setattr(mw.MainWindow, "refresh", lambda self: None)
    monkeypatch.setattr(mw, "load_config", lambda: config)

    window = mw.MainWindow(str(tmp_path))
    assert window.show_untracked_check.isChecked() is True


def _changes_fixture():
    return [
        repo.FileChange(path="a.txt", status=repo.MODIFIED),
        repo.FileChange(path="new.txt", status=repo.UNTRACKED),
        repo.FileChange(path="gone.txt", status=repo.DELETED),
        repo.FileChange(path="moved.txt", status=repo.RENAMED, orig_path="old.txt"),
    ]


def _load_fixture(window):
    """加载含未跟踪文件的样例；它们默认不显示，所以显式打开开关。"""
    window.show_untracked_check.setChecked(True)
    window._on_changes_loaded(_changes_fixture())
    return window


def test_filter_all_and_none(qapp, tmp_path, monkeypatch):
    window = _load_fixture(_make_window(tmp_path, monkeypatch))

    window._apply_filter("none")
    assert window.checked_paths() == []

    window._apply_filter("all")
    assert len(window.checked_paths()) == 4


def test_filter_links_are_additive(qapp, tmp_path, monkeypatch):
    window = _load_fixture(_make_window(tmp_path, monkeypatch))
    # 默认：已跟踪全勾，未跟踪不勾
    assert set(window.checked_paths()) == {"a.txt", "gone.txt", "moved.txt"}

    # 已删除 / 已修改 / 已添加：只加勾，绝不取消已有勾选
    window._apply_filter("deleted")
    assert set(window.checked_paths()) == {"a.txt", "gone.txt", "moved.txt"}

    window._apply_filter("none")
    window._apply_filter("added")
    assert window.checked_paths() == []


def test_filter_chips_drop_untracked_link(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    labels = [button.text() for button in window.filter_buttons.values()]

    assert set(window.filter_buttons) == {"all", "none", "added", "deleted", "modified"}
    assert not any("未版本控制" in text for text in labels)
    assert labels == ["全部(A)", "无(N)", "已添加", "已删除", "已修改"]


def test_untracked_rows_can_be_hidden(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    _load_fixture(window)
    assert window.changes_table.rowCount() == 4

    window.show_untracked_check.setChecked(False)

    assert window.changes_table.rowCount() == 3
    assert "new.txt" not in window.checked_paths()

    window.show_untracked_check.setChecked(True)
    assert window.changes_table.rowCount() == 4


def test_hiding_untracked_preserves_existing_checks(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    _load_fixture(window)
    window._apply_filter("none")
    for _, item in window._table_rows():
        if item.text() == "gone.txt":
            item.setCheckState(Qt.Checked)

    window.show_untracked_check.setChecked(False)

    assert window.checked_paths() == ["gone.txt"]


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


def test_header_shows_repo_name_and_branch_chip(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    window._on_snapshot_loaded({"branch": "trunk", "changes": []})

    assert window.repo_name_label.text() == tmp_path.name
    assert window.branch_label.text() == "trunk"
    assert "trunk" in window.branch_label.toolTip()


def test_status_counts_selected(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    _load_fixture(window)

    assert "共 4 个变更" in window.status.text()
    assert "已选 3" in window.status.text()

    window._apply_filter("none")
    assert "已选 0" in window.status.text()


def test_commit_needs_selection_and_message(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    _load_fixture(window)

    assert window.btn_commit.isEnabled() is False
    assert window.btn_commit.toolTip() == "请填写提交信息"

    window.message_edit.setPlainText("feat: x")
    assert window.btn_commit.isEnabled() is True
    assert window.btn_commit.toolTip() == ""

    window._apply_filter("none")
    assert window.btn_commit.isEnabled() is False
    assert window.btn_commit.toolTip() == "请先勾选要提交的文件"


def test_empty_state_explains_clean_and_filtered(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)

    window._on_changes_loaded([])
    assert not window.empty_state.isHidden()
    assert "工作区干净" in window.empty_state.text()
    # 没有变更时不催促勾选，也不给点提交
    assert window.action_hint.text() == ""
    assert window.btn_commit.isEnabled() is False

    _load_fixture(window)
    assert window.empty_state.isHidden()

    window.show_untracked_check.setChecked(False)
    window._on_changes_loaded([repo.FileChange(path="n.txt", status=repo.UNTRACKED)])
    assert not window.empty_state.isHidden()
    assert "未显示任何文件" in window.empty_state.text()


def test_numeric_columns_are_right_aligned(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    window.show_untracked_check.setChecked(True)
    window._on_changes_loaded(_changes_fixture(), {"a.txt": (2, 1)})
    table = window.changes_table

    for column in (3, 4):
        assert table.item(0, column).textAlignment() & int(Qt.AlignmentFlag.AlignRight)


def test_busy_disables_commit_and_keeps_start_text(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    _load_fixture(window)
    window.message_edit.setPlainText("feat: x")
    assert window.btn_commit.isEnabled() is True

    window._set_busy(True, cancellable=True)
    assert window.btn_commit.isEnabled() is False
    assert window.btn_generate.isEnabled() is False
    assert window.btn_cancel.isEnabled() is True

    window._set_busy(False)
    assert window.btn_commit.isEnabled() is True


def test_indicator_box_is_wide_enough_to_hit(qapp, tmp_path, monkeypatch):
    """实测画出来的勾选框，并确认它周围有容错可点区。

    用户反馈：连续点击勾选框「迟钝或有时候无法响应」。定位到两个原因：
    1) Qt 只在鼠标松开点正好落在勾选框内时切换，画出来只有 17px，点偏就没反应；
    2) 快速连点第二次按下带 DoubleClick 标记，会被 Qt 整个丢掉。
    """
    window = _make_window(tmp_path, monkeypatch)
    _load_fixture(window)
    window.show()
    qapp.processEvents()

    table = window.changes_table
    item = table.item(0, 0)
    table.blockSignals(True)
    item.setCheckState(Qt.CheckState.Unchecked)
    table.blockSignals(False)
    qapp.processEvents()

    left, right, y = _indicator_box(window)
    assert 10 <= right - left + 1 <= 24, f"勾选框宽度异常：{left}..{right}"

    # 勾选框内部左缘一点点就必须能切换
    for x in (left + 1, (left + right) // 2, right - 1):
        table.blockSignals(True)
        item.setCheckState(Qt.CheckState.Unchecked)
        table.blockSignals(False)
        _send_click(table.viewport(), x, y, qapp)
        assert item.checkState() == Qt.CheckState.Checked, f"x={x} 点在框内却没切换"


def test_click_just_outside_indicator_still_toggles(qapp, tmp_path, monkeypatch):
    """点在勾选框外侧几个像素（差一点点没点准）也必须算数。"""
    window = _make_window(tmp_path, monkeypatch)
    _load_fixture(window)
    window.show()
    qapp.processEvents()

    table = window.changes_table
    item = table.item(0, 0)
    left, right, y = _indicator_box(window)

    for x, label in ((left - 4, "左外侧"), (right + 4, "右外侧")):
        table.blockSignals(True)
        item.setCheckState(Qt.CheckState.Unchecked)
        table.blockSignals(False)
        _send_click(table.viewport(), x, y, qapp)
        assert item.checkState() == Qt.CheckState.Checked, f"{label} x={x} 没切换"


def test_double_click_press_alone_toggles(qapp, tmp_path, monkeypatch):
    """快速连点的那一下（带 DoubleClick 标记的按下）必须生效。

    Qt 的 QAbstractItemView 只在普通按下时切换勾选，带 DoubleClick 标记的按下
    会被整个丢掉（releaseFromDoubleClick），于是快速连点第二次像「没反应」。
    """
    window = _make_window(tmp_path, monkeypatch)
    _load_fixture(window)
    window.show()
    qapp.processEvents()

    table = window.changes_table
    item = table.item(0, 0)
    left, right, y = _indicator_box(window)
    x = (left + right) // 2

    changes = []
    table.itemChanged.connect(lambda changed: changes.append(changed.checkState()))
    table.blockSignals(True)
    item.setCheckState(Qt.CheckState.Unchecked)
    table.blockSignals(False)
    changes.clear()

    from PySide6.QtCore import QEvent

    QApplication.sendEvent(table.viewport(), _mouse(QEvent.Type.MouseButtonDblClick, (x, y)))
    QApplication.sendEvent(
        table.viewport(), _mouse(QEvent.Type.MouseButtonRelease, (x, y), Qt.MouseButton.NoButton)
    )
    qapp.processEvents()

    assert item.checkState() == Qt.CheckState.Checked, "带 DoubleClick 标记的点击被丢掉了"
    assert len(changes) == 1, f"应当切换一次，实际 {len(changes)} 次"


def test_fast_double_click_counts_as_two_clicks(qapp, tmp_path, monkeypatch):
    """快速连点两次 = 两次切换，不能因为双击标记丢掉一次。

    连点序列是「普通按下 + 带 DoubleClick 标记的按下」，两次按下各算一次点击，
    所以从「未勾选」出发应当勾上再取消，正好回到未勾选。
    """
    window = _make_window(tmp_path, monkeypatch)
    _load_fixture(window)
    window.show()
    qapp.processEvents()

    table = window.changes_table
    item = table.item(0, 0)
    left, right, y = _indicator_box(window)
    x = (left + right) // 2

    changes = []
    table.itemChanged.connect(lambda changed: changes.append(changed.checkState()))

    table.blockSignals(True)
    item.setCheckState(Qt.CheckState.Unchecked)
    table.blockSignals(False)
    changes.clear()

    _send_click(table.viewport(), x, y, qapp, double=True)
    qapp.processEvents()

    assert len(changes) == 2, f"两次点击应当切换两次，实际 {len(changes)} 次"
    assert changes == [Qt.CheckState.Checked, Qt.CheckState.Unchecked]
    assert item.checkState() == Qt.CheckState.Unchecked



def test_click_on_path_text_does_not_toggle(qapp, tmp_path, monkeypatch):
    """点路径文字只能选中行，不能顺手改勾选（避免误提交/漏提交）。"""
    window = _make_window(tmp_path, monkeypatch)
    _load_fixture(window)
    window.show()
    qapp.processEvents()

    table = window.changes_table
    item = table.item(0, 0)
    left, right, y = _indicator_box(window)

    for x in (right + 12, 120, 300):
        table.blockSignals(True)
        item.setCheckState(Qt.CheckState.Checked)
        table.blockSignals(False)
        _send_click(table.viewport(), x, y, qapp)
        assert item.checkState() == Qt.CheckState.Checked, f"x={x} 点在文字上却改了勾选"


def test_press_toggles_immediately_and_release_does_not_repeat(qapp, tmp_path, monkeypatch):
    """一次按下 = 一次切换：按下立刻有反馈，随后的松开不能重复切换。

    这样连点、双击标记、拖拽都不影响结果，一次点击永远只切换一次。
    """
    from PySide6.QtCore import QEvent

    window = _make_window(tmp_path, monkeypatch)
    _load_fixture(window)
    window.show()
    qapp.processEvents()

    table = window.changes_table
    item = table.item(0, 0)
    left, right, y = _indicator_box(window)
    x = (left + right) // 2

    changes = []
    table.itemChanged.connect(lambda changed: changes.append(changed.checkState()))
    table.blockSignals(True)
    item.setCheckState(Qt.CheckState.Unchecked)
    table.blockSignals(False)
    changes.clear()

    QApplication.sendEvent(table.viewport(), _mouse(QEvent.Type.MouseButtonPress, (x, y)))
    qapp.processEvents()
    assert item.checkState() == Qt.CheckState.Checked, "按下没有立刻切换"
    assert len(changes) == 1

    QApplication.sendEvent(
        table.viewport(), _mouse(QEvent.Type.MouseButtonRelease, (x, y), Qt.MouseButton.NoButton)
    )
    qapp.processEvents()
    assert item.checkState() == Qt.CheckState.Checked, "松开又把勾选切回去了"
    assert len(changes) == 1, f"一次点击切换了 {len(changes)} 次"


def test_checkbox_press_selects_row_and_focuses_table(qapp, tmp_path, monkeypatch):
    """点勾选框要像点路径文字一样选中该行并拿到焦点，否则点完勾选框 A/N 快捷键失效。"""
    from PySide6.QtCore import QEvent

    window = _make_window(tmp_path, monkeypatch)
    _load_fixture(window)
    window.show()
    qapp.processEvents()

    table = window.changes_table
    table.clearSelection()
    window.message_edit.setFocus()
    qapp.processEvents()

    left, right, y = _indicator_box(window)
    QApplication.sendEvent(
        table.viewport(), _mouse(QEvent.Type.MouseButtonPress, ((left + right) // 2, y))
    )
    qapp.processEvents()

    assert table.selectionModel().selectedRows(), "点勾选框后没有选中该行"
    assert table.hasFocus(), "点勾选框后表格没有获得焦点"
    assert table.currentRow() == 0


def test_settings_button_opens_dialog_with_config(qapp, tmp_path, monkeypatch):
    from app.ui import settings_dialog as sd

    seen: list = []

    def fake_exec(self):
        seen.append(self)
        return int(sd.SettingsDialog.DialogCode.Rejected)

    monkeypatch.setattr(sd.SettingsDialog, "exec", fake_exec)
    monkeypatch.setattr(mw, "SettingsDialog", sd.SettingsDialog, raising=False)
    window = _make_window(tmp_path, monkeypatch)
    assert hasattr(window, "btn_settings")

    window.btn_settings.click()

    assert len(seen) == 1
    assert seen[0].original_style() == window.config.get("ui", {}).get("style")


def test_apply_style_updates_min_table_height(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    window.show()
    qapp.processEvents()

    window.apply_style("flat")

    row_height = window.changes_table.verticalHeader().defaultSectionSize()
    assert row_height == 28, "flat 的行高应来自样式表"
    assert (
        window.changes_table.minimumHeight()
        == row_height * theme.TABLE_MIN_VISIBLE_ROWS + theme.TABLE_MIN_HEIGHT_EXTRA
    )
    window.apply_style(theme.DEFAULT_STYLE)


def test_open_settings_saves_and_reloads_config(qapp, tmp_path, monkeypatch):
    import json

    from app.core import config as config_module
    from app.ui import settings_dialog as sd

    cfg_path = tmp_path / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_FILE", cfg_path)
    monkeypatch.setattr(mw, "SettingsDialog", sd.SettingsDialog, raising=False)

    def fake_exec(self):
        self.url_edit.setText("http://example.test/v1")
        self.model_edit.setText("demo-model")
        self.api_key_edit.setText("k")
        self.timeout_spin.setValue(15)
        flat = self.style_combo.findData("flat")
        self.style_combo.setCurrentIndex(flat)
        self.btn_save.click()
        return self.result()

    monkeypatch.setattr(sd.SettingsDialog, "exec", fake_exec)
    window = _make_window(tmp_path, monkeypatch)
    # _make_window 把 load_config 钉成常量，这里要测「重新读盘」，换回真实装载器
    #（真正读的文件由上面打桩的 CONFIG_FILE 指定）。
    monkeypatch.setattr(mw, "load_config", config_module.load_config)
    window.open_settings()

    saved = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert saved["api"]["url"] == "http://example.test/v1"
    assert saved["api"]["model"] == "demo-model"
    assert saved["api"]["api_key"] == "k"
    assert saved["api"]["timeout"] == 15
    assert saved["ui"]["style"] == "flat"
    assert window.config["api"]["url"] == "http://example.test/v1"
    assert "已保存" in window.status.text()
    window.apply_style(theme.DEFAULT_STYLE)


def test_open_settings_cancel_restores_style_and_writes_nothing(qapp, tmp_path, monkeypatch):
    from app.core import config as config_module
    from app.ui import settings_dialog as sd

    cfg_path = tmp_path / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_FILE", cfg_path)
    monkeypatch.setattr(mw, "SettingsDialog", sd.SettingsDialog, raising=False)
    window = _make_window(tmp_path, monkeypatch)
    window.apply_style(theme.DEFAULT_STYLE)  # 固定起点，免受同会话其它用例影响
    before = qapp.styleSheet()

    def fake_exec(self):
        # 模拟用户先预览了 flat，然后取消
        flat = self.style_combo.findData("flat")
        self.style_combo.setCurrentIndex(flat)
        window.apply_style("flat")
        self.reject()
        return self.result()

    monkeypatch.setattr(sd.SettingsDialog, "exec", fake_exec)
    window.open_settings()

    assert qapp.styleSheet() == before, "取消后必须还原打开前的样式"
    assert not cfg_path.exists(), "取消不应写盘"


def test_save_settings_failure_returns_error_and_keeps_config(qapp, tmp_path, monkeypatch):
    from app.core import config as config_module

    cfg_path = tmp_path / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_FILE", cfg_path)
    window = _make_window(tmp_path, monkeypatch)
    before = copy.deepcopy(window.config)

    def boom(_config):
        raise OSError("磁盘只读")

    monkeypatch.setattr(mw, "save_config", boom)

    error = window._save_settings({"api": {"url": "http://x/v1"}, "ui": {"style": "flat"}})

    assert error is not None and "保存失败" in error
    assert window.config == before, "保存失败时内存配置不应变化"
    assert not cfg_path.exists()
