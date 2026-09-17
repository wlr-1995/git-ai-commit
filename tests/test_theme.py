"""白色主题测试：调色板与样式表必须始终是浅色。"""

import pytest
from PySide6.QtGui import QPalette
from PySide6.QtWidgets import QApplication

from app.ui import theme


@pytest.fixture(scope="module")
def qapp():
    return QApplication.instance() or QApplication([])


def test_light_palette_is_white(qapp):
    palette = theme.light_palette()

    assert palette.color(QPalette.ColorRole.Window).name() == "#ffffff"
    assert palette.color(QPalette.ColorRole.Base).name() == "#ffffff"
    assert palette.color(QPalette.ColorRole.WindowText).name() == "#1f2328"
    assert palette.color(QPalette.ColorRole.Text).lightness() < 80
    assert palette.color(QPalette.ColorRole.Button).lightness() > 200


def test_light_palette_disabled_text_is_grey(qapp):
    palette = theme.light_palette()
    disabled = palette.color(QPalette.ColorGroup.Disabled, QPalette.ColorRole.ButtonText)

    assert disabled.name() == "#9aa0a6"


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
    assert "#000000" not in qss
    assert "QPushButton#primaryButton" in qss


def test_tokens_stay_on_scale(qapp):
    """间距刻度必须成体系，避免界面出现一次性数值。"""
    spaces = (theme.SPACE_XS, theme.SPACE_SM, theme.SPACE_MD, theme.SPACE_LG, theme.SPACE_XL)

    assert spaces == tuple(sorted(spaces))
    assert all(value % 4 == 0 for value in spaces)
    assert theme.status_color("added").name() == theme.SUCCESS
    assert theme.status_color("deleted").name() == theme.DANGER
    assert theme.status_color("unknown-status").name() == theme.TEXT


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
