"""白色主题：设计令牌、字体、调色板与 QSS。

- Windows 11 的默认样式会跟随系统深色模式；这里固定 Fusion + 浅色调色板，
  保证界面始终是白色主题。
- 间距只使用 :data:`SPACE_*` 刻度，圆角只用 :data:`RADIUS`，颜色只用本模块的令牌，
  避免界面各处出现一次性数值。
- 方向专属的样式（表格与面板的视觉世界）放在 :data:`DIRECTION_QSS`，
  美化分支只替换这一段即可。
"""

from PySide6.QtCore import QRect, Qt
from PySide6.QtGui import QColor, QFont, QIcon, QPainter, QPalette, QPixmap

# --- 设计令牌 ----------------------------------------------------------------

#: 间距刻度，全部为 4 的倍数。
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

#: 表格的行高与边框策略（方向分支会覆盖）。
TABLE_ROW_HEIGHT = 24
TABLE_GRID = True
TABLE_ZEBRA = True

#: 方向专属 QSS。方向 B「传统框感」：保留面板边框与斑马纹，表头填充成条，
#: 行更矮更密，接近 TortoiseGit「检查修改」那种密集列表。
DIRECTION_QSS = f"""
QPlainTextEdit, QTextEdit {{
    background: {BACKGROUND};
    border: 1px solid {BORDER_STRONG};
    border-radius: 4px;
    padding: {SPACE_XS}px {SPACE_SM}px;
}}
QPlainTextEdit:focus, QTextEdit:focus {{ border: 1px solid {INK}; }}
QTableWidget {{
    background: {BACKGROUND};
    alternate-background-color: {ZEBRA};
    border: 1px solid {BORDER_STRONG};
    border-radius: 4px;
    gridline-color: {GRID};
}}
QTableWidget::item {{ padding: 0 {SPACE_XS}px; }}
QTableWidget::item:selected {{ background: {INK_SOFT}; color: {TEXT}; }}
QHeaderView {{ background: {HEADER_BG}; }}
QHeaderView::section {{
    background: {HEADER_BG};
    border: none;
    border-right: 1px solid {GRID};
    border-bottom: 1px solid {BORDER_STRONG};
    font-weight: 600;
    padding: {SPACE_XS}px {SPACE_XS}px;
}}
QTableCornerButton::section {{
    background: {HEADER_BG};
    border: none;
    border-bottom: 1px solid {BORDER_STRONG};
}}
"""


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


BASE_QSS = f"""
QWidget {{
    color: {TEXT};
}}
QPlainTextEdit, QTextEdit, QLineEdit {{
    background: {BACKGROUND};
    border: 1px solid {BORDER};
    border-radius: {RADIUS}px;
    padding: {SPACE_SM}px;
    selection-background-color: {INK_SOFT};
    selection-color: {TEXT};
}}
QPlainTextEdit:focus, QTextEdit:focus, QLineEdit:focus {{
    border: 1px solid {INK};
}}
QPushButton {{
    background: {SURFACE};
    border: 1px solid {BORDER_STRONG};
    border-radius: {RADIUS}px;
    padding: 6px 16px;
}}
QPushButton:hover {{ background: {SURFACE_HOVER}; }}
QPushButton:pressed {{ background: {SURFACE_PRESSED}; }}
QPushButton:focus {{ border: 1px solid {INK}; }}
QPushButton:disabled {{
    background: {SURFACE_DISABLED};
    border-color: {GRID};
    color: {TEXT_DISABLED};
}}
QPushButton#primaryButton {{
    background: {INK};
    border: 1px solid {INK};
    color: {TEXT_INVERSE};
    font-weight: 600;
}}
QPushButton#primaryButton:hover {{ background: {INK_HOVER}; border-color: {INK_HOVER}; }}
QPushButton#primaryButton:pressed {{ background: {INK_PRESSED}; }}
QPushButton#primaryButton:disabled {{
    background: {SURFACE_PRESSED};
    border-color: {BORDER};
    color: {TEXT_DISABLED};
}}
QPushButton#chip {{
    background: transparent;
    border: 1px solid transparent;
    border-radius: 10px;
    padding: 2px 10px;
    color: {INK};
}}
QPushButton#chip:hover {{
    background: {INK_SOFT};
    border-color: {INK_SOFT_BORDER};
}}
QPushButton#chip:pressed {{ background: {INK_SOFT_BORDER}; }}
QLabel#repoName {{
    font-weight: 600;
    font-size: 11pt;
}}
QLabel#repoPath {{
    color: {TEXT_MUTED};
    font-size: {FONT_SIZE_SMALL}pt;
}}
QLabel#branchChip {{
    background: {INK_SOFT};
    border: 1px solid {INK_SOFT_BORDER};
    border-radius: 9px;
    color: {INK_PRESSED};
    font-size: {FONT_SIZE_SMALL}pt;
    padding: 1px 10px;
}}
QLabel#sectionLabel {{
    font-weight: 600;
}}
QLabel#hintLabel {{
    color: {TEXT_MUTED};
    font-size: {FONT_SIZE_SMALL}pt;
}}
QLabel#emptyState {{
    color: {TEXT_MUTED};
    font-size: 10pt;
}}
QLabel#statusLabel {{
    color: {TEXT_MUTED};
    border-top: 1px solid {GRID};
    padding-top: {SPACE_SM}px;
}}
QCheckBox {{ spacing: {SPACE_SM}px; }}
QCheckBox::indicator {{ width: 15px; height: 15px; }}
QScrollBar:vertical {{ background: transparent; width: 12px; margin: 0; }}
QScrollBar::handle:vertical {{
    background: {BORDER};
    border-radius: 6px;
    min-height: 28px;
}}
QScrollBar::handle:vertical:hover {{ background: {BORDER_STRONG}; }}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{ background: transparent; }}
QScrollBar:horizontal {{ background: transparent; height: 12px; margin: 0; }}
QScrollBar::handle:horizontal {{
    background: {BORDER};
    border-radius: 6px;
    min-width: 28px;
}}
QScrollBar::handle:horizontal:hover {{ background: {BORDER_STRONG}; }}
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {{ width: 0; }}
QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal {{ background: transparent; }}
"""


def stylesheet() -> str:
    """基础 QSS + 方向专属 QSS。"""
    return BASE_QSS + DIRECTION_QSS


def apply_light_theme(app) -> None:
    """把应用固定为白色主题（在 QApplication 创建后立即调用）。"""
    app.setStyle("Fusion")
    app.setFont(base_font())
    app.setPalette(light_palette())
    app.setStyleSheet(stylesheet())
    app.setWindowIcon(app_icon())
