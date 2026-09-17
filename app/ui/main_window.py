"""主窗口：变更列表勾选 + AI 生成 + 提交。"""

import re
import unicodedata
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..core import ai, repo
from ..core.config import load_config
from .worker import FunctionWorker

REFRESH = "refresh"
GENERATE = "generate"
COMMIT = "commit"

# 状态栏与对话框只显示这么长的摘要；完整错误放进可滚动详情，避免撑宽窗口。
_ERROR_SUMMARY_LIMIT = 120
# QMessageBox 不会自动换行，按显示列宽预先折行，把对话框宽度限制在合理范围。
_DIALOG_WRAP_COLUMNS = 38


def _char_width(char: str) -> int:
    """东亚全角字符按两列计算。"""
    return 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1


def _display_width(text: str) -> int:
    """估算字符串的显示列宽。"""
    return sum(_char_width(char) for char in text)


def _split_by_width(text: str, columns: int) -> tuple[str, str]:
    """把 text 按显示列宽切一刀，返回 (头部, 余下)。"""
    width = 0
    for index, char in enumerate(text):
        char_width = _char_width(char)
        if width + char_width > columns:
            return text[:index], text[index:]
        width += char_width
    return text, ""


def _wrap_for_dialog(text: str, columns: int = _DIALOG_WRAP_COLUMNS) -> str:
    """按显示宽度折行：优先在空白处断行，超长单词按列宽硬切。

    QMessageBox 自身不会换行，长错误会把对话框撑得很宽，所以先手动折行。
    """
    lines: list[str] = []
    for paragraph in text.splitlines() or [""]:
        current = ""
        width = 0
        for word in re.findall(r"\S+", paragraph):
            word_width = _display_width(word)
            if current and width + 1 + word_width > columns:
                lines.append(current)
                current = ""
                width = 0
            while word_width > columns:
                head, word = _split_by_width(word, columns)
                if current:
                    lines.append(current)
                    current = ""
                    width = 0
                lines.append(head)
                word_width = _display_width(word)
            if not word:
                continue
            if current:
                current += " " + word
                width += 1 + word_width
            else:
                current = word
                width = word_width
        if current:
            lines.append(current)
    return "\n".join(lines)


def _error_summary(message: str) -> str:
    """把可能很长的错误压成单行短摘要。"""
    text = (message or "").strip()
    first_line = text.splitlines()[0].strip() if text else ""
    if not first_line:
        return "发生未知错误"
    if len(first_line) <= _ERROR_SUMMARY_LIMIT:
        return first_line
    return first_line[:_ERROR_SUMMARY_LIMIT] + "…"


#: 变更表格的列（首列内含勾选框与路径，与 TortoiseGit 的「检查修改」一致）。
_TABLE_COLUMNS = ("路径", "扩展名", "状态", "添加行数", "删除行数")

#: 「选中：」过滤链接行。已添加/已删除/已修改为「累加勾选」，不会取消其它勾选。
_FILTER_HTML = (
    "选中： "
    '<a href="all">全部(A)</a> '
    '<a href="none">无(N)</a> '
    '<a href="added">已添加</a> '
    '<a href="deleted">已删除</a> '
    '<a href="modified">已修改</a>'
)


def _stat_text(value: int | None) -> str:
    """行数文本：None（二进制）显示 ``-``；未统计由调用方留空。"""
    return "-" if value is None else str(value)


class MainWindow(QMainWindow):
    def __init__(self, repo_root: str):
        super().__init__()
        self.repo_root = repo_root
        self.config = load_config()
        self._worker: FunctionWorker | None = None
        self._operation: str | None = None
        self._pending_refresh = False
        self._changes: list[repo.FileChange] = []
        self._stats: dict = {}

        self.setWindowTitle("AI 提交")
        size = self.config.get("ui", {})
        self.resize(size.get("window_width", 720), size.get("window_height", 520))
        self._build_ui()
        self.refresh()

    def _build_ui(self) -> None:
        central = QWidget(self)
        layout = QVBoxLayout(central)

        self.header = QLabel(f"仓库：{self.repo_root}")
        self.header.setWordWrap(True)
        layout.addWidget(self.header)

        self.branch_label = QLabel("分支：读取中…")
        self.branch_label.setWordWrap(True)
        layout.addWidget(self.branch_label)

        # 提交信息（日志）在上，变更列表在下，与 TortoiseGit 提交窗口一致。
        layout.addWidget(QLabel("提交信息"))
        self.message_edit = QPlainTextEdit()
        layout.addWidget(self.message_edit, 2)

        layout.addWidget(QLabel("变更列表（F5 键刷新）："))

        self.filter_label = QLabel(_FILTER_HTML)
        self.filter_label.setTextFormat(Qt.RichText)
        self.filter_label.setWordWrap(True)
        self.filter_label.linkActivated.connect(self._apply_filter)
        layout.addWidget(self.filter_label)

        self.changes_table = QTableWidget(0, len(_TABLE_COLUMNS))
        self.changes_table.setHorizontalHeaderLabels(list(_TABLE_COLUMNS))
        self.changes_table.verticalHeader().setVisible(False)
        self.changes_table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.changes_table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.changes_table.setAlternatingRowColors(True)
        table_header = self.changes_table.horizontalHeader()
        # 列尽量靠左排布：路径列用固定初始宽度，其余按内容收紧，右侧留白。
        table_header.setStretchLastSection(False)
        table_header.setDefaultAlignment(Qt.AlignLeft | Qt.AlignVCenter)
        table_header.setSectionResizeMode(0, QHeaderView.Interactive)
        self.changes_table.setColumnWidth(0, 340)
        for column in range(1, len(_TABLE_COLUMNS)):
            table_header.setSectionResizeMode(column, QHeaderView.ResizeToContents)
        layout.addWidget(self.changes_table, 3)

        self.show_untracked_check = QCheckBox("显示未受版本控制的文件(U)")
        self.show_untracked_check.setChecked(True)
        self.show_untracked_check.toggled.connect(lambda _checked: self._render_rows())
        layout.addWidget(self.show_untracked_check)

        actions = QHBoxLayout()
        self.btn_generate = QPushButton("AI 生成")
        self.btn_cancel = QPushButton("取消")
        self.btn_commit = QPushButton("提交")
        self.btn_cancel.setEnabled(False)
        self.btn_generate.clicked.connect(self.on_generate)
        self.btn_cancel.clicked.connect(self.on_cancel)
        self.btn_commit.clicked.connect(self.on_commit)
        actions.addWidget(self.btn_generate)
        actions.addWidget(self.btn_cancel)
        actions.addStretch(1)
        actions.addWidget(self.btn_commit)
        layout.addLayout(actions)

        self.status = QLabel("就绪")
        self.status.setWordWrap(True)
        layout.addWidget(self.status)

        self.setCentralWidget(central)
        self._install_shortcuts()

    def _install_shortcuts(self) -> None:
        refresh_shortcut = QShortcut(QKeySequence("F5"), self)
        refresh_shortcut.activated.connect(self.refresh)
        # A/N 仅在表格获得焦点时生效，避免与「提交信息」输入框冲突。
        for key, kind in (("A", "all"), ("N", "none")):
            shortcut = QShortcut(QKeySequence(key), self.changes_table)
            shortcut.setContext(Qt.WidgetShortcut)
            shortcut.activated.connect(lambda name=kind: self._apply_filter(name))
        toggle_untracked = QShortcut(QKeySequence("U"), self.changes_table)
        toggle_untracked.setContext(Qt.WidgetShortcut)
        toggle_untracked.activated.connect(self.show_untracked_check.toggle)

    # --- 数据 ---

    def _load_snapshot(self) -> dict:
        """一次性读取分支、变更与行数统计，供后台线程调用。"""
        return {
            "branch": repo.current_branch(self.repo_root),
            "changes": repo.list_changes(self.repo_root),
            "stats": repo.diff_numstat(self.repo_root),
        }

    def refresh(self) -> None:
        """异步读取分支与变更；若已有操作在跑，则排队到该操作结束后执行。"""
        if self._worker is not None:
            self._pending_refresh = True
            return
        self._run_worker(
            self._load_snapshot,
            self._on_snapshot_loaded,
            start_text="正在读取变更…",
            operation=REFRESH,
            on_failure=self._on_refresh_failed,
        )

    def _on_snapshot_loaded(self, snapshot: dict) -> None:
        self.branch_label.setText(f"分支：{snapshot.get('branch') or repo.UNKNOWN_BRANCH}")
        self._on_changes_loaded(snapshot.get("changes") or [], snapshot.get("stats") or {})

    def _on_changes_loaded(self, changes, stats=None) -> None:
        self._changes = list(changes)
        self._stats = dict(stats or {})
        # 全新加载：清空旧行，勾选状态按默认策略重来。
        self.changes_table.setRowCount(0)
        self._render_rows()

    def _render_rows(self) -> None:
        """按当前「显示未受版本控制的文件」开关渲染表格，保留已存在的勾选状态。"""
        previous: dict[str, object] = {}
        for _, item in self._table_rows():
            change = item.data(Qt.UserRole)
            if change is not None:
                previous[change.path] = item.checkState()

        checked_default = self.config.get("selection", {}).get("checked_by_default", "tracked")
        show_untracked = self.show_untracked_check.isChecked()
        visible = [
            change
            for change in self._changes
            if show_untracked or change.status != repo.UNTRACKED
        ]

        self.changes_table.setRowCount(0)
        for change in visible:
            row = self.changes_table.rowCount()
            self.changes_table.insertRow(row)

            path_item = QTableWidgetItem(change.path)
            path_item.setData(Qt.UserRole, change)
            state = previous.get(change.path)
            if state is None:
                if checked_default == "all":
                    state = Qt.Checked
                elif checked_default == "none":
                    state = Qt.Unchecked
                else:
                    state = Qt.Unchecked if change.status == repo.UNTRACKED else Qt.Checked
            path_item.setCheckState(state)
            self.changes_table.setItem(row, 0, path_item)

            has_stat = change.path in self._stats
            added, deleted = self._stats.get(change.path, (None, None))
            cells = [
                Path(change.path).suffix,
                repo.STATUS_TEXT.get(change.status, change.status),
                _stat_text(added) if has_stat else "",
                _stat_text(deleted) if has_stat else "",
            ]
            for offset, text in enumerate(cells, start=1):
                self.changes_table.setItem(row, offset, QTableWidgetItem(text))

        self.status.setText(f"共 {len(visible)} 个变更")
        self.btn_commit.setEnabled(bool(visible))
        if not visible:
            self.message_edit.setPlainText("")

    def _on_refresh_failed(self, message: str) -> None:
        self._changes = []
        self._stats = {}
        self.changes_table.setRowCount(0)
        self.btn_commit.setEnabled(False)
        self._error(f"读取变更失败：{message}")

    def _table_rows(self):
        for row in range(self.changes_table.rowCount()):
            item = self.changes_table.item(row, 0)
            if item is not None:
                yield row, item

    def _path_item(self, row: int) -> QTableWidgetItem | None:
        return self.changes_table.item(row, 0)

    def checked_paths(self) -> list[str]:
        paths = []
        for _, item in self._table_rows():
            if item.checkState() == Qt.Checked:
                change = item.data(Qt.UserRole)
                paths.append(change.path if change is not None else item.text())
        return paths

    def checked_changes(self) -> list[repo.FileChange]:
        """勾选项对应的变更对象（用于重命名时补全旧路径）。"""
        checked = set(self.checked_paths())
        return [change for change in self._changes if change.path in checked]

    def checked_commit_paths(self) -> list[str]:
        """提交用 pathspec：重命名同时包含新旧路径，避免旧路径删除被遗留。"""
        return repo.commit_pathspecs(self.checked_changes())

    def _set_all(self, checked: bool) -> None:
        state = Qt.Checked if checked else Qt.Unchecked
        for _, item in self._table_rows():
            item.setCheckState(state)

    def _apply_filter(self, kind: str) -> None:
        """「选中：」链接。

        全部/无 直接全勾/全不勾；已添加/已删除/已修改 只做「累加勾选」，
        不会取消其它已勾选项。
        """
        if kind == "all":
            self._set_all(True)
            return
        if kind == "none":
            self._set_all(False)
            return
        wanted = {
            "added": {repo.ADDED},
            "deleted": {repo.DELETED},
            "modified": {repo.MODIFIED, repo.RENAMED},
        }.get(kind, set())
        if not wanted:
            return
        for _, item in self._table_rows():
            change = item.data(Qt.UserRole)
            if change is not None and change.status in wanted:
                item.setCheckState(Qt.Checked)

    # --- 动作 ---

    def on_generate(self) -> None:
        paths = self.checked_paths()
        if not paths:
            self._error("请先勾选至少一个文件")
            return
        api_cfg = self.config.get("api", {})
        if not (api_cfg.get("url") or "").strip():
            self._error("未配置 api.url，请编辑配置文件后重试")
            return

        max_lines = self.config.get("git", {}).get("max_diff_lines", 200)

        def job():
            diff_text = repo.diff_for(self.repo_root, paths, max_lines=max_lines)
            if not diff_text.strip():
                raise RuntimeError("勾选的文件没有可分析的改动")
            return ai.generate_commit_message(diff_text, api_cfg)

        self._run_worker(
            job, self._on_generated, start_text="正在生成…", operation=GENERATE, cancellable=True
        )

    def on_commit(self) -> None:
        changes = self.checked_changes()
        paths = [change.path for change in changes]
        message = self.message_edit.toPlainText().strip()
        if not paths:
            self._error("请先勾选至少一个文件")
            return
        if not message:
            self._error("提交信息不能为空")
            return
        commit_paths = repo.commit_pathspecs(changes)

        def job():
            repo.stage(self.repo_root, paths)
            return repo.commit(self.repo_root, message, commit_paths)

        self._run_worker(job, self._on_committed, start_text="正在提交…", operation=COMMIT)

    def on_cancel(self) -> None:
        # 仅 AI 生成可取消；提交一旦开始必须跑完，取消会隐藏真实发生的提交。
        if self._worker is not None and self._operation == GENERATE:
            self._worker.cancel()
            self.status.setText("已取消")

    # --- 线程辅助 ---

    def _run_worker(
        self,
        fn,
        on_success,
        start_text: str,
        operation: str,
        cancellable: bool = False,
        on_failure=None,
    ) -> None:
        if self._worker is not None:
            self._error("当前有操作正在进行，请稍候")
            return
        self._operation = operation
        self._set_busy(True, cancellable)
        self.status.setText(start_text)
        worker = FunctionWorker(fn)
        worker.succeeded.connect(on_success)
        worker.failed.connect(on_failure or self._error)
        worker.finished.connect(self._on_worker_finished)
        self._worker = worker
        worker.start()

    def _on_worker_finished(self) -> None:
        self._worker = None
        self._operation = None
        self._set_busy(False)
        if self._pending_refresh:
            self._pending_refresh = False
            self.refresh()

    def _set_busy(self, busy: bool, cancellable: bool = False) -> None:
        self.btn_generate.setEnabled(not busy)
        self.btn_commit.setEnabled(not busy and bool(self._changes))
        self.btn_cancel.setEnabled(busy and cancellable)

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt 命名
        worker = self._worker
        if worker is not None and worker.isRunning():
            # 提交不可取消：阻塞等待会让事件循环停摆，若提交恰好在此期间完成并
            # 排队了 succeeded，窗口会先关闭，导致「提交成功」永远不显示。
            # 因此改为忽略本次关闭，由正常完成回调报告结果。
            if self._operation == COMMIT:
                event.ignore()
                self.status.setText("正在提交，请稍候…")
                return
            # 仅 AI 生成可取消；提交一旦开始必须跑完，取消会隐藏真实发生的提交。
            if self._operation == GENERATE:
                worker.cancel()
            if not worker.wait(5000):
                event.ignore()
                return
        event.accept()

    def _on_generated(self, text: str) -> None:
        self.message_edit.setPlainText(text)
        self.status.setText("已生成，可编辑后提交")

    def _on_committed(self, output: str) -> None:
        self.status.setText("提交成功")
        QMessageBox.information(self, "AI 提交", "提交成功")
        self.refresh()

    def _build_error_box(self, message: str) -> QMessageBox:
        """错误对话框：只显示短摘要，完整信息放进可滚动详情，避免撑宽窗口。"""
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Warning)
        box.setWindowTitle("AI 提交")
        box.setText(_wrap_for_dialog(_error_summary(message)))
        box.setDetailedText(message)
        return box

    def _error(self, message: str) -> None:
        self.status.setText(f"错误：{_error_summary(message)}")
        self._build_error_box(message).exec()
