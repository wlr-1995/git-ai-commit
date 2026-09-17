"""白色单色主题测试：调色板、样式表与令牌必须是浅色且只有灰阶。"""

import re

import pytest
from PySide6.QtGui import QColor, QPalette
from PySide6.QtWidgets import QApplication

from app.ui import theme


@pytest.fixture(scope="module")
def qapp():
    return QApplication.instance() or QApplication([])


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


def test_apply_light_theme_forces_light_colors(qapp):
    original_qss = qapp.styleSheet()
    original_palette = qapp.palette()
    original_font = qapp.font()
    try:
        theme.apply_light_theme(qapp)

        assert qapp.styleSheet() == theme.stylesheet()
        assert qapp.palette().color(QPalette.ColorRole.Base).name() == "#ffffff"
        assert qapp.palette().color(QPalette.ColorRole.Window).lightness() > 200
        assert qapp.font().families()[0] == "Microsoft YaHei UI"
    finally:
        qapp.setStyleSheet(original_qss)
        qapp.setPalette(original_palette)
        qapp.setFont(original_font)


def test_light_qss_targets_white(qapp):
    qss = theme.stylesheet()

    assert qss.strip()
    assert "background: #ffffff" in qss
    assert "QPushButton#primaryButton" in qss


def test_every_color_is_grayscale(qapp):
    """用户要求「黑白两色」：所有令牌与 QSS 里的颜色都必须落在灰阶上。"""
    values = set(re.findall(r"#[0-9a-fA-F]{6}", theme.stylesheet()))
    values |= {
        theme.BACKGROUND,
        theme.SURFACE,
        theme.SURFACE_HOVER,
        theme.SURFACE_PRESSED,
        theme.SURFACE_DISABLED,
        theme.BORDER,
        theme.BORDER_STRONG,
        theme.GRID,
        theme.HEADER_BG,
        theme.ZEBRA,
        theme.TEXT,
        theme.TEXT_MUTED,
        theme.TEXT_DISABLED,
        theme.TEXT_INVERSE,
        theme.INK,
        theme.INK_HOVER,
        theme.INK_PRESSED,
        theme.INK_SOFT,
        theme.INK_SOFT_BORDER,
        *theme.STATUS_COLORS.values(),
    }

    assert len(values) > 10
    for value in sorted(values):
        color = QColor(value)
        assert color.red() == color.green() == color.blue(), f"{value} 不是灰阶"


def test_tokens_stay_on_scale(qapp):
    """间距刻度必须成体系，避免界面出现一次性数值。"""
    spaces = (theme.SPACE_XS, theme.SPACE_SM, theme.SPACE_MD, theme.SPACE_LG, theme.SPACE_XL)

    assert spaces == tuple(sorted(spaces))
    assert all(value % 4 == 0 for value in spaces)
    assert theme.status_color("modified").name() == theme.TEXT
    assert theme.status_color("untracked").name() == theme.TEXT_MUTED
    assert theme.status_color("unknown-status").name() == theme.TEXT
    # 需要立刻处理的状态靠字重，不靠颜色
    assert theme.status_is_bold("conflicted") is True
    assert theme.status_is_bold("modified") is False


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
