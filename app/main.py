"""入口：从资源管理器右键传入目录，定位仓库并打开窗口。"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# 直接以脚本方式运行 `python app\main.py` 时不会触发 `app/__init__.py`，
# 必须在导入 PySide6 之前先修正 Windows DLL 搜索路径（conda 的 ICU 冲突）。
import app  # noqa: E402,F401  （导入副作用：app/bootstrap.py 修正 DLL 目录）


def resolve_start_path(argv: list[str]) -> str:
    """取第一个非选项参数作为起始路径，否则用当前目录。"""
    for arg in argv[1:]:
        if not arg.startswith("-"):
            return arg
    return str(Path.cwd())


def show_fatal(message: str) -> None:
    """尽力弹出致命错误对话框；无图形环境时静默，避免二次异常。"""
    try:
        from PySide6.QtWidgets import QApplication, QMessageBox

        QApplication.instance() or QApplication([])
        QMessageBox.critical(None, "AI 提交 启动失败", message)
    except Exception:  # noqa: BLE001 - 兜底：报错路径本身不应再抛异常
        pass


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv if argv is None else argv)
    start = resolve_start_path(argv)
    # pythonw 下没有控制台，任何启动异常都必须弹窗，否则右键菜单会「毫无反应」。
    try:
        from PySide6.QtWidgets import QApplication, QMessageBox

        from app.core.config import load_config
        from app.core.repo import find_repo_root
        from app.ui.main_window import MainWindow
        from app.ui.theme import DEFAULT_STYLE, apply_light_theme

        app = QApplication(argv)
        # 先按配置里的样式套主题，避免先画一帧默认样式再切换。
        config = load_config()
        apply_light_theme(app, config.get("ui", {}).get("style") or DEFAULT_STYLE)
        root = find_repo_root(start)
        if root is None:
            QMessageBox.critical(None, "AI 提交", f"该目录不是 Git 仓库：\n{start}")
            return 1

        window = MainWindow(root)
        window.show()
        return app.exec()
    except Exception as exc:  # noqa: BLE001 - 见上：无控制台必须弹窗
        show_fatal(f"{type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
