"""设置对话框：样式列表、预览信号、取值与校验。"""

import copy
import os

import pytest

pytest.importorskip("PySide6")

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QLineEdit  # noqa: E402

from app.core.config import DEFAULT_CONFIG  # noqa: E402
from app.ui import theme  # noqa: E402
from app.ui.settings_dialog import SettingsDialog  # noqa: E402


@pytest.fixture(scope="module")
def qapp():
    return QApplication.instance() or QApplication([])


def _config(**overrides) -> dict:
    config = copy.deepcopy(DEFAULT_CONFIG)
    for dotted, value in overrides.items():
        section, _, key = dotted.partition("__")
        config[section][key] = value
    return config


def test_lists_styles_and_selects_configured_one(qapp):
    dialog = SettingsDialog(_config(ui__style="flat"))

    labels = [dialog.style_combo.itemText(i) for i in range(dialog.style_combo.count())]
    assert labels == [label for _key, label in theme.available_styles()]
    assert dialog.current_style() == "flat"
    assert dialog.original_style() == "flat"
    dialog.close()


def test_unknown_style_falls_back_to_default(qapp):
    dialog = SettingsDialog(_config(ui__style="ghost"))

    assert dialog.current_style() == theme.DEFAULT_STYLE
    dialog.close()


def test_preview_signal_fires_with_new_key(qapp):
    dialog = SettingsDialog(_config())
    events: list[str] = []
    dialog.stylePreview.connect(events.append)

    index = dialog.style_combo.findData("flat")
    assert index >= 0, "样式列表里应该有 flat"
    dialog.style_combo.setCurrentIndex(index)

    assert events == ["flat"]
    dialog.close()


def test_values_only_exposes_the_agreed_keys(qapp):
    dialog = SettingsDialog(_config())
    dialog.url_edit.setText(" http://127.0.0.1:8000/v1 ")
    dialog.model_edit.setText(" local-model ")
    dialog.api_key_edit.setText("secret")
    dialog.timeout_spin.setValue(30)

    values = dialog.values()

    assert values == {
        "api": {
            "url": "http://127.0.0.1:8000/v1",
            "model": "local-model",
            "api_key": "secret",
            "timeout": 30,
        },
        "ui": {"style": theme.DEFAULT_STYLE},
    }
    dialog.close()


@pytest.mark.parametrize("bad_timeout", ["1m", []])
def test_non_numeric_timeout_falls_back_to_default(qapp, bad_timeout):
    dialog = SettingsDialog(_config(api__timeout=bad_timeout))

    assert dialog.timeout_spin.value() == 60
    dialog.close()


def test_api_key_is_masked(qapp):
    dialog = SettingsDialog(_config(api__api_key="secret"))

    assert dialog.api_key_edit.echoMode() == QLineEdit.EchoMode.Password
    dialog.close()


def test_save_disabled_while_url_empty(qapp):
    dialog = SettingsDialog(_config(api__url=""))

    assert dialog.btn_save.isEnabled() is False
    assert dialog.validation_hint.text() == "接口地址不能为空"

    dialog.url_edit.setText("http://localhost:11434/v1")

    assert dialog.btn_save.isEnabled() is True
    assert dialog.validation_hint.text() == ""
    dialog.close()


def test_on_save_error_keeps_dialog_open_and_keeps_input(qapp):
    seen: list[dict] = []

    def failing_save(values: dict) -> str | None:
        seen.append(values)
        return "保存失败：磁盘满了"

    dialog = SettingsDialog(_config(), on_save=failing_save)
    dialog.url_edit.setText("http://example.test/v1")
    dialog.btn_save.click()

    assert len(seen) == 1
    assert seen[0]["api"]["url"] == "http://example.test/v1"
    assert dialog.result() == 0, "保存失败时不应 accept"
    assert dialog.validation_hint.text() == "保存失败：磁盘满了"
    assert dialog.url_edit.text() == "http://example.test/v1"
    dialog.close()


def test_on_save_success_accepts(qapp):
    calls: list[dict] = []
    dialog = SettingsDialog(_config(), on_save=lambda values: calls.append(values) or None)

    dialog.btn_save.click()

    assert calls and calls[0]["ui"]["style"] == theme.DEFAULT_STYLE
    assert dialog.result() == int(SettingsDialog.DialogCode.Accepted)
    dialog.close()
