import pytest

pytest.importorskip("PySide6")

from app.ui.worker import FunctionWorker


def test_worker_emits_success():
    received = []
    worker = FunctionWorker(lambda: 42)
    worker.succeeded.connect(received.append)
    worker.run()
    assert received == [42]


def test_worker_emits_failure_message():
    errors = []

    def boom():
        raise ValueError("炸了")

    worker = FunctionWorker(boom)
    worker.failed.connect(errors.append)
    worker.run()
    assert errors == ["炸了"]


def test_worker_cancel_suppresses_signals():
    received = []
    worker = FunctionWorker(lambda: "done")
    worker.cancel()
    worker.succeeded.connect(received.append)
    worker.run()
    assert received == []
    assert worker.is_cancelled() is True
