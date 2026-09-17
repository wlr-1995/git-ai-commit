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
