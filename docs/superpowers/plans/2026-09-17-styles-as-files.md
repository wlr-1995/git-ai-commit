# 样式外置为 `.qss` 文件 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把界面样式从 `app/ui/theme.py` 的 Python f-string 搬到 `app/ui/styles/*.qss`，一份文件一套样式，`theme.py` 收缩为「装载器 + QSS 管不了的东西」，且 `traditional.qss` 与改动前逐像素一致。

**Architecture:** 样式是真实文件（UTF-8/LF，字面值，`url()` 相对本文件解析）；`theme.load_stylesheet(style)` 负责读取、解析相对 `url()`、失败回退默认样式；三处原本靠 Qt API 传值的开关（行高、网格线、斑马纹）改由 QSS 表达（已实测）；调色板与逐项着色被删除，颜色只存在于 `.qss`。

**Tech Stack:** Python 3.13、PySide6 6.11、pytest（`QT_QPA_PLATFORM=offscreen`）、git。

**Spec:** `docs/superpowers/specs/2026-09-17-styles-as-files-design.md`

## Global Constraints

- 平台：Windows（Win10/11）；Python 3.12+（开发机 3.13.13）
- 运行时依赖只有 `PySide6`、`requests`；测试依赖 `pytest`，不新增任何依赖
- 只有黑白灰阶：`.qss` 里每个颜色都必须 `r == g == b`；`theme.py` 里不得出现任何颜色字面值（唯一例外：窗口图标用 `Qt.GlobalColor.black/white`）
- 样式文件编码 UTF-8、换行 LF；`url("...")` 一律相对该 `.qss` 文件所在目录
- 间距只用 4/8/12/16/24；圆角只用 6（表格/输入框的历史覆盖值 4 保留，见 Task 1 注意事项）
- 文案中文；所有 git/AI 调用不得在 UI 主线程
- 测试统一跑 `python -m pytest -q`（`tests/conftest.py` 已设 offscreen 并套真实主题，不要绕过）
- 提交信息用英文 `type(scope): subject` 风格，与既有历史一致

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `app/ui/styles/traditional.qss` | 默认样式（现行黑白「传统框感」） | 新建 |
| `app/ui/styles/flat.qss` | 第二套样式（扁平），证明「一份文件一套样式」 | 新建（Task 2） |
| `app/ui/styles/icons/check.svg` | 勾选标记（从 `app/ui/icons/` 移入，供样式相对引用） | 移动 |
| `app/ui/theme.py` | 装载器 + 间距刻度 + 窗口图标 | 重写 |
| `app/ui/main_window.py` | 表格开关改由 QSS 决定；删逐项着色 | 修改 |
| `tests/test_theme.py` | 样式文件与装载器测试 | 重写 |
| `tests/test_main_window.py` | 去掉颜色断言，勾选框量取改为读样式 | 修改 |
| `README.md` | 样式目录说明 + 视觉区分变化 | 修改 |

---

### Task 1: 样式装载器 + `traditional.qss`（外观不变）

**Files:**
- Create: `app/ui/styles/traditional.qss`
- Move: `app/ui/icons/check.svg` → `app/ui/styles/icons/check.svg`
- Modify: `app/ui/theme.py`（重写）
- Test: `tests/test_theme.py`

**Interfaces:**
- Consumes: 无
- Produces（后续任务与设置界面依赖的精确签名）：
  - `theme.STYLES_DIR: Path`、`theme.ICONS_DIR: Path`、`theme.DEFAULT_STYLE: str = "traditional"`
  - `theme.CHECK_ICON: str`（`styles/icons/check.svg` 的 posix 绝对路径）
  - `theme.style_path(style: str) -> Path`
  - `theme.style_label(path: Path) -> str`
  - `theme.available_styles() -> list[tuple[str, str]]`
  - `theme.load_stylesheet(style: str | None = None) -> str`
  - `theme.apply_style(app, style: str) -> None`
  - `theme.apply_light_theme(app, style: str = DEFAULT_STYLE) -> None`
  - 暂未删除（Task 3 才删）：`base_font`、`section_font`、`light_palette`、`app_icon`、`status_color`、`status_is_bold`、全部颜色令牌、`SPACE_*`、`WINDOW_MARGINS`、`LAYOUT_SPACING`、`TABLE_ROW_HEIGHT/TABLE_GRID/TABLE_ZEBRA`
  - 本任务删除：`BASE_QSS`、`DIRECTION_QSS`、`stylesheet()`

- [ ] **Step 1: 存一份改动前的基准截图**

先写脚本 `%TEMP%\opencode\shot.py`（若已存在则沿用；内容如下），再运行它，产出四状态截图作为「外观不变」的比对基准。

```python
"""生成界面截图（真实 Windows 字体）：四状态，用于外观比对。"""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(r"D:\wlr\ai\git-ai-commit")))

import app  # noqa: E402,F401
from PySide6.QtWidgets import QApplication  # noqa: E402

from app.ui.main_window import MainWindow  # noqa: E402
from app.ui.theme import apply_light_theme  # noqa: E402

OUT = Path(tempfile.gettempdir()) / "ui-shots"


def git(repo, *args):
    subprocess.run(["git", *args], cwd=repo, capture_output=True, check=True)


def make_dirty_repo() -> Path:
    repo = Path(tempfile.mkdtemp(prefix="shot-dirty-"))
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "t")
    git(repo, "config", "user.email", "t@example.com")
    for name, text in (
        ("README.md", "one\ntwo\nthree\n"),
        ("src/app.py", "print('a')\nprint('b')\n"),
        ("docs/notes.md", "# notes\n"),
    ):
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "init")
    (repo / "README.md").write_text("one\nTWO\nthree\nfour\n", encoding="utf-8")
    (repo / "docs/notes.md").unlink()
    git(repo, "mv", "src/app.py", "src/main.py")
    (repo / "临时草稿.txt").write_text("draft\n", encoding="utf-8")
    return repo


def make_clean_repo() -> Path:
    repo = Path(tempfile.mkdtemp(prefix="shot-clean-"))
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "t")
    git(repo, "config", "user.email", "t@example.com")
    (repo / "README.md").write_text("ok\n", encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "init")
    return repo


def shoot(qapp, repo: Path, name: str, prepare=None):
    window = MainWindow(str(repo))
    window.resize(880, 620)
    if window._worker is not None:
        window._worker.wait(8000)
    window._on_snapshot_loaded(window._load_snapshot())
    window.show()
    qapp.processEvents()
    if prepare is not None:
        prepare(window)
        qapp.processEvents()
    window.grab().save(str(OUT / f"{name}.png"), "PNG")
    print(f"[{name}] 行数={window.changes_table.rowCount()}"
          f" 状态栏={window.status.text()}", flush=True)
    window.close()


def main(target: str) -> int:
    global OUT
    OUT = Path(tempfile.gettempdir()) / target
    OUT.mkdir(exist_ok=True)
    qapp = QApplication.instance() or QApplication([])
    apply_light_theme(qapp)
    dirty = make_dirty_repo()
    clean = make_clean_repo()
    try:
        shoot(qapp, dirty, "main")

        def ready(window):
            window.message_edit.setPlainText("feat: 调整变更列表界面")
            window._apply_filter("all")
            window.changes_table.selectRow(0)
            window.changes_table.setFocus()

        shoot(qapp, dirty, "ready", ready)
        shoot(
            qapp,
            dirty,
            "unchecked",
            lambda w: (w.message_edit.setPlainText(""), w._apply_filter("none")),
        )
        shoot(qapp, clean, "empty")
    finally:
        shutil.rmtree(dirty, ignore_errors=True)
        shutil.rmtree(clean, ignore_errors=True)
    print(f"输出目录: {OUT}", flush=True)
    return 0


if __name__ == "__main__":
    import os

    code = main(sys.argv[1] if len(sys.argv) > 1 else "ui-shots")
    sys.stdout.flush()
    os._exit(code)
```

Run（PowerShell）：

```powershell
$env:PYTHONIOENCODING='utf-8'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8
python -X utf8 "$env:TEMP\opencode\shot.py" parity-before
```

Expected: 打印 4 行 `[main]/[ready]/[unchecked]/[empty]`，最后 `输出目录: ...\parity-before`，目录里有 4 个 PNG。

- [ ] **Step 2: 写失败测试**

在 `tests/test_theme.py` 里**整文件替换**为下面内容。`test_light_palette_is_white`、`test_light_palette_disabled_text_is_grey`、`test_main_applies_light_theme` 三条本任务保留原样（Task 3 才处理），`test_every_color_is_grayscale` 换成扫样式文件的 `test_style_files_are_grayscale`：

```python
import re
from pathlib import Path

import pytest
from PySide6.QtGui import QColor, QPalette
from PySide6.QtWidgets import QApplication

from app.ui import theme


@pytest.fixture(scope="module")
def qapp():
    return QApplication.instance() or QApplication([])


def _styles() -> list[tuple[str, Path]]:
    return [(key, theme.style_path(key)) for key, _label in theme.available_styles()]


def test_style_files_are_grayscale(qapp):
    """只允许黑白灰：每个 .qss 里的色值都必须落在灰阶上。"""
    files = _styles()
    assert files, "styles 目录里没有任何样式"
    for key, path in files:
        hexes = re.findall(r"#([0-9a-fA-F]{6})", path.read_text(encoding="utf-8"))
        assert hexes, f"{key}.qss 里没有任何色值"
        for value in hexes:
            red, green, blue = (int(value[i : i + 2], 16) for i in (0, 2, 4))
            assert red == green == blue, f"{key}.qss 的 #{value} 不是灰阶"


def test_no_leftover_token_placeholders(qapp):
    """样式文件里不再做令牌插值；残留的 {TOKEN} 会被 Qt 静默忽略。"""
    for key, path in _styles():
        text = path.read_text(encoding="utf-8")
        assert not re.search(r"\{[A-Z_]+\}", text), f"{key}.qss 还有未替换的占位符"


def test_url_refs_resolve_to_existing_files(qapp):
    """url() 必须被解析成存在的绝对路径（Qt 不按样式表所在目录解析相对路径）。"""
    urls = re.findall(r'url\("([^"]+)"\)', theme.load_stylesheet())
    assert urls, "默认样式里没有 url() 引用"
    for url in urls:
        assert Path(url).is_absolute(), url
        assert Path(url).is_file(), url
    assert Path(theme.CHECK_ICON).is_file()


def test_style_label_comes_from_first_line_comment(qapp):
    assert theme.style_label(theme.style_path(theme.DEFAULT_STYLE)) == "传统框感"


def test_unknown_style_falls_back_to_default(qapp):
    assert theme.load_stylesheet("ghost") == theme.load_stylesheet(theme.DEFAULT_STYLE)


def test_available_styles_skips_partials_and_sorts_default_first(qapp, tmp_path, monkeypatch):
    (tmp_path / "alpha.qss").write_text(
        "/* 名称: 阿尔法 */\nQWidget { color: #000000; }\n", encoding="utf-8"
    )
    (tmp_path / "_partial.qss").write_text("QWidget { color: #000000; }\n", encoding="utf-8")
    (tmp_path / ".hidden.qss").write_text("QWidget { color: #000000; }\n", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("x\n", encoding="utf-8")
    monkeypatch.setattr(theme, "STYLES_DIR", tmp_path)
    monkeypatch.setattr(theme, "DEFAULT_STYLE", "alpha")

    assert theme.available_styles() == [("alpha", "阿尔法")]


def test_broken_or_missing_style_falls_back(qapp, tmp_path, monkeypatch):
    (tmp_path / "good.qss").write_text("QWidget { color: #000000; }\n", encoding="utf-8")
    (tmp_path / "bad.qss").write_bytes(b"\xff\xfe\x00\x00 not utf-8")
    monkeypatch.setattr(theme, "STYLES_DIR", tmp_path)
    monkeypatch.setattr(theme, "DEFAULT_STYLE", "good")

    assert theme.load_stylesheet("bad") == theme.load_stylesheet("good")
    assert theme.load_stylesheet("missing") == theme.load_stylesheet("good")


def test_missing_styles_dir_returns_empty_stylesheet(qapp, tmp_path, monkeypatch):
    monkeypatch.setattr(theme, "STYLES_DIR", tmp_path / "nope")
    assert theme.load_stylesheet() == ""
    assert theme.available_styles() == []


def test_apply_light_theme_forces_light(qapp):
    original_qss = qapp.styleSheet()
    try:
        theme.apply_light_theme(qapp)
        assert qapp.style() == "Fusion"
        assert qapp.styleSheet() == theme.load_stylesheet(theme.DEFAULT_STYLE)
        assert not qapp.windowIcon().isNull()
    finally:
        qapp.setStyleSheet(original_qss)


def test_checkbox_indicator_is_explicitly_drawn(qapp):
    """Fusion 自绘的勾选框在白底上几乎看不见，必须由样式显式画出来。"""
    qss = theme.load_stylesheet()

    assert 'url("icons/check.svg")' in qss
    for selector in ("QCheckBox::indicator", "QTableView::indicator"):
        assert selector in qss
    assert "QCheckBox::indicator:checked" in qss


def test_light_qss_targets_white(qapp):
    qss = theme.load_stylesheet()

    assert qss.strip()
    assert "background: #ffffff" in qss
    assert "QPushButton#primaryButton" in qss


def test_tokens_stay_on_scale(qapp):
    spaces = (theme.SPACE_XS, theme.SPACE_SM, theme.SPACE_MD, theme.SPACE_LG, theme.SPACE_XL)

    assert spaces == tuple(sorted(spaces))
    assert all(value % 4 == 0 for value in spaces)


def test_light_palette_is_white(qapp):
    palette = theme.light_palette()

    assert palette.color(QPalette.ColorRole.Window).name() == "#ffffff"
    assert palette.color(QPalette.ColorRole.Base).name() == "#ffffff"
    assert palette.color(QPalette.ColorRole.WindowText).name() == "#1f1f1f"
    assert palette.color(QPalette.ColorRole.Text).lightness() < 80
    assert palette.color(QPalette.ColorRole.Button).lightness() > 200


def test_light_palette_disabled_text_is_grey(qapp):
    palette = theme.light_palette()
    disabled = palette.color(QPalette.ColorGroup.Disabled, QPalette.ColorRole.ButtonText)

    assert disabled.name() == "#9e9e9e"


def test_main_applies_light_theme(monkeypatch):
    """入口必须在建窗口前套用白色主题，否则系统深色模式下会变黑底。"""
    import app.core.repo as repo_module
    import app.main as main_module
    import app.ui.main_window as mw_module

    events = []

    class FakeApplication:
        def __init__(self, argv):
            events.append("app-created")

        def exec(self):
            return 0

    class FakeWindow:
        def __init__(self, root):
            events.append(("window", root))

        def show(self):
            events.append("shown")

    monkeypatch.setattr("PySide6.QtWidgets.QApplication", FakeApplication)
    monkeypatch.setattr(
        theme, "apply_light_theme", lambda app: events.append(("theme", type(app).__name__))
    )
    monkeypatch.setattr(repo_module, "find_repo_root", lambda start: "R")
    monkeypatch.setattr(mw_module, "MainWindow", FakeWindow)

    assert main_module.main(["prog", "somewhere"]) == 0
    assert events == ["app-created", ("theme", "FakeApplication"), ("window", "R"), "shown"]
```

- [ ] **Step 3: 运行测试确认失败**

Run: `python -m pytest tests/test_theme.py -q`
Expected: FAIL — `AttributeError: module 'app.ui.theme' has no attribute 'style_path'`（收集期即报错）

- [ ] **Step 4: 创建 `app/ui/styles/traditional.qss`**

注意：`theme.py` 里 `DIRECTION_QSS` 覆盖了 `BASE_QSS`，落到文件里必须写**覆盖后的最终值**（输入框 `QPlainTextEdit/QTextEdit` 的圆角是 `4px`、内边距是 `4px 8px`；`QLineEdit` 保持 `6px`/`8px`）。

```qss
/* 名称: 传统框感 */
/*
 * 黑白单色：所有色值必须是灰阶（r == g == b）。
 * url() 相对本文件所在目录解析；改样式只改这个文件，不用碰 Python。
 */

* {
    font-family: "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI";
    font-size: 9pt;
}
QWidget { color: #1f1f1f; }

/* 表面底色（原先由调色板承担） */
QMainWindow, QDialog, QStatusBar, QMenu, QMessageBox { background: #ffffff; }
QToolTip {
    background: #ffffff;
    color: #1f1f1f;
    border: 1px solid #c4c4c4;
}

/* 输入 */
QLineEdit {
    background: #ffffff;
    border: 1px solid #d9d9d9;
    border-radius: 6px;
    padding: 8px;
    selection-background-color: #ededed;
    selection-color: #1f1f1f;
}
QPlainTextEdit, QTextEdit {
    background: #ffffff;
    border: 1px solid #c4c4c4;
    border-radius: 4px;
    padding: 4px 8px;
    selection-background-color: #ededed;
    selection-color: #1f1f1f;
}
QLineEdit:focus { border: 1px solid #1f1f1f; }
QPlainTextEdit:focus, QTextEdit:focus { border: 1px solid #1f1f1f; }

/* 按钮 */
QPushButton {
    background: #f6f6f6;
    border: 1px solid #c4c4c4;
    border-radius: 6px;
    padding: 6px 16px;
}
QPushButton:hover { background: #eeeeee; }
QPushButton:pressed { background: #e3e3e3; }
QPushButton:focus { border: 1px solid #1f1f1f; }
QPushButton:disabled {
    background: #fafafa;
    border-color: #e6e6e6;
    color: #9e9e9e;
}
QPushButton#primaryButton {
    background: #1f1f1f;
    border: 1px solid #1f1f1f;
    color: #ffffff;
    font-weight: 600;
}
QPushButton#primaryButton:hover { background: #000000; border-color: #000000; }
QPushButton#primaryButton:pressed { background: #000000; }
QPushButton#primaryButton:disabled {
    background: #e3e3e3;
    border-color: #d9d9d9;
    color: #9e9e9e;
}
QPushButton#chip {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 10px;
    padding: 2px 10px;
    color: #1f1f1f;
}
QPushButton#chip:hover { background: #ededed; border-color: #d9d9d9; }
QPushButton#chip:pressed { background: #d9d9d9; }

/* 标签 */
QLabel#repoName { font-weight: 600; font-size: 11pt; }
QLabel#repoPath { color: #6b6b6b; font-size: 8pt; }
QLabel#branchChip {
    background: #ededed;
    border: 1px solid #d9d9d9;
    border-radius: 9px;
    color: #000000;
    font-size: 8pt;
    padding: 1px 10px;
}
QLabel#sectionLabel { font-weight: 600; }
QLabel#hintLabel { color: #6b6b6b; font-size: 8pt; }
QLabel#emptyState { color: #6b6b6b; font-size: 10pt; }
QLabel#statusLabel {
    color: #6b6b6b;
    border-top: 1px solid #e6e6e6;
    padding-top: 8px;
}

/* 勾选框：白底 + 明确描边，勾选后近黑填充叠白色对勾（对勾是 SVG 文件） */
QCheckBox { spacing: 8px; }
QCheckBox::indicator, QTableView::indicator {
    width: 15px;
    height: 15px;
    border: 1px solid #6b6b6b;
    border-radius: 3px;
    background: #ffffff;
}
QCheckBox::indicator:hover, QTableView::indicator:hover {
    border: 1px solid #1f1f1f;
    background: #e3e3e3;
}
QCheckBox::indicator:checked, QTableView::indicator:checked {
    background: #1f1f1f;
    border: 1px solid #1f1f1f;
    image: url("icons/check.svg");
}
QCheckBox::indicator:checked:hover, QTableView::indicator:checked:hover {
    background: #000000;
    border: 1px solid #000000;
}

/* 表格：传统框感——面板边框 + 斑马纹，表头填充成条，行高 24 */
QTableWidget, QTableView {
    background: #ffffff;
    alternate-background-color: #f7f7f7;
    border: 1px solid #c4c4c4;
    border-radius: 4px;
    gridline-color: #e6e6e6;
}
QTableWidget::item { padding: 0 4px; }
QTableWidget::item:selected { background: #ededed; color: #1f1f1f; }
QHeaderView { background: #f2f2f2; }
QHeaderView#verticalHeader { qproperty-defaultSectionSize: 24; }
QHeaderView::section {
    background: #f2f2f2;
    border: none;
    border-right: 1px solid #e6e6e6;
    border-bottom: 1px solid #c4c4c4;
    font-weight: 600;
    padding: 4px 4px;
}
QTableCornerButton::section {
    background: #f2f2f2;
    border: none;
    border-bottom: 1px solid #c4c4c4;
}

/* 下拉框 / 数字框（设置界面用）。弹窗选中色必须显式指定，
   否则删掉调色板后会漏出 Fusion 的蓝色高亮。 */
QComboBox, QAbstractSpinBox, QSpinBox {
    background: #ffffff;
    border: 1px solid #d9d9d9;
    border-radius: 6px;
    padding: 4px 8px;
    selection-background-color: #ededed;
    selection-color: #1f1f1f;
}
QComboBox:focus, QAbstractSpinBox:focus, QSpinBox:focus { border: 1px solid #1f1f1f; }
QComboBox:disabled, QAbstractSpinBox:disabled, QSpinBox:disabled {
    background: #fafafa;
    border-color: #e6e6e6;
    color: #9e9e9e;
}
QComboBox::drop-down { border: none; width: 18px; }
QComboBox QAbstractItemView {
    background: #ffffff;
    border: 1px solid #c4c4c4;
    selection-background-color: #ededed;
    selection-color: #1f1f1f;
    outline: none;
}
QAbstractItemView { selection-background-color: #ededed; selection-color: #1f1f1f; }
QMenu::item:selected { background: #ededed; color: #1f1f1f; }

/* 滚动条 */
QScrollBar:vertical { background: transparent; width: 12px; margin: 0; }
QScrollBar::handle:vertical { background: #d9d9d9; border-radius: 6px; min-height: 28px; }
QScrollBar::handle:vertical:hover { background: #c4c4c4; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: transparent; }
QScrollBar:horizontal { background: transparent; height: 12px; margin: 0; }
QScrollBar::handle:horizontal { background: #d9d9d9; border-radius: 6px; min-width: 28px; }
QScrollBar::handle:horizontal:hover { background: #c4c4c4; }
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal { width: 0; }
QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal { background: transparent; }
```

- [ ] **Step 5: 移动勾选图标**

```powershell
git mv app/ui/icons/check.svg app/ui/styles/icons/check.svg
```

Expected: `git status` 显示 `renamed: app/ui/icons/check.svg -> app/ui/styles/icons/check.svg`（`app/ui/icons/` 目录空了会自动消失）。

- [ ] **Step 6: 重写 `app/ui/theme.py`**

整文件替换为（本任务**保留**调色板、字体、状态色与 `TABLE_*`，它们仍被 `main_window.py` 使用，Task 3 才删）：

```python
"""白色主题：QSS 从样式文件读取，这里只放 QSS 管不了的东西与装载器。

- 样式是真实文件：``app/ui/styles/*.qss``，一份文件一套样式，目录扫描即可发现。
- 样式文件里写**字面值**（``#1f1f1f``、``8px``），``url("...")`` 用相对本文件的路径。
- Windows 11 默认样式会跟随系统深色模式；这里固定 Fusion，保证界面始终是白底。
"""

import re
from pathlib import Path

from PySide6.QtCore import QRect, Qt
from PySide6.QtGui import QColor, QFont, QIcon, QPainter, QPalette, QPixmap

# --- 样式文件 ----------------------------------------------------------------

UI_DIR = Path(__file__).resolve().parent
STYLES_DIR = UI_DIR / "styles"
ICONS_DIR = STYLES_DIR / "icons"

#: 默认样式（文件缺失或样式名未知时回退到它）。
DEFAULT_STYLE = "traditional"

#: 勾选标记（QSS 只能引用文件，不能内嵌图形；测试用它确认引用真实存在）。
CHECK_ICON = (ICONS_DIR / "check.svg").as_posix()

_URL_RE = re.compile(r'url\(\s*"([^"]+)"\s*\)')
_LABEL_RE = re.compile(r"^\s*/\*\s*名称\s*[:：]\s*(.+?)\s*\*/")

# --- 设计令牌 ----------------------------------------------------------------

#: 间距刻度，全部为 4 的倍数（Qt 布局 API 只认数字，QSS 管不到布局）。
SPACE_XS = 4
SPACE_SM = 8
SPACE_MD = 12
SPACE_LG = 16
SPACE_XL = 24

#: 圆角半径。
RADIUS = 6

#: 主窗口内容边距与区块间距（方向 B：传统 → 更紧凑）。
WINDOW_MARGINS = (SPACE_MD, SPACE_SM, SPACE_MD, SPACE_XS)
LAYOUT_SPACING = SPACE_SM

#: 中性色。
BACKGROUND = "#ffffff"
SURFACE = "#f6f6f6"
SURFACE_HOVER = "#eeeeee"
SURFACE_PRESSED = "#e3e3e3"
SURFACE_DISABLED = "#fafafa"
BORDER = "#d9d9d9"
BORDER_STRONG = "#c4c4c4"
GRID = "#e6e6e6"
HEADER_BG = "#f2f2f2"
ZEBRA = "#f7f7f7"

#: 文字。
TEXT = "#1f1f1f"
TEXT_MUTED = "#6b6b6b"
TEXT_DISABLED = "#9e9e9e"
TEXT_INVERSE = "#ffffff"

#: 单色强调：整套界面只用黑、白与灰阶，「强调」用近黑而不是彩色。
INK = "#1f1f1f"
INK_HOVER = "#000000"
INK_PRESSED = "#000000"
INK_SOFT = "#ededed"
INK_SOFT_BORDER = "#d9d9d9"

#: 状态只用灰阶区分（未跟踪弱化），需要立刻处理的状态用加粗而不是颜色。
STATUS_COLORS = {
    "modified": TEXT,
    "added": TEXT,
    "deleted": TEXT,
    "renamed": TEXT,
    "untracked": TEXT_MUTED,
    "conflicted": TEXT,
}

#: 需要立刻处理的状态：加粗突出，避免引入颜色。
BOLD_STATUSES = frozenset({"conflicted"})

#: 界面字体：中文优先微软雅黑 UI，回退到雅黑 / Segoe UI。
FONT_FAMILIES = ("Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI")
FONT_SIZE = 9
FONT_SIZE_SMALL = 8

#: 表格的行高与边框策略（样式文件里以 QSS 表达；这里供 Qt API 使用）。
TABLE_ROW_HEIGHT = 24
TABLE_GRID = True
TABLE_ZEBRA = True


# --- 样式装载 ----------------------------------------------------------------


def style_path(style: str) -> Path:
    """样式 key 对应的文件路径。"""
    return STYLES_DIR / f"{style}.qss"


def style_label(path: Path) -> str:
    """显示名：取首行注释里的 ``/* 名称: xxx */``，没有就用文件名。"""
    try:
        first_line = path.read_text(encoding="utf-8").splitlines()[0]
    except (OSError, UnicodeDecodeError, IndexError):
        return path.stem
    match = _LABEL_RE.match(first_line)
    return match.group(1) if match else path.stem


def available_styles() -> list[tuple[str, str]]:
    """[(样式 key, 显示名)]：默认样式排最前，其余按文件名排序。

    以 ``_`` 或 ``.`` 开头的文件不列出（留给共享片段与编辑器临时文件）。
    """
    if not STYLES_DIR.is_dir():
        return []
    keys = [
        path.stem
        for path in STYLES_DIR.glob("*.qss")
        if not path.name.startswith(("_", "."))
    ]
    keys.sort(key=lambda key: (key != DEFAULT_STYLE, key))
    return [(key, style_label(style_path(key))) for key in keys]


def _resolve_urls(text: str, base: Path) -> str:
    """把 ``url("相对路径")`` 解析成绝对路径（Qt 不按样式表所在目录解析）。"""

    def replace(match: re.Match) -> str:
        target = Path(match.group(1))
        if target.is_absolute():
            return match.group(0)
        return f'url("{(base / target).as_posix()}")'

    return _URL_RE.sub(replace, text)


def load_stylesheet(style: str | None = None) -> str:
    """读取样式文件；未知样式或读不出来则回退默认样式，再不行返回空样式表。"""
    for key in (style or DEFAULT_STYLE, DEFAULT_STYLE):
        path = style_path(key)
        if not path.is_file():
            continue
        try:
            return _resolve_urls(path.read_text(encoding="utf-8"), path.parent)
        except (OSError, UnicodeDecodeError):
            continue
    return ""


def apply_style(app, style: str) -> None:
    """把一套样式应用到整个应用。"""
    app.setStyleSheet(load_stylesheet(style))


# --- QSS 管不了的部分 --------------------------------------------------------


def base_font() -> QFont:
    """界面基础字体（微软雅黑 UI）。"""
    font = QFont()
    font.setFamilies(list(FONT_FAMILIES))
    font.setPointSize(FONT_SIZE)
    return font


def section_font() -> QFont:
    """区块标题：同族、加粗半档，用于建立层级而不是靠加大字号。"""
    font = base_font()
    font.setWeight(QFont.Weight.DemiBold)
    return font


def ink_color() -> QColor:
    return QColor(INK)


def status_color(status: str) -> QColor:
    """状态文字色：单色方案下只有正文色与弱化灰，未知状态回退正文色。"""
    return QColor(STATUS_COLORS.get(status, TEXT))


def status_is_bold(status: str) -> bool:
    """需要立刻处理的状态用加粗表达（不引入颜色）。"""
    return status in BOLD_STATUSES


def light_palette() -> QPalette:
    """白色主题调色板（Fusion 样式下对全部控件生效）。"""
    palette = QPalette()
    for role, value in (
        (QPalette.ColorRole.Window, BACKGROUND),
        (QPalette.ColorRole.WindowText, TEXT),
        (QPalette.ColorRole.Base, BACKGROUND),
        (QPalette.ColorRole.AlternateBase, ZEBRA),
        (QPalette.ColorRole.Text, TEXT),
        (QPalette.ColorRole.Button, SURFACE),
        (QPalette.ColorRole.ButtonText, TEXT),
        (QPalette.ColorRole.BrightText, TEXT_INVERSE),
        (QPalette.ColorRole.Highlight, INK),
        (QPalette.ColorRole.HighlightedText, TEXT_INVERSE),
        (QPalette.ColorRole.Link, INK),
        (QPalette.ColorRole.LinkVisited, INK),
        (QPalette.ColorRole.ToolTipBase, BACKGROUND),
        (QPalette.ColorRole.ToolTipText, TEXT),
        (QPalette.ColorRole.PlaceholderText, TEXT_DISABLED),
    ):
        palette.setColor(role, QColor(value))

    for role in (
        QPalette.ColorRole.WindowText,
        QPalette.ColorRole.Text,
        QPalette.ColorRole.ButtonText,
    ):
        palette.setColor(QPalette.ColorGroup.Disabled, role, QColor(TEXT_DISABLED))
    return palette


def app_icon() -> QIcon:
    """程序内绘制的窗口图标，避免引入二进制资源。"""
    size = 64
    pixmap = QPixmap(size, size)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    painter.setPen(Qt.PenStyle.NoPen)
    painter.setBrush(ink_color())
    painter.drawRoundedRect(QRect(2, 2, size - 4, size - 4), 14, 14)
    font = QFont()
    font.setFamilies(list(FONT_FAMILIES))
    font.setPointSize(24)
    font.setWeight(QFont.Weight.Bold)
    painter.setFont(font)
    painter.setPen(QColor(TEXT_INVERSE))
    painter.drawText(pixmap.rect(), Qt.AlignmentFlag.AlignCenter, "AI")
    painter.end()
    return QIcon(pixmap)


def apply_light_theme(app, style: str = DEFAULT_STYLE) -> None:
    """把应用固定为白色主题（在 QApplication 创建后立即调用）。"""
    app.setStyle("Fusion")
    app.setFont(base_font())
    app.setPalette(light_palette())
    apply_style(app, style)
    app.setWindowIcon(app_icon())
```

- [ ] **Step 7: 运行样式测试确认通过**

Run: `python -m pytest tests/test_theme.py -q`
Expected: PASS（若 `test_style_files_are_grayscale` 失败，按提示的 `#hex` 逐一改回灰阶）

- [ ] **Step 8: 跑全量测试**

Run: `python -m pytest -q`
Expected: 全绿。若有失败，只会是引用了已删除的 `theme.stylesheet()` / `theme.BASE_QSS` 的测试——把它们改成 `theme.load_stylesheet()`（`tests/test_main_window.py` 里引用 `theme.TEXT_MUTED`/`theme.TEXT` 的断言本任务不动，Task 3 处理）。

- [ ] **Step 9: 与基准截图比对，确认外观未变**

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8
python -X utf8 "$env:TEMP\opencode\shot.py" parity-after-task1
```

Expected: 四张 PNG 与 `parity-before` 里的同名文件**肉眼看不出差别**（Task 4 会用像素比对再严格验一次）。

- [ ] **Step 10: 提交**

```powershell
git add -A
git commit -m "refactor(ui): load styles from app/ui/styles/*.qss instead of Python strings"
```

---

### Task 2: 行高 / 网格线 / 斑马纹交给 QSS + 第二套样式 `flat.qss`

**Files:**
- Create: `app/ui/styles/flat.qss`
- Modify: `app/ui/theme.py`（删 `TABLE_ROW_HEIGHT/TABLE_GRID/TABLE_ZEBRA`，加最小高度常量）
- Modify: `app/ui/main_window.py`（`_build_table`、`showEvent`、`_sync_table_min_height`）
- Test: `tests/test_theme.py`

**Interfaces:**
- Consumes: Task 1 的 `theme.apply_style`、`theme.style_path`、`theme.available_styles`
- Produces:
  - `theme.TABLE_MIN_VISIBLE_ROWS = 4`、`theme.TABLE_MIN_HEIGHT_EXTRA = 40`
  - `MainWindow._sync_table_min_height() -> None`（设置界面阶段应用样式后要调它）
  - 表格的垂直表头 `objectName` 为 `"verticalHeader"`

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_theme.py` 末尾：

```python
@pytest.fixture(autouse=True)
def _restore_default_style(qapp):
    """每个用例结束后把应用样式恢复成默认，避免用例之间互相污染。"""
    yield
    theme.apply_style(qapp, theme.DEFAULT_STYLE)


@pytest.fixture
def styled_window(qapp, tmp_path, monkeypatch):
    """按样式建主窗口（不碰真实配置、不后台刷新）。"""
    import copy

    from app.core.config import DEFAULT_CONFIG
    from app.ui import main_window as mw

    made: list = []

    def build(style: str):
        monkeypatch.setattr(mw.MainWindow, "refresh", lambda self: None)
        monkeypatch.setattr(mw, "load_config", lambda: copy.deepcopy(DEFAULT_CONFIG))
        theme.apply_style(qapp, style)
        window = mw.MainWindow(str(tmp_path))
        window.show()
        qapp.processEvents()
        made.append(window)
        return window

    yield build
    for window in made:
        window.close()


def _count_color(image, name: str) -> int:
    from PySide6.QtGui import QColor

    target = QColor(name)
    total = 0
    for y in range(image.height()):
        for x in range(image.width()):
            if image.pixelColor(x, y).name() == target.name():
                total += 1
    return total


def test_available_styles_lists_both_styles(qapp):
    styles = dict(theme.available_styles())

    assert styles["traditional"] == "传统框感"
    assert styles["flat"] == "扁平"
    assert theme.available_styles()[0][0] == theme.DEFAULT_STYLE


def test_style_owns_row_height(styled_window):
    traditional = styled_window("traditional")
    flat = styled_window("flat")

    assert traditional.changes_table.verticalHeader().defaultSectionSize() == 24
    assert flat.changes_table.verticalHeader().defaultSectionSize() == 28


def test_style_owns_grid_and_zebra(styled_window):
    changes = [
        repo_change("a.txt", repo_status.MODIFIED),
        repo_change("b.txt", repo_status.MODIFIED),
    ]

    def counts(style: str) -> tuple[int, int]:
        window = styled_window(style)
        window.show_untracked_check.setChecked(True)
        window._on_changes_loaded(changes, {"a.txt": (2, 1), "b.txt": (1, 1)})
        image = window.changes_table.viewport().grab().toImage()
        return _count_color(image, "#e6e6e6"), _count_color(image, "#f7f7f7")

    grid, zebra = counts("traditional")
    assert grid > 100, "传统样式应该有网格线像素"
    assert zebra > 100, "传统样式应该有斑马纹像素"

    grid, zebra = counts("flat")
    assert grid == 0, "扁平样式不应该有网格线像素"
    assert zebra == 0, "扁平样式不应该有斑马纹像素"


def test_min_table_height_follows_style(styled_window):
    for style, expected_row in (("traditional", 24), ("flat", 28)):
        window = styled_window(style)
        assert window.changes_table.verticalHeader().defaultSectionSize() == expected_row
        assert (
            window.changes_table.minimumHeight()
            == expected_row * theme.TABLE_MIN_VISIBLE_ROWS + theme.TABLE_MIN_HEIGHT_EXTRA
        )
```

在同文件顶部导入区补两个小helper（放在 `_styles()` 旁边）：

```python
from app.core import repo as repo_status


def repo_change(path: str, status: str):
    return repo_status.FileChange(path=path, status=status)
```

- [ ] **Step 2: 运行确认失败**

Run: `python -m pytest tests/test_theme.py -q -k "row_height or grid_and_zebra or min_table_height or lists_both"`
Expected: FAIL — `KeyError: 'flat'`（样式文件还不存在）与 `AttributeError: ... TABLE_MIN_VISIBLE_ROWS`

- [ ] **Step 3: 创建 `app/ui/styles/flat.qss`**

扁平风格：无外框、无网格线、无斑马纹、更宽松。**表格区域不得出现 `#e6e6e6`（网格线测试靠这个断言）**。

```qss
/* 名称: 扁平 */
/*
 * 黑白单色：所有色值必须是灰阶（r == g == b）。
 * 扁平方向：去掉面板边框与斑马纹，靠留白与字重分层次。
 */

* {
    font-family: "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI";
    font-size: 9pt;
}
QWidget { color: #1f1f1f; }

QMainWindow, QDialog, QStatusBar, QMenu, QMessageBox { background: #ffffff; }
QToolTip { background: #ffffff; color: #1f1f1f; border: 1px solid #d9d9d9; }

/* 输入：只留一条底线 */
QLineEdit {
    background: #ffffff;
    border: none;
    border-bottom: 1px solid #d9d9d9;
    border-radius: 0;
    padding: 6px 2px;
    selection-background-color: #ededed;
    selection-color: #1f1f1f;
}
QPlainTextEdit, QTextEdit {
    background: #fafafa;
    border: none;
    border-radius: 0;
    padding: 8px;
    selection-background-color: #ededed;
    selection-color: #1f1f1f;
}
QLineEdit:focus, QPlainTextEdit:focus, QTextEdit:focus { border-bottom: 1px solid #1f1f1f; }

/* 按钮：胶囊形 */
QPushButton {
    background: transparent;
    border: 1px solid #d9d9d9;
    border-radius: 999px;
    padding: 6px 18px;
}
QPushButton:hover { background: #f6f6f6; }
QPushButton:pressed { background: #eeeeee; }
QPushButton:focus { border: 1px solid #1f1f1f; }
QPushButton:disabled { background: transparent; border-color: #e6e6e6; color: #9e9e9e; }
QPushButton#primaryButton {
    background: #1f1f1f;
    border: 1px solid #1f1f1f;
    color: #ffffff;
    font-weight: 600;
}
QPushButton#primaryButton:hover { background: #000000; border-color: #000000; }
QPushButton#primaryButton:disabled { background: #e3e3e3; border-color: #e3e3e3; color: #9e9e9e; }
QPushButton#chip {
    background: transparent;
    border: none;
    border-radius: 999px;
    padding: 2px 10px;
    color: #6b6b6b;
}
QPushButton#chip:hover { background: #f6f6f6; color: #1f1f1f; }
QPushButton#chip:pressed { background: #eeeeee; }

/* 标签 */
QLabel#repoName { font-weight: 600; font-size: 12pt; }
QLabel#repoPath { color: #6b6b6b; font-size: 8pt; }
QLabel#branchChip { background: transparent; border: none; color: #6b6b6b; font-size: 8pt; padding: 0; }
QLabel#sectionLabel { font-weight: 600; }
QLabel#hintLabel { color: #6b6b6b; font-size: 8pt; }
QLabel#emptyState { color: #6b6b6b; font-size: 10pt; }
QLabel#statusLabel { color: #6b6b6b; border: none; padding-top: 8px; }

/* 勾选框：白底 + 明确描边，勾选后近黑填充叠白色对勾 */
QCheckBox { spacing: 8px; }
QCheckBox::indicator, QTableView::indicator {
    width: 15px;
    height: 15px;
    border: 1px solid #6b6b6b;
    border-radius: 3px;
    background: #ffffff;
}
QCheckBox::indicator:hover, QTableView::indicator:hover {
    border: 1px solid #1f1f1f;
    background: #e3e3e3;
}
QCheckBox::indicator:checked, QTableView::indicator:checked {
    background: #1f1f1f;
    border: 1px solid #1f1f1f;
    image: url("icons/check.svg");
}
QCheckBox::indicator:checked:hover, QTableView::indicator:checked:hover {
    background: #000000;
    border: 1px solid #000000;
}

/* 表格：无边框、无网格线、无斑马纹，行高 28 */
QTableWidget, QTableView {
    background: #ffffff;
    alternate-background-color: #ffffff;
    border: none;
    gridline-color: transparent;
}
QTableWidget::item { padding: 0 6px; }
QTableWidget::item:selected { background: #ededed; color: #1f1f1f; }
QHeaderView { background: #ffffff; }
QHeaderView#verticalHeader { qproperty-defaultSectionSize: 28; }
QHeaderView::section {
    background: #ffffff;
    border: none;
    border-bottom: 1px solid #d9d9d9;
    font-weight: 600;
    padding: 8px 6px;
}

/* 下拉框 / 数字框（设置界面用）；弹窗选中色必须显式指定 */
QComboBox, QAbstractSpinBox, QSpinBox {
    background: #ffffff;
    border: 1px solid #d9d9d9;
    border-radius: 999px;
    padding: 4px 10px;
    selection-background-color: #ededed;
    selection-color: #1f1f1f;
}
QComboBox:focus, QAbstractSpinBox:focus, QSpinBox:focus { border: 1px solid #1f1f1f; }
QComboBox::drop-down { border: none; width: 18px; }
QComboBox QAbstractItemView {
    background: #ffffff;
    border: 1px solid #d9d9d9;
    selection-background-color: #ededed;
    selection-color: #1f1f1f;
    outline: none;
}
QAbstractItemView { selection-background-color: #ededed; selection-color: #1f1f1f; }
QMenu::item:selected { background: #ededed; color: #1f1f1f; }

/* 滚动条 */
QScrollBar:vertical { background: transparent; width: 10px; margin: 0; }
QScrollBar::handle:vertical { background: #d9d9d9; border-radius: 5px; min-height: 28px; }
QScrollBar::handle:vertical:hover { background: #c4c4c4; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: transparent; }
QScrollBar:horizontal { background: transparent; height: 10px; margin: 0; }
QScrollBar::handle:horizontal { background: #d9d9d9; border-radius: 5px; min-width: 28px; }
QScrollBar::handle:horizontal:hover { background: #c4c4c4; }
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal { width: 0; }
QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal { background: transparent; }
```

- [ ] **Step 4: 改 `app/ui/theme.py` 的表格常量**

把这一段：

```python
#: 表格的行高与边框策略（样式文件里以 QSS 表达；这里供 Qt API 使用）。
TABLE_ROW_HEIGHT = 24
TABLE_GRID = True
TABLE_ZEBRA = True
```

替换为：

```python
#: 表格最小高度：至少露出这么多整行，再加一点余量，避免最后一行被截成半行。
TABLE_MIN_VISIBLE_ROWS = 4
TABLE_MIN_HEIGHT_EXTRA = 40
```

- [ ] **Step 5: 改 `app/ui/main_window.py`**

(a) `_build_table` 里这两行：

```python
        table.verticalHeader().setVisible(False)
        table.verticalHeader().setDefaultSectionSize(theme.TABLE_ROW_HEIGHT)
```

改为：

```python
        table.verticalHeader().setVisible(False)
        # 样式文件里的 QHeaderView#verticalHeader 命中它（行高由样式决定）。
        table.verticalHeader().setObjectName("verticalHeader")
```

(b) 同函数里：

```python
        table.setAlternatingRowColors(theme.TABLE_ZEBRA)
        table.setShowGrid(theme.TABLE_GRID)
```

改为（永远开着，外观交给样式的 `alternate-background-color` 与 `gridline-color`）：

```python
        table.setAlternatingRowColors(True)
        table.setShowGrid(True)
```

(c) `_build_ui` 里删掉这一行：

```python
        # 至少露出 4 整行，避免默认窗口尺寸下最后一行被截成半行。
        self.changes_table.setMinimumHeight(theme.TABLE_ROW_HEIGHT * 4 + 40)
```

(d) 新增 `showEvent` 与 `_sync_table_min_height`（放在 `resizeEvent` 之前）：

```python
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
```

- [ ] **Step 6: 运行样式测试确认通过**

Run: `python -m pytest tests/test_theme.py -q`
Expected: PASS

- [ ] **Step 7: 跑全量测试**

Run: `python -m pytest -q`
Expected: 全绿（`tests/test_main_window.py` 里没有断言表格最小高度的用例——行高与最小高度的断言都在 `tests/test_theme.py`）

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(ui): move row height, grid and zebra into QSS; add flat style"
```

---

### Task 3: 删掉调色板 / 字体 / 逐项着色，Python 侧零颜色

**Files:**
- Modify: `app/ui/theme.py`（删除令牌、字体、调色板、状态色；`app_icon` 用 `Qt.GlobalColor`）
- Modify: `app/ui/main_window.py`（`_fill_row`、`_set_status`、`_error`、导入）
- Modify: `tests/test_theme.py`、`tests/test_main_window.py`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1/2 的样式文件与装载器
- Produces: `theme.py` 只剩 `STYLES_DIR`/`ICONS_DIR`/`DEFAULT_STYLE`/`CHECK_ICON`/`style_path`/`style_label`/`available_styles`/`load_stylesheet`/`apply_style`/`apply_light_theme`/`app_icon`/`SPACE_*`/`WINDOW_MARGINS`/`LAYOUT_SPACING`/`TABLE_MIN_VISIBLE_ROWS`/`TABLE_MIN_HEIGHT_EXTRA`/`UI_DIR`

- [ ] **Step 1: 写失败测试**

在 `tests/test_theme.py` 末尾追加：

```python
def test_theme_module_has_no_color_literals(qapp):
    """颜色只活在 .qss 里：theme.py 不得出现 #rrggbb。"""
    source = Path(theme.__file__).read_text(encoding="utf-8")

    assert not re.search(r"#[0-9a-fA-F]{6}", source)


def test_window_renders_white(qapp, styled_window):
    window = styled_window("traditional")

    image = window.grab().toImage()
    assert image.pixelColor(5, 5).name() == "#ffffff"


def test_combo_popup_is_monochrome(qapp, styled_window):
    """删掉调色板后，下拉弹窗的选中色必须来自样式，不能漏出 Fusion 蓝。"""
    from PySide6.QtWidgets import QComboBox

    styled_window("traditional")
    combo = QComboBox()
    combo.addItems(["传统框感", "扁平"])
    combo.resize(220, 28)
    combo.show()
    combo.setCurrentIndex(0)
    combo.showPopup()
    qapp.processEvents()

    view = combo.view()
    image = view.grab().toImage()
    saturated = []
    for y in range(image.height()):
        for x in range(image.width()):
            color = image.pixelColor(x, y)
            if max(color.red(), color.green(), color.blue()) - min(
                color.red(), color.green(), color.blue()
            ) > 60:
                saturated.append((x, y, color.name()))
    assert saturated == [], f"弹窗里有彩色像素：{saturated[:5]}"

    rect = view.visualRect(view.model().index(0, 0))
    assert image.pixelColor(rect.right() - 4, rect.center().y()).name() == "#ededed"

    combo.hidePopup()
    combo.close()
```

把 `tests/test_theme.py` 里这些**删除**：`test_light_palette_is_white`、`test_light_palette_disabled_text_is_grey`，以及 `test_tokens_stay_on_scale` 里的三行状态色/字重断言（只保留间距刻度那部分，函数名改为 `test_spaces_stay_on_scale`）。

- [ ] **Step 2: 运行确认失败**

Run: `python -m pytest tests/test_theme.py -q -k "no_color_literals or renders_white or combo_popup"`
Expected: FAIL — `test_theme_module_has_no_color_literals` 失败（`theme.py` 里还有 `#ffffff` 等）；`test_renders_white` 大概率仍通过

- [ ] **Step 3: 改 `app/ui/main_window.py`**

(a) 导入：删掉 `QColor`（此文件再无其它用处）

```python
from PySide6.QtGui import QFontMetrics, QKeySequence, QShortcut
```

(b) `_fill_row` 改为（颜色/字重交给样式表，代码只负责内容与对齐）：

```python
    def _fill_row(self, row: int, change: repo.FileChange, state, checked_default: str) -> None:
        """填一行：首列勾选框 + 路径，数字列右对齐。颜色与字重由样式表决定。"""
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
        suffix_item.setTextAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)

        status_item = QTableWidgetItem(repo.STATUS_TEXT.get(change.status, change.status))
        status_item.setTextAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)

        cells = (
            suffix_item,
            status_item,
            QTableWidgetItem(_stat_text(added) if has_stat else ""),
            QTableWidgetItem(_stat_text(deleted) if has_stat else ""),
        )
        for offset, item in enumerate(cells, start=1):
            if offset in _RIGHT_ALIGNED_COLUMNS:
                item.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            self.changes_table.setItem(row, offset, item)
```

(c) `_set_status` 去掉 `error` 参数与字体切换：

```python
    def _set_status(self, text: str) -> None:
        """状态栏文字。单色方案下不做颜色/字重区分，出错另有错误对话框。"""
        self.status.setText(text)
```

(d) `_error` 的调用相应改为（去掉 `error=True`）：

```python
    def _error(self, message: str) -> None:
        self._set_status(f"错误：{_error_summary(message)}")
        self._build_error_box(message).exec()
```

- [ ] **Step 4: 改 `app/ui/theme.py`**

(a) 删除整段令牌与常量：`RADIUS`、全部颜色令牌（`BACKGROUND`…`INK_SOFT_BORDER`）、`STATUS_COLORS`、`BOLD_STATUSES`、`FONT_FAMILIES`、`FONT_SIZE`、`FONT_SIZE_SMALL`，以及函数 `base_font`、`section_font`、`ink_color`、`status_color`、`status_is_bold`、`light_palette`。保留 `SPACE_*`、`WINDOW_MARGINS`、`LAYOUT_SPACING`、`TABLE_MIN_VISIBLE_ROWS`、`TABLE_MIN_HEIGHT_EXTRA`。

(b) 导入收敛为：

```python
import re
from pathlib import Path

from PySide6.QtCore import QRect, Qt
from PySide6.QtGui import QIcon, QPainter, QPixmap
```

(c) `app_icon()` 用全局色常量（不再引用令牌）：

```python
def app_icon() -> QIcon:
    """程序内绘制的窗口图标，避免引入二进制资源。"""
    size = 64
    pixmap = QPixmap(size, size)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    painter.setPen(Qt.PenStyle.NoPen)
    painter.setBrush(Qt.GlobalColor.black)
    painter.drawRoundedRect(QRect(2, 2, size - 4, size - 4), 14, 14)
    font = QFont()
    font.setFamilies(["Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI"])
    font.setPointSize(24)
    font.setWeight(QFont.Weight.Bold)
    painter.setFont(font)
    painter.setPen(Qt.GlobalColor.white)
    painter.drawText(pixmap.rect(), Qt.AlignmentFlag.AlignCenter, "AI")
    painter.end()
    return QIcon(pixmap)
```

注意：这段用到 `QFont`，导入里要保留它：

```python
from PySide6.QtGui import QFont, QIcon, QPainter, QPixmap
```

(d) `apply_light_theme` 去掉字体与调色板：

```python
def apply_light_theme(app, style: str = DEFAULT_STYLE) -> None:
    """把应用固定为白色主题（在 QApplication 创建后立即调用）。"""
    app.setStyle("Fusion")
    apply_style(app, style)
    app.setWindowIcon(app_icon())
```

(e) 更新模块 docstring 第一段，说明「颜色/字体都在 styles/*.qss，这里只放装载器与窗口图标」。

- [ ] **Step 5: 改 `tests/test_main_window.py`**

(a) `_indicator_box` 的灰度参考改成从样式里读（不再有 `theme.TEXT_MUTED`）：

```python
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
```

(b) `test_numeric_columns_right_aligned_and_status_monochrome` 改名为 `test_numeric_columns_are_right_aligned`，删掉三行颜色断言：

```python
def test_numeric_columns_are_right_aligned(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    window.show_untracked_check.setChecked(True)
    window._on_changes_loaded(_changes_fixture(), {"a.txt": (2, 1)})
    table = window.changes_table

    for column in (3, 4):
        assert table.item(0, column).textAlignment() & int(Qt.AlignmentFlag.AlignRight)
```

- [ ] **Step 6: 改 `README.md`**

第 54 行那句改为：

```
- **黑白单色主题**：固定使用 Fusion 样式 + 浅色调色板（`app/ui/styles/*.qss`），不跟随 Windows 深色模式，系统开深色时界面依然是白底。整套界面只用黑、白与灰阶，不按语义上色（状态列不做逐项着色，「未版本控制」「已冲突」都靠文字本身分辨）。
```

第 60 行那句改为：

```
- 界面样式全是真实文件：`app/ui/styles/` 下每份 `.qss` 就是一套样式（`traditional.qss` 默认、`flat.qss` 扁平），往里丢新文件即可被程序发现；间距刻度仍集中在 `app/ui/theme.py`，颜色只写在 `.qss` 里。
```

- [ ] **Step 7: 运行确认通过**

Run: `python -m pytest -q`
Expected: 全绿

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "refactor(ui): drop palette, fonts and per-item colors; colors live only in QSS"
```

---

### Task 4: 外观验收（像素比对）+ 冒烟 + 台账

**Files:**
- Modify: `.superpowers/sdd/progress.md`（追加台账）

**Interfaces:**
- Consumes: Task 1 的 `parity-before` 截图、全部样式文件
- Produces: 验收结论（无代码接口）

- [ ] **Step 1: 重新出四状态截图**

```powershell
$env:PYTHONIOENCODING='utf-8'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8
python -X utf8 "$env:TEMP\opencode\shot.py" parity-after
```

Expected: 打印 4 行摘要，输出到 `%TEMP%\parity-after\`。

- [ ] **Step 2: 像素比对（只允许已确认的 5 处差异）**

写 `%TEMP%\opencode\parity.py`：

```python
"""逐像素比对两批截图，报告差异数量与最密的横条位置（只用 PySide6，不依赖 numpy）。"""

import sys
from pathlib import Path

import app  # noqa: F401  (side effect: Windows DLL 目录)
from PySide6.QtGui import QImage


def load(path: Path) -> QImage:
    image = QImage(str(path)).convertToFormat(QImage.Format.Format_RGB32)
    assert not image.isNull(), f"读不到 {path}"
    return image


def main(before_dir: str, after_dir: str) -> int:
    before = Path(before_dir)
    after = Path(after_dir)
    total_diff = 0
    for name in sorted(path.name for path in before.glob("*.png")):
        image_a = load(before / name)
        image_b = load(after / name)
        assert (image_a.width(), image_a.height()) == (image_b.width(), image_b.height()), name
        stride = image_a.bytesPerLine()
        raw_a = bytes(image_a.constBits())
        raw_b = bytes(image_b.constBits())
        diff = 0
        bands: dict[int, int] = {}
        for y in range(image_a.height()):
            line_a = raw_a[y * stride : (y + 1) * stride]
            line_b = raw_b[y * stride : (y + 1) * stride]
            if line_a == line_b:
                continue
            count = sum(
                1 for x in range(0, len(line_a), 4) if line_a[x : x + 4] != line_b[x : x + 4]
            )
            diff += count
            bands[y // 20 * 20] = bands.get(y // 20 * 20, 0) + count
        total_diff += diff
        top = sorted(bands.items(), key=lambda kv: -kv[1])[:6]
        print(f"{name}: 差异像素={diff} 最密横条(y, 数量)={top}", flush=True)
    print(f"合计差异像素={total_diff}", flush=True)
    return 0


if __name__ == "__main__":
    import os

    code = main(sys.argv[1], sys.argv[2])
    sys.stdout.flush()
    os._exit(code)
```

Run:

```powershell
python -X utf8 "$env:TEMP\opencode\parity.py" "$env:TEMP\parity-before" "$env:TEMP\parity-after"
```

Expected（逐张判定，不要只看总数）：

| 截图 | 期望 |
|---|---|
| `empty`（干净仓库空状态） | **0 差异**（空状态与状态栏文字都没动过） |
| `unchecked` | 差异只出现在扩展名列与两个数字列的灰字像素上（这几列文字本来会被丢弃灰度） |
| `main` / `ready` | 差异只出现在扩展名列、数字列的灰字像素，以及（若 fixture 里有未跟踪行）未跟踪行的状态列灰字 |

**不允许**出现窗口底色、状态栏底色、表头、表格边框、行高、滚动条、勾选框的任何差异——出现任何一条都说明 Task 1/2 的 `.qss` 漏写了对应规则（先补规则再重跑本步），不要用「大概差不多」放过。

- [ ] **Step 3: 真机冒烟**

```powershell
$env:PYTHONIOENCODING='utf-8'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$repo = Join-Path $env:TEMP "smoke9_$(Get-Random)"
New-Item -ItemType Directory -Path $repo -Force | Out-Null
git -C $repo init -q -b main; git -C $repo config user.name t; git -C $repo config user.email t@e.com
Set-Content -LiteralPath (Join-Path $repo 'a.txt') -Value 'x' -Encoding utf8
git -C $repo add -A; git -C $repo commit -qm init
Set-Content -LiteralPath (Join-Path $repo 'a.txt') -Value 'xy' -Encoding utf8
Set-Content -LiteralPath (Join-Path $repo '新文件.txt') -Value 'n' -Encoding utf8
$p = Start-Process -FilePath python -ArgumentList @('app\main.py', $repo) -PassThru -RedirectStandardError (Join-Path $repo 'err.txt')
Start-Sleep -Seconds 8
if (-not $p.HasExited) { Write-Output "窗口正常打开"; $p.Kill(); $p.WaitForExit() } else { Write-Output "提前退出 code=$($p.ExitCode)" }
$err = Get-Content (Join-Path $repo 'err.txt') -Raw -ErrorAction SilentlyContinue
Write-Output "stderr: $(if ($err) { $err } else { '(空)' })"
Remove-Item -Recurse -Force $repo -ErrorAction SilentlyContinue
Write-Output "残留 python 进程: $((Get-Process python -ErrorAction SilentlyContinue | Measure-Object).Count)"
```

Expected: `窗口正常打开`、`stderr: (空)`、`残留 python 进程: 0`

- [ ] **Step 4: 用 flat 样式启动一次，确认样式真的能换**

写 `%TEMP%\opencode\style_switch.py`（**必须写文件并 `os._exit(0)` 收尾**：内联 `python -c` 在创建 QApplication 后可能挂死或崩溃）：

```python
"""非 offscreen 启动，确认两套样式都能装上去。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(r"D:\wlr\ai\git-ai-commit")))

import app  # noqa: E402,F401
from PySide6.QtWidgets import QApplication  # noqa: E402

from app.ui import theme  # noqa: E402


def main() -> int:
    window_app = QApplication([])
    print("样式列表:", theme.available_styles(), flush=True)
    for key, label in theme.available_styles():
        theme.apply_light_theme(window_app, key)
        length = len(window_app.styleSheet())
        print(f"{key}({label}): 样式表长度={length}", flush=True)
        assert length > 0, f"{key} 的样式表是空的"
    print("两套样式都能应用", flush=True)
    return 0


if __name__ == "__main__":
    import os

    code = main()
    sys.stdout.flush()
    os._exit(code)
```

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8
python -X utf8 "$env:TEMP\opencode\style_switch.py"
```

Expected: 打印 `样式列表: [('traditional', '传统框感'), ('flat', '扁平')]` 与两行非零长度，最后 `两套样式都能应用`，退出码 0

- [ ] **Step 5: 追加台账**

`.superpowers/` 整个目录是 gitignore 的临时区（`.superpowers/.gitignore` 里是 `*`），**不要提交**（`git add -A` 会把它排除掉，强行提交只会得到空提交）。直接追加即可。

在 `.superpowers/sdd/progress.md` 末尾追加：

```
CHANGE (spec 2026-09-17-styles-as-files): 样式从 Python f-string 外置为 app/ui/styles/*.qss。
- theme.py 变成装载器（load_stylesheet/apply_style/available_styles）+ 间距刻度 + 窗口图标；删除 BASE_QSS/DIRECTION_QSS、调色板、字体、颜色令牌、逐项状态着色。
- 实测把行高(qproperty-defaultSectionSize)、网格线(gridline-color)、斑马纹(alternate-background-color)交给 QSS；QHeaderView 选择器会误伤水平表头，改用 objectName=verticalHeader 精确命中。
- 新增第二套样式 flat.qss 以证明样式可切换；勾选图标移到 styles/icons/ 供 url() 相对引用。
- 5 处视觉区分按用户决定放弃（扩展名列/数字列/未跟踪行灰字、冲突加粗、状态栏出错加粗）。
- 验收：四状态截图与改动前逐像素比对仅剩上述 5 处差异；真机冒烟无 stderr 无残留进程。
```

追加完即可，本步骤不产生提交（台账是临时区）。

---

## 自审记录

**Spec 覆盖检查**

| Spec 章节 | 落到的任务 |
|---|---|
| §3 目标结构（styles/、icons 迁移） | Task 1 Step 4/5 |
| §4.1 通用约定（字面值、灰阶、相对 url） | Task 1 Step 4/6、Task 3 Step 1（灰阶与 `#hex` 测试） |
| §4.2 traditional.qss 必备规则（含新增 QComboBox/QSpinBox/弹窗选中色） | Task 1 Step 4 |
| §4.3 flat.qss 差异 | Task 2 Step 3/1（行高/网格/斑马断言） |
| §5 theme.py 新接口与删除清单 | Task 1 Step 6、Task 3 Step 4 |
| §6 main_window 连带改动（表格开关、objectName、最小高度、`_fill_row`、`_set_status`） | Task 2 Step 5、Task 3 Step 3 |
| §7 五处视觉变化 | Task 3 Step 3、Task 4 Step 2（只允许这 5 处差异） |
| §8.1 测试清单 | Task 1 Step 2、Task 2 Step 1、Task 3 Step 1/5 |
| §8.2 `_indicator_box` 改读样式 | Task 3 Step 5 |
| §8.3 手工验收（截图比对、样式可枚举） | Task 4 Step 1/2/4 |
| §9 错误处理（回退、坏文件、缺样式目录） | Task 1 Step 2（3 个回退测试） |
| §10 验收标准（theme.py 无颜色、无占位符、无未解析 url） | Task 3 Step 1、Task 1 Step 2 |

**类型/命名一致性**：`load_stylesheet(style=None)`、`apply_style(app, style)`、`available_styles() -> list[tuple[str, str]]`、`style_path(style) -> Path`、`style_label(path) -> str`、`CHECK_ICON`、`TABLE_MIN_VISIBLE_ROWS`、`TABLE_MIN_HEIGHT_EXTRA`、`MainWindow._sync_table_min_height()`、垂直表头 `objectName = "verticalHeader"` —— 在各任务中引用一致。

**占位符扫描**：无 TBD/TODO；每个代码步骤都给了完整内容（两份 `.qss`、`theme.py` 全文、`_fill_row` 全文、测试全文）。
