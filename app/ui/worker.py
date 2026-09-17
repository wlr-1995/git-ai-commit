"""QThread 工作线程：把耗时调用挪出 UI 主线程。"""

from PySide6.QtCore import QThread, Signal


class FunctionWorker(QThread):
    """在后台线程执行一个函数，通过信号回传结果。"""

    succeeded = Signal(object)
    failed = Signal(str)

    def __init__(self, fn, *args, **kwargs):
        super().__init__()
        self._fn = fn
        self._args = args
        self._kwargs = kwargs
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    def is_cancelled(self) -> bool:
        return self._cancelled

    def run(self) -> None:
        try:
            result = self._fn(*self._args, **self._kwargs)
        except Exception as exc:  # noqa: BLE001 - 需要把任意异常回传给 UI
            if not self._cancelled:
                self.failed.emit(str(exc))
            return
        if not self._cancelled:
            self.succeeded.emit(result)
