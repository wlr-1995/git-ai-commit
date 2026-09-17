"""测试环境修正。

1. 在 Windows 上优先使用系统 ICU（逻辑在 ``app.bootstrap``，导入 ``app`` 即生效）。
2. 界面测试统一套用真实主题：勾选框的尺寸与位置来自 QSS，不套主题量到的
   不是用户看到的界面（曾因此写出「量到文字当勾选框」的假失败测试）。
"""

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import app  # noqa: F401  (side effect: ensure_windows_dll_dirs)


def pytest_sessionstart(session) -> None:
    """整个测试会话共用一个套好主题的 QApplication。"""
    try:
        from PySide6.QtWidgets import QApplication
    except ImportError:  # 没装 PySide6 时相关测试会被 importorskip 跳过
        return

    from app.ui.theme import apply_light_theme

    instance = QApplication.instance() or QApplication([])
    apply_light_theme(instance)
