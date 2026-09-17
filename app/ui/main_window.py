"""主窗口：变更文件勾选 + AI 生成 + 提交。"""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from ..core import ai, repo
from ..core.config import load_config
from .worker import FunctionWorker

REFRESH = "refresh"
GENERATE = "generate"
COMMIT = "commit"


class MainWindow(QMainWindow):
    def __init__(self, repo_root: str):
        super().__init__()
        self.repo_root = repo_root
        self.config = load_config()
        self._worker: FunctionWorker | None = None
        self._operation: str | None = None
        self._pending_refresh = False
        self._changes: list[repo.FileChange] = []

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

        buttons = QHBoxLayout()
        self.btn_all = QPushButton("全选")
        self.btn_none = QPushButton("全不选")
        self.btn_all.clicked.connect(lambda: self._set_all(True))
        self.btn_none.clicked.connect(lambda: self._set_all(False))
        buttons.addWidget(self.btn_all)
        buttons.addWidget(self.btn_none)
        buttons.addStretch(1)
        layout.addLayout(buttons)

        self.list_widget = QListWidget()
        layout.addWidget(self.list_widget, 3)

        layout.addWidget(QLabel("提交信息"))
        self.message_edit = QPlainTextEdit()
        layout.addWidget(self.message_edit, 2)

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
        layout.addWidget(self.status)

        self.setCentralWidget(central)

    # --- 数据 ---

    def refresh(self) -> None:
        """异步读取变更；若已有操作在跑，则排队到该操作结束后执行。"""
        if self._worker is not None:
            self._pending_refresh = True
            return
        self._run_worker(
            lambda: repo.list_changes(self.repo_root),
            self._on_changes_loaded,
            start_text="正在读取变更…",
            operation=REFRESH,
            on_failure=self._on_refresh_failed,
        )

    def _on_changes_loaded(self, changes) -> None:
        self._changes = list(changes)
        self.list_widget.clear()
        checked_default = self.config.get("selection", {}).get("checked_by_default", "tracked")
        for change in self._changes:
            letter = repo.STATUS_LETTER.get(change.status, "?")
            item = QListWidgetItem(f"[{letter}] {change.path}")
            item.setData(Qt.UserRole, change.path)
            if checked_default == "all":
                item.setCheckState(Qt.Checked)
            elif checked_default == "none":
                item.setCheckState(Qt.Unchecked)
            else:
                item.setCheckState(Qt.Unchecked if change.status == repo.UNTRACKED else Qt.Checked)
            self.list_widget.addItem(item)
        self.status.setText(f"共 {len(self._changes)} 个变更")
        self.btn_commit.setEnabled(bool(self._changes))
        if not self._changes:
            self.message_edit.setPlainText("")

    def _on_refresh_failed(self, message: str) -> None:
        self._changes = []
        self.list_widget.clear()
        self.btn_commit.setEnabled(False)
        self._error(f"读取变更失败：{message}")

    def checked_paths(self) -> list[str]:
        paths = []
        for index in range(self.list_widget.count()):
            item = self.list_widget.item(index)
            if item.checkState() == Qt.Checked:
                paths.append(item.data(Qt.UserRole))
        return paths

    def _set_all(self, checked: bool) -> None:
        state = Qt.Checked if checked else Qt.Unchecked
        for index in range(self.list_widget.count()):
            self.list_widget.item(index).setCheckState(state)

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
        paths = self.checked_paths()
        message = self.message_edit.toPlainText().strip()
        if not paths:
            self._error("请先勾选至少一个文件")
            return
        if not message:
            self._error("提交信息不能为空")
            return

        def job():
            repo.stage(self.repo_root, paths)
            return repo.commit(self.repo_root, message, paths)

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

    def _error(self, message: str) -> None:
        self.status.setText(f"错误：{message}")
        QMessageBox.warning(self, "AI 提交", message)
