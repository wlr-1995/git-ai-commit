"""主窗口：变更列表勾选 + AI 生成 + 提交。"""

import os
import re
import unicodedata
from pathlib import Path

from PySide6.QtCore import QEvent, QItemSelectionModel, QPoint, QRect, Qt
from PySide6.QtGui import QColor, QFontMetrics, QKeySequence, QShortcut
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
    QSizePolicy,
    QStyle,
    QStyleOptionViewItem,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..core import ai, repo
from ..core.config import load_config
from . import theme
from .worker import FunctionWorker

REFRESH = "refresh"
GENERATE = "generate"
COMMIT = "commit"

# 状态栏与对话框只显示这么长的摘要；完整错误放进可滚动详情，避免撑宽窗口。
_ERROR_SUMMARY_LIMIT = 120
# QMessageBox 不会自动换行，按显示列宽预先折行，把对话框宽度限制在合理范围。
_DIALOG_WRAP_COLUMNS = 38

#: 窗口最小尺寸，保证头部与表格在窄窗口下仍然可用。
_MIN_WINDOW_WIDTH = 560
_MIN_WINDOW_HEIGHT = 420


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


def _elide_label(label: QLabel, text: str) -> None:
    """按标签当前宽度做中间省略，并把完整文本放进 tooltip。"""
    metrics = QFontMetrics(label.font())
    width = max(label.width(), 60)
    label.setText(metrics.elidedText(text, Qt.TextElideMode.ElideMiddle, width))
    label.setToolTip(text)


class _SignalsBlocked:
    """临时屏蔽某个控件的信号，避免批量填表时逐项触发汇总刷新。"""

    def __init__(self, widget: QWidget):
        self._widget = widget
        self._previous = False

    def __enter__(self):
        self._previous = self._widget.blockSignals(True)
        return self

    def __exit__(self, *exc) -> bool:
        self._widget.blockSignals(self._previous)
        return False


class ChangesTable(QTableWidget):
    """变更列表表格：让勾选框「点得准、连点不丢」。

    Qt 的默认行为有两个坑：
    1. 只在**松开**那一刻、且松开点正好落在画出来的勾选框内时才切换勾选，
       而勾选框只有十几像素宽，点偏一点点就完全没反应；
    2. 快速连点的第二次按下会带 ``DoubleClick`` 标记，被 Qt 整个丢掉
       （``releaseFromDoubleClick``），于是连点像是「有时候不响应」。

    这里把交互契约改成与平台无关：**一次按下 = 一次切换**。
    - 命中区以勾选框为中心外扩到至少 :data:`HIT_SIZE` 见方（仍限制在单元格内），
      容忍鼠标/手指的小偏移；
    - 按下即切换，立刻有视觉反馈，不用等松开；
    - 记住「该松开已经被消化」，避免同一次点击切换两次。
    """

    #: 勾选框命中区的最小边长（画出来的方框约 17px）。
    HIT_SIZE = 26

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._swallow_release = False

    def indicator_hit_rect(self, pos: QPoint) -> QRect | None:
        """返回 (pos) 所在行的勾选框可点区域；不在勾选列上则返回 None。"""
        index = self.indexAt(pos)
        if not index.isValid() or index.column() != 0:
            return None
        item = self.item(index.row(), index.column())
        if item is None or not item.flags() & Qt.ItemFlag.ItemIsUserCheckable:
            return None

        cell = self.visualRect(index)
        option = QStyleOptionViewItem()
        option.rect = cell
        option.state |= QStyle.StateFlag.State_Enabled
        option.features |= QStyleOptionViewItem.ViewItemFeature.HasCheckIndicator
        option.checkState = item.checkState()
        indicator = self.style().subElementRect(
            QStyle.SubElement.SE_ItemViewItemCheckIndicator, option, self
        )
        hit = QRect(0, 0, self.HIT_SIZE, self.HIT_SIZE)
        hit.moveCenter(indicator.center())
        return hit.intersected(cell)

    def hits_indicator(self, pos: QPoint) -> bool:
        """(pos) 是否落在勾选框（含外扩容错）上。"""
        rect = self.indicator_hit_rect(pos)
        return rect is not None and rect.contains(pos)

    def _toggle_row(self, index) -> None:
        """切换该行勾选，并做点击勾选框时应有的选中/焦点反馈。

        选中状态不参与提交决策（提交内容由勾选框决定），所以这里按「点哪儿算哪儿」
        选中该行：既给用户位置反馈，也让随后的 A/N 快捷键可用（表格需要有焦点）。
        """
        item = self.item(index.row(), 0)
        item.setCheckState(
            Qt.CheckState.Unchecked
            if item.checkState() == Qt.CheckState.Checked
            else Qt.CheckState.Checked
        )
        self.setCurrentIndex(index)
        self.selectionModel().select(
            index,
            QItemSelectionModel.SelectionFlag.ClearAndSelect
            | QItemSelectionModel.SelectionFlag.Rows,
        )
        self.setFocus(Qt.FocusReason.MouseFocusReason)
        self._swallow_release = True

    def mousePressEvent(self, event) -> None:  # noqa: N802 - Qt 命名
        pos = event.position().toPoint()
        if event.button() == Qt.MouseButton.LeftButton and self.hits_indicator(pos):
            self._toggle_row(self.indexAt(pos))
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseDoubleClickEvent(self, event) -> None:  # noqa: N802 - Qt 命名
        pos = event.position().toPoint()
        if event.button() == Qt.MouseButton.LeftButton and self.hits_indicator(pos):
            # 快速连点的第二次按下：仍算一次点击，不能被 Qt 丢掉。
            self._toggle_row(self.indexAt(pos))
            event.accept()
            return
        super().mouseDoubleClickEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802 - Qt 命名
        if self._swallow_release and event.button() == Qt.MouseButton.LeftButton:
            # 勾选已经在按下时切换过，这次松开不能再切一次。
            self._swallow_release = False
            event.accept()
            return
        super().mouseReleaseEvent(event)


#: 变更表格的列（首列内含勾选框与路径，与 TortoiseGit 的「检查修改」一致）。
_TABLE_COLUMNS = ("路径", "扩展名", "状态", "添加行数", "删除行数")

#: 数字列右对齐，读起来才能按位比较。
_RIGHT_ALIGNED_COLUMNS = (3, 4)

#: 「选中：」过滤按钮。已添加/已删除/已修改为「累加勾选」，不会取消其它勾选。
_FILTERS = (
    ("all", "全部(A)", "勾选列表中的全部文件"),
    ("none", "无(N)", "取消全部勾选"),
    ("added", "已添加", "勾选所有「已添加」的文件，不取消其它勾选"),
    ("deleted", "已删除", "勾选所有「已删除」的文件，不取消其它勾选"),
    ("modified", "已修改", "勾选所有「已修改 / 已重命名」的文件，不取消其它勾选"),
)

_EMPTY_CLEAN = "工作区干净\n没有需要提交的改动"
_EMPTY_FILTERED = "未显示任何文件\n可勾选「显示未受版本控制的文件」后再看"


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
        self._busy = False
        self._changes: list[repo.FileChange] = []
        self._stats: dict = {}
        self._repo_path = os.path.normpath(repo_root)
        self._repo_name = Path(self._repo_path).name or self._repo_path

        self.setWindowTitle(f"{self._repo_name} — AI 提交")
        size = self.config.get("ui", {})
        self.resize(size.get("window_width", 720), size.get("window_height", 520))
        self.setMinimumSize(_MIN_WINDOW_WIDTH, _MIN_WINDOW_HEIGHT)
        self._build_ui()
        self.refresh()

    # --- 界面搭建 ---

    def _build_ui(self) -> None:
        self.setWindowIcon(theme.app_icon())

        central = QWidget(self)
        central.setObjectName("central")
        layout = QVBoxLayout(central)
        layout.setContentsMargins(*theme.WINDOW_MARGINS)
        layout.setSpacing(theme.LAYOUT_SPACING)

        self.status = QLabel("就绪")
        self.status.setObjectName("statusLabel")
        self.status.setWordWrap(True)

        layout.addLayout(self._build_header())

        message_label = QLabel("提交信息")
        message_label.setObjectName("sectionLabel")
        layout.addWidget(message_label)

        self.message_edit = QPlainTextEdit()
        self.message_edit.setPlaceholderText("填写提交信息，或用「AI 生成」按改动生成")
        self.message_edit.setMinimumHeight(96)
        self.message_edit.textChanged.connect(self._update_summary)
        layout.addWidget(self.message_edit, 1)

        layout.addLayout(self._build_list_header())

        self.changes_table = self._build_table()
        layout.addWidget(self.changes_table, 3)

        self.empty_state = QLabel(self.changes_table.viewport())
        self.empty_state.setObjectName("emptyState")
        self.empty_state.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.empty_state.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self.empty_state.hide()
        self.changes_table.viewport().installEventFilter(self)

        self.show_untracked_check = QCheckBox("显示未受版本控制的文件(U)")
        self.show_untracked_check.setToolTip(
            "默认不显示未受版本控制的文件（它们也不会被提交）；勾选后才列出"
        )
        self.show_untracked_check.setChecked(
            bool(self.config.get("ui", {}).get("show_untracked", False))
        )
        self.show_untracked_check.toggled.connect(lambda _checked: self._render_rows())
        layout.addWidget(self.show_untracked_check)

        layout.addLayout(self._build_actions())
        layout.addWidget(self.status)

        self.setCentralWidget(central)
        self._install_shortcuts()
        self._update_summary()

    def _build_header(self) -> QHBoxLayout:
        self.repo_name_label = QLabel(self._repo_name)
        self.repo_name_label.setObjectName("repoName")
        self.repo_name_label.setToolTip(self._repo_path)
        self.repo_name_label.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)

        self.repo_path_label = QLabel(self._repo_path)
        self.repo_path_label.setObjectName("repoPath")
        self.repo_path_label.setToolTip(self._repo_path)
        self.repo_path_label.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        self.repo_path_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)

        titles = QVBoxLayout()
        titles.setSpacing(0)
        titles.addWidget(self.repo_name_label)
        titles.addWidget(self.repo_path_label)

        branch_caption = QLabel("分支")
        branch_caption.setObjectName("hintLabel")

        self.branch_label = QLabel(repo.UNKNOWN_BRANCH)
        self.branch_label.setObjectName("branchChip")
        self.branch_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.branch_label.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)

        row = QHBoxLayout()
        row.setSpacing(theme.SPACE_XS)
        row.addLayout(titles, 1)
        row.addWidget(branch_caption, 0, Qt.AlignmentFlag.AlignVCenter)
        row.addWidget(self.branch_label, 0, Qt.AlignmentFlag.AlignVCenter)
        return row

    def _build_list_header(self) -> QHBoxLayout:
        caption = QLabel("变更列表")
        caption.setObjectName("sectionLabel")

        pick = QLabel("选中")
        pick.setObjectName("hintLabel")

        row = QHBoxLayout()
        row.setSpacing(theme.SPACE_XS)
        row.addWidget(caption)
        row.addSpacing(theme.SPACE_SM)
        row.addWidget(pick)

        self.filter_buttons: dict[str, QPushButton] = {}
        for key, text, tip in _FILTERS:
            button = QPushButton(text)
            button.setObjectName("chip")
            button.setToolTip(tip)
            button.setCursor(Qt.CursorShape.PointingHandCursor)
            button.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            button.clicked.connect(lambda _checked=False, name=key: self._apply_filter(name))
            self.filter_buttons[key] = button
            row.addWidget(button)

        row.addStretch(1)
        hint = QLabel("F5 刷新")
        hint.setObjectName("hintLabel")
        row.addWidget(hint)
        return row

    def _build_table(self) -> QTableWidget:
        table = ChangesTable(0, len(_TABLE_COLUMNS))
        table.setHorizontalHeaderLabels(list(_TABLE_COLUMNS))
        table.verticalHeader().setVisible(False)
        # 样式文件里的 QHeaderView#verticalHeader 命中它（行高由样式决定）。
        table.verticalHeader().setObjectName("verticalHeader")
        table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        table.setAlternatingRowColors(True)
        table.setShowGrid(True)
        table.setWordWrap(False)
        table.setTextElideMode(Qt.TextElideMode.ElideMiddle)
        table.setMouseTracking(True)
        table.setCornerButtonEnabled(False)
        table.itemChanged.connect(lambda _item: self._update_summary())

        header = table.horizontalHeader()
        # 列尽量靠左排布：路径列用固定初始宽度，其余按内容收紧，右侧留白。
        header.setStretchLastSection(False)
        header.setDefaultAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        header.setHighlightSections(False)
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Interactive)
        table.setColumnWidth(0, 340)
        for column in range(1, len(_TABLE_COLUMNS)):
            header.setSectionResizeMode(column, QHeaderView.ResizeMode.ResizeToContents)
        for column in _RIGHT_ALIGNED_COLUMNS:
            item = table.horizontalHeaderItem(column)
            if item is not None:
                item.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        return table

    def _build_actions(self) -> QHBoxLayout:
        self.btn_generate = QPushButton("AI 生成")
        self.btn_generate.setToolTip("根据勾选的改动调用 AI 生成提交信息")
        self.btn_cancel = QPushButton("取消")
        self.btn_cancel.setToolTip("取消正在进行的 AI 生成")
        self.btn_commit = QPushButton("提交")
        self.btn_commit.setObjectName("primaryButton")
        self.btn_commit.setMinimumWidth(104)
        self.btn_cancel.setEnabled(False)
        self.btn_generate.clicked.connect(self.on_generate)
        self.btn_cancel.clicked.connect(self.on_cancel)
        self.btn_commit.clicked.connect(self.on_commit)

        self.action_hint = QLabel()
        self.action_hint.setObjectName("hintLabel")

        row = QHBoxLayout()
        row.setSpacing(theme.SPACE_SM)
        row.addWidget(self.btn_generate)
        row.addWidget(self.btn_cancel)
        row.addWidget(self.action_hint)
        row.addStretch(1)
        row.addWidget(self.btn_commit)
        return row

    def _install_shortcuts(self) -> None:
        refresh_shortcut = QShortcut(QKeySequence("F5"), self)
        refresh_shortcut.activated.connect(self.refresh)
        # A/N 仅在表格获得焦点时生效，避免与「提交信息」输入框冲突。
        for key, kind in (("A", "all"), ("N", "none")):
            shortcut = QShortcut(QKeySequence(key), self.changes_table)
            shortcut.setContext(Qt.ShortcutContext.WidgetShortcut)
            shortcut.activated.connect(lambda name=kind: self._apply_filter(name))
        toggle_untracked = QShortcut(QKeySequence("U"), self.changes_table)
        toggle_untracked.setContext(Qt.ShortcutContext.WidgetShortcut)
        toggle_untracked.activated.connect(self.show_untracked_check.toggle)

    # --- 头部与空状态 ---

    def _elide_header(self) -> None:
        _elide_label(self.repo_name_label, self._repo_name)
        _elide_label(self.repo_path_label, self._repo_path)

    def _position_empty_state(self) -> None:
        self.empty_state.setGeometry(self.changes_table.viewport().rect())

    def _update_empty_state(self) -> None:
        """表格没有可见行时给出解释，而不是留一片空白。"""
        if self.changes_table.rowCount():
            self.empty_state.hide()
            return
        self.empty_state.setText(_EMPTY_CLEAN if not self._changes else _EMPTY_FILTERED)
        self._position_empty_state()
        self.empty_state.show()
        self.empty_state.raise_()

    def showEvent(self, event) -> None:  # noqa: N802 - Qt 命名
        super().showEvent(event)
        # 行高来自样式表，polish 之后才读得到，所以在这里同步最小高度。
        self._sync_table_min_height()

    def _sync_table_min_height(self) -> None:
        """表格最小高度跟着样式里的行高走：露出 4 整行，避免最后一行被截半。"""
        row_height = self.changes_table.verticalHeader().defaultSectionSize()
        self.changes_table.setMinimumHeight(
            row_height * theme.TABLE_MIN_VISIBLE_ROWS + theme.TABLE_MIN_HEIGHT_EXTRA
        )

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt 命名
        super().resizeEvent(event)
        self._elide_header()
        self._position_empty_state()

    def eventFilter(self, obj, event) -> bool:  # noqa: N802 - Qt 命名
        if obj is self.changes_table.viewport() and event.type() == QEvent.Type.Resize:
            self._position_empty_state()
        return super().eventFilter(obj, event)

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
        self._set_branch(snapshot.get("branch") or repo.UNKNOWN_BRANCH)
        self._on_changes_loaded(snapshot.get("changes") or [], snapshot.get("stats") or {})

    def _set_branch(self, branch: str) -> None:
        self.branch_label.setText(branch)
        self.branch_label.setToolTip(f"当前分支：{branch}")

    def _on_changes_loaded(self, changes, stats=None) -> None:
        self._changes = list(changes)
        self._stats = dict(stats or {})
        # 全新加载：清空旧行，勾选状态按默认策略重来。
        with _SignalsBlocked(self.changes_table):
            self.changes_table.setRowCount(0)
        self._render_rows()

    def _render_rows(self) -> None:
        """按当前「显示未受版本控制的文件」开关渲染表格，保留已存在的勾选状态。"""
        previous: dict[str, object] = {}
        for _, item in self._table_rows():
            change = item.data(Qt.ItemDataRole.UserRole)
            if change is not None:
                previous[change.path] = item.checkState()

        checked_default = self.config.get("selection", {}).get("checked_by_default", "tracked")
        show_untracked = self.show_untracked_check.isChecked()
        visible = [
            change
            for change in self._changes
            if show_untracked or change.status != repo.UNTRACKED
        ]

        with _SignalsBlocked(self.changes_table):
            self.changes_table.setRowCount(0)
            for change in visible:
                row = self.changes_table.rowCount()
                self.changes_table.insertRow(row)
                self._fill_row(row, change, previous.get(change.path), checked_default)

        if not visible:
            self.message_edit.setPlainText("")
        self._update_summary()

    def _fill_row(self, row: int, change: repo.FileChange, state, checked_default: str) -> None:
        """填一行：首列勾选框 + 路径，其余列按语义上色、数字列右对齐。"""
        path_item = QTableWidgetItem(change.path)
        path_item.setData(Qt.ItemDataRole.UserRole, change)
        path_item.setToolTip(change.path)
        path_item.setTextAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        if state is None:
            if checked_default == "all":
                state = Qt.CheckState.Checked
            elif checked_default == "none":
                state = Qt.CheckState.Unchecked
            else:
                state = (
                    Qt.CheckState.Unchecked
                    if change.status == repo.UNTRACKED
                    else Qt.CheckState.Checked
                )
        path_item.setCheckState(state)
        self.changes_table.setItem(row, 0, path_item)

        has_stat = change.path in self._stats
        added, deleted = self._stats.get(change.path, (None, None))

        suffix_item = QTableWidgetItem(Path(change.path).suffix)
        suffix_item.setForeground(QColor(theme.TEXT_MUTED))
        suffix_item.setTextAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)

        status_item = QTableWidgetItem(repo.STATUS_TEXT.get(change.status, change.status))
        status_item.setForeground(theme.status_color(change.status))
        status_item.setTextAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        if theme.status_is_bold(change.status):
            status_item.setFont(theme.section_font())

        cells = (
            suffix_item,
            status_item,
            QTableWidgetItem(_stat_text(added) if has_stat else ""),
            QTableWidgetItem(_stat_text(deleted) if has_stat else ""),
        )
        for offset, item in enumerate(cells, start=1):
            if offset in _RIGHT_ALIGNED_COLUMNS:
                item.setTextAlignment(
                    Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter
                )
                item.setForeground(QColor(theme.TEXT_MUTED))
            self.changes_table.setItem(row, offset, item)

    def _on_refresh_failed(self, message: str) -> None:
        self._changes = []
        self._stats = {}
        with _SignalsBlocked(self.changes_table):
            self.changes_table.setRowCount(0)
        self._update_summary()
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
            if item.checkState() == Qt.CheckState.Checked:
                change = item.data(Qt.ItemDataRole.UserRole)
                paths.append(change.path if change is not None else item.text())
        return paths

    def checked_changes(self) -> list[repo.FileChange]:
        """勾选项对应的变更对象（用于重命名时补全旧路径）。"""
        checked = set(self.checked_paths())
        return [change for change in self._changes if change.path in checked]

    def checked_commit_paths(self) -> list[str]:
        """提交用 pathspec：重命名同时包含新旧路径，避免旧路径删除被遗留。"""
        return repo.commit_pathspecs(self.checked_changes())

    # --- 汇总与选择 ---

    def _set_status(self, text: str, error: bool = False) -> None:
        """状态栏文字。单色方案下「出错」用正文色 + 加粗，不用红色。"""
        self.status.setText(text)
        font = theme.section_font() if error else theme.base_font()
        self.status.setFont(font)

    def _update_summary(self) -> None:
        """统一刷新状态栏、空状态与按钮可用性，避免各处各写一套。"""
        total = self.changes_table.rowCount()
        selected = len(self.checked_paths())
        if not self._busy:
            self._set_status(f"共 {total} 个变更 · 已选 {selected}")
        self._update_empty_state()

        message = self.message_edit.toPlainText().strip()
        blocked = ""
        if total and not selected:
            blocked = "请先勾选要提交的文件"
        elif total and not message:
            blocked = "请填写提交信息"
        self.action_hint.setText(blocked)
        self.btn_commit.setToolTip(blocked)
        # 没得提交（没有可见变更 / 没勾选）或没写提交信息时都不给点。
        self.btn_commit.setEnabled(bool(selected) and bool(message) and not self._busy)

    def _set_all(self, checked: bool) -> None:
        state = Qt.CheckState.Checked if checked else Qt.CheckState.Unchecked
        with _SignalsBlocked(self.changes_table):
            for _, item in self._table_rows():
                item.setCheckState(state)
        self._update_summary()

    def _apply_filter(self, kind: str) -> None:
        """「选中：」按钮。

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
        with _SignalsBlocked(self.changes_table):
            for _, item in self._table_rows():
                change = item.data(Qt.ItemDataRole.UserRole)
                if change is not None and change.status in wanted:
                    item.setCheckState(Qt.CheckState.Checked)
        self._update_summary()

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
            self._set_status("已取消")

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
        self._set_status(start_text)
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
        self._busy = busy
        self.btn_generate.setEnabled(not busy)
        self.btn_cancel.setEnabled(busy and cancellable)
        self._update_summary()

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt 命名
        worker = self._worker
        if worker is not None and worker.isRunning():
            # 提交不可取消：阻塞等待会让事件循环停摆，若提交恰好在此期间完成并
            # 排队了 succeeded，窗口会先关闭，导致「提交成功」永远不显示。
            # 因此改为忽略本次关闭，由正常完成回调报告结果。
            if self._operation == COMMIT:
                event.ignore()
                self._set_status("正在提交，请稍候…")
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
        self._set_status("已生成，可编辑后提交")

    def _on_committed(self, output: str) -> None:
        self._set_status("提交成功")
        QMessageBox.information(self, "AI 提交", "提交成功")
        self.refresh()

    def _build_error_box(self, message: str) -> QMessageBox:
        """错误对话框：只显示短摘要，完整信息放进可滚动详情，避免撑宽窗口。"""
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Icon.Warning)
        box.setWindowTitle("AI 提交")
        box.setText(_wrap_for_dialog(_error_summary(message)))
        box.setDetailedText(message)
        return box

    def _error(self, message: str) -> None:
        self._set_status(f"错误：{_error_summary(message)}", error=True)
        self._build_error_box(message).exec()
