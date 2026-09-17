"""白色主题：颜色/字体都在 ``styles/*.qss``，这里只放装载器与窗口图标。

- 样式是真实文件：``app/ui/styles/*.qss``，一份文件一套样式，目录扫描即可发现。
- 样式文件里直接写颜色与尺寸字面值，``url("...")`` 用相对本文件的路径。
- Windows 11 默认样式会跟随系统深色模式；这里固定 Fusion，保证界面始终是白底。
"""

import re
from pathlib import Path

from PySide6.QtCore import QRect, Qt
from PySide6.QtGui import QFont, QIcon, QPainter, QPixmap

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

#: 主窗口内容边距与区块间距（方向 B：传统 → 更紧凑）。
WINDOW_MARGINS = (SPACE_MD, SPACE_SM, SPACE_MD, SPACE_XS)
LAYOUT_SPACING = SPACE_SM

#: 表格最小高度：至少露出这么多整行，再加一点余量，避免最后一行被截成半行。
TABLE_MIN_VISIBLE_ROWS = 4
TABLE_MIN_HEIGHT_EXTRA = 40


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


def apply_light_theme(app, style: str = DEFAULT_STYLE) -> None:
    """把应用固定为白色主题（在 QApplication 创建后立即调用）。"""
    app.setStyle("Fusion")
    apply_style(app, style)
    app.setWindowIcon(app_icon())
