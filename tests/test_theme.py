import re
from pathlib import Path

import pytest
from PySide6.QtWidgets import QApplication

from app.core import repo as repo_status
from app.ui import theme


@pytest.fixture(scope="module")
def qapp():
    return QApplication.instance() or QApplication([])


def _styles() -> list[tuple[str, Path]]:
    return [(key, theme.style_path(key)) for key, _label in theme.available_styles()]


def repo_change(path: str, status: str):
    return repo_status.FileChange(path=path, status=status)


def test_style_files_are_grayscale(qapp):
    """只允许黑白灰：每个 .qss 里的色值都必须落在灰阶上。"""
    files = _styles()
    assert files, "styles 目录里没有任何样式"
    for key, path in files:
        hexes = re.findall(r"#((?:[0-9a-fA-F]{3}){1,2})\b", path.read_text(encoding="utf-8"))
        assert hexes, f"{key}.qss 里没有任何色值"
        for value in hexes:
            full = "".join(ch * 2 for ch in value) if len(value) == 3 else value
            red, green, blue = (int(full[i : i + 2], 16) for i in (0, 2, 4))
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
        assert qapp.styleSheet() == theme.load_stylesheet(theme.DEFAULT_STYLE)
        assert not qapp.windowIcon().isNull()

        qapp.setStyleSheet("")
        assert qapp.style().objectName() == "fusion"
    finally:
        qapp.setStyleSheet(original_qss)


def test_checkbox_indicator_is_explicitly_drawn(qapp):
    """Fusion 自绘的勾选框在白底上几乎看不见，必须由样式显式画出来。"""
    qss = theme.load_stylesheet()

    assert f'url("{theme.CHECK_ICON}")' in qss
    for selector in ("QCheckBox::indicator", "QTableView::indicator"):
        assert selector in qss
    assert "QCheckBox::indicator:checked" in qss


def test_light_qss_targets_white(qapp):
    qss = theme.load_stylesheet()

    assert qss.strip()
    assert "background: #ffffff" in qss
    assert "QPushButton#primaryButton" in qss


def test_spaces_stay_on_scale(qapp):
    spaces = (theme.SPACE_XS, theme.SPACE_SM, theme.SPACE_MD, theme.SPACE_LG, theme.SPACE_XL)

    assert spaces == tuple(sorted(spaces))
    assert all(value % 4 == 0 for value in spaces)


def test_main_applies_light_theme(monkeypatch):
    """入口必须在建窗口前套用配置里的样式，否则系统深色模式下会变黑底。"""
    import app.core.config as config_module
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
        theme,
        "apply_light_theme",
        lambda app, style=None: events.append(("theme", style)),
    )
    monkeypatch.setattr(config_module, "load_config", lambda: {"ui": {"style": "flat"}})
    monkeypatch.setattr(repo_module, "find_repo_root", lambda start: "R")
    monkeypatch.setattr(mw_module, "MainWindow", FakeWindow)

    assert main_module.main(["prog", "somewhere"]) == 0
    assert events == ["app-created", ("theme", "flat"), ("window", "R"), "shown"]


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
    """行高由样式文件决定；样式表是全应用级的，装新样式会把已建窗口一起重新 polish，
    所以建一套、断言一套，不能建完两套再回头读第一套。"""
    traditional = styled_window("traditional")
    assert traditional.changes_table.verticalHeader().defaultSectionSize() == 24

    flat = styled_window("flat")
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
        assert window.changes_table.rowCount() == len(changes), "表格没有渲染出已加载的行"
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


def test_theme_module_has_no_color_literals(qapp):
    """颜色只活在 .qss 里：theme.py 不得出现 #rrggbb。"""
    source = Path(theme.__file__).read_text(encoding="utf-8")

    assert not re.search(r"#[0-9a-fA-F]{6}", source)


def test_window_renders_white(qapp, styled_window):
    window = styled_window("traditional")

    image = window.grab().toImage()
    assert image.pixelColor(5, 5).name() == "#ffffff"

    viewport = window.message_edit.viewport()
    inside = viewport.mapTo(window, viewport.rect().center())
    assert image.pixelColor(inside).name() == "#ffffff"


def test_combo_popup_is_monochrome(qapp, styled_window):
    """验证样式规则确实生效：下拉弹窗选中行渲染成样式里的灰色 #ededed，
    而不是未套样式时的系统高亮色。"""
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
    # offscreen 下弹窗不按内容宽度调整，visualRect 可能比抓到的图像宽，取样点夹回图内。
    sample_x = min(rect.right(), image.width() - 1) - 4
    assert image.pixelColor(sample_x, rect.center().y()).name() == "#ededed"

    combo.hidePopup()
    combo.close()
