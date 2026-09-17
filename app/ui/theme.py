"""统一的白色（浅色）主题。

Windows 11 的默认样式会跟随系统深色模式，系统一开深色，窗口就会变成黑底。
这里显式固定 Fusion 样式 + 浅色调色板 + 少量 QSS，保证界面始终是白色主题。
"""

from PySide6.QtGui import QColor, QPalette

WINDOW = "#ffffff"
BASE = "#ffffff"
ALTERNATE = "#f4f6f8"
TEXT = "#1f2328"
DISABLED_TEXT = "#9aa0a6"
BORDER = "#d0d7de"
GRID = "#e6e9ed"
HEADER_BG = "#f2f4f7"
BUTTON_BG = "#f6f7f8"
BUTTON_HOVER = "#eef1f4"
BUTTON_PRESSED = "#e3e7eb"
SELECTION_BG = "#dbe9ff"
HIGHLIGHT = "#2f6fdd"
LINK = "#0a66c2"

LIGHT_QSS = f"""
QLineEdit, QPlainTextEdit, QTextEdit {{
    background: {BASE};
    color: {TEXT};
    border: 1px solid {BORDER};
    border-radius: 4px;
    padding: 3px 4px;
    selection-background-color: {SELECTION_BG};
    selection-color: {TEXT};
}}
QPushButton {{
    background: {BUTTON_BG};
    color: {TEXT};
    border: 1px solid {BORDER};
    border-radius: 4px;
    padding: 5px 14px;
}}
QPushButton:hover {{ background: {BUTTON_HOVER}; }}
QPushButton:pressed {{ background: {BUTTON_PRESSED}; }}
QPushButton:disabled {{ background: #fafbfc; color: {DISABLED_TEXT}; }}
QTableWidget {{
    background: {BASE};
    alternate-background-color: {ALTERNATE};
    color: {TEXT};
    gridline-color: {GRID};
    border: 1px solid {BORDER};
    selection-background-color: {SELECTION_BG};
    selection-color: {TEXT};
}}
QHeaderView::section {{
    background: {HEADER_BG};
    color: {TEXT};
    border: none;
    border-right: 1px solid {GRID};
    border-bottom: 1px solid {BORDER};
    padding: 4px 6px;
}}
QStatusBar {{ background: {WINDOW}; color: {TEXT}; }}
QCheckBox, QLabel, QGroupBox {{ color: {TEXT}; }}
"""


def light_palette() -> QPalette:
    """白色主题调色板（Fusion 样式下对全部控件生效）。"""
    palette = QPalette()
    for role, value in (
        (QPalette.ColorRole.Window, WINDOW),
        (QPalette.ColorRole.WindowText, TEXT),
        (QPalette.ColorRole.Base, BASE),
        (QPalette.ColorRole.AlternateBase, ALTERNATE),
        (QPalette.ColorRole.Text, TEXT),
        (QPalette.ColorRole.Button, BUTTON_BG),
        (QPalette.ColorRole.ButtonText, TEXT),
        (QPalette.ColorRole.BrightText, "#ffffff"),
        (QPalette.ColorRole.Highlight, HIGHLIGHT),
        (QPalette.ColorRole.HighlightedText, "#ffffff"),
        (QPalette.ColorRole.Link, LINK),
        (QPalette.ColorRole.LinkVisited, LINK),
        (QPalette.ColorRole.ToolTipBase, "#ffffff"),
        (QPalette.ColorRole.ToolTipText, TEXT),
        (QPalette.ColorRole.PlaceholderText, DISABLED_TEXT),
    ):
        palette.setColor(role, QColor(value))

    for role in (
        QPalette.ColorRole.WindowText,
        QPalette.ColorRole.Text,
        QPalette.ColorRole.ButtonText,
    ):
        palette.setColor(QPalette.ColorGroup.Disabled, role, QColor(DISABLED_TEXT))
    return palette


def apply_light_theme(app) -> None:
    """把应用固定为白色主题（在 QApplication 创建后立即调用）。"""
    app.setStyle("Fusion")
    app.setPalette(light_palette())
    app.setStyleSheet(LIGHT_QSS)
