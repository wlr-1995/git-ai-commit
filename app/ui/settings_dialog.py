"""设置对话框：选择样式 + 模型参数。

- 样式变更只发 ``stylePreview`` 信号，应用与还原由主窗口负责。
- 保存走注入的 ``on_save(values)`` 回调（返回错误文案则不关闭对话框），
  所以本模块不 import ``QApplication``、不 import ``core.config``，可独立单测。
- 颜色/间距全部来自既有样式表与 ``theme`` 的刻度，这里不写任何色值。
"""

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
)

from . import theme


class SettingsDialog(QDialog):
    """外观（样式）+ 模型（接口地址/模型名/API Key/超时）。"""

    stylePreview = Signal(str)

    def __init__(self, config: dict, on_save=None, parent=None) -> None:
        super().__init__(parent)
        self._on_save = on_save
        self._original_style = self._resolve_style(config)
        self.setWindowTitle("设置")
        self.setMinimumWidth(460)
        self._build_ui(config)

    # --- 搭建 ---

    @staticmethod
    def _resolve_style(config: dict) -> str:
        """配置里的样式；未知（例如文件已被删除）则回退默认样式。"""
        wanted = str(config.get("ui", {}).get("style") or theme.DEFAULT_STYLE)
        known = {key for key, _label in theme.available_styles()}
        return wanted if wanted in known else theme.DEFAULT_STYLE

    @staticmethod
    def _as_int(value, fallback: int) -> int:
        """配置可能被手改成非数字；这里退回默认值而不是抛异常。"""
        try:
            return int(value)
        except (TypeError, ValueError):
            return fallback

    def _build_ui(self, config: dict) -> None:
        api = config.get("api", {})

        self.style_combo = QComboBox()
        for key, label in theme.available_styles():
            self.style_combo.addItem(label, key)
        self.style_combo.setCurrentIndex(max(self.style_combo.findData(self._original_style), 0))
        self.style_combo.currentIndexChanged.connect(self._on_style_changed)

        self.url_edit = QLineEdit(str(api.get("url") or ""))
        self.url_edit.setPlaceholderText("如 http://localhost:11434/v1")
        self.url_edit.textChanged.connect(lambda _text: self._update_save_enabled())

        self.model_edit = QLineEdit(str(api.get("model") or ""))

        self.api_key_edit = QLineEdit(str(api.get("api_key") or ""))
        self.api_key_edit.setEchoMode(QLineEdit.EchoMode.Password)
        self.api_key_edit.setToolTip("以明文保存在配置文件中，建议使用权限受限的密钥")

        self.timeout_spin = QSpinBox()
        self.timeout_spin.setRange(1, 600)
        self.timeout_spin.setSuffix(" 秒")
        self.timeout_spin.setValue(self._as_int(api.get("timeout") or 60, 60))

        self.validation_hint = QLabel()
        self.validation_hint.setObjectName("hintLabel")

        self.btn_save = QPushButton("保存")
        self.btn_save.setObjectName("primaryButton")
        self.btn_save.clicked.connect(self._on_save_clicked)
        self.btn_cancel = QPushButton("取消")
        self.btn_cancel.clicked.connect(self.reject)

        model_form = QFormLayout()
        model_form.addRow("接口地址", self.url_edit)
        model_form.addRow("模型名", self.model_edit)
        model_form.addRow("API Key", self.api_key_edit)
        model_form.addRow("超时", self.timeout_spin)

        appearance_form = QFormLayout()
        appearance_form.addRow("样式", self.style_combo)

        buttons = QHBoxLayout()
        buttons.addStretch(1)
        buttons.addWidget(self.btn_cancel)
        buttons.addWidget(self.btn_save)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(*theme.WINDOW_MARGINS)
        layout.setSpacing(theme.LAYOUT_SPACING)
        layout.addWidget(self._section("外观"))
        layout.addLayout(appearance_form)
        layout.addWidget(self._section("模型"))
        layout.addLayout(model_form)
        layout.addStretch(1)
        layout.addWidget(self.validation_hint)
        layout.addLayout(buttons)

        self._update_save_enabled()

    @staticmethod
    def _section(text: str) -> QLabel:
        label = QLabel(text)
        label.setObjectName("sectionLabel")
        return label

    # --- 行为 ---

    def original_style(self) -> str:
        """打开对话框时配置里的样式（主窗口在取消时用它还原）。"""
        return self._original_style

    def current_style(self) -> str:
        return self.style_combo.currentData()

    def values(self) -> dict:
        """只返回要写回配置的键，避免误写其它配置。"""
        return {
            "api": {
                "url": self.url_edit.text().strip(),
                "model": self.model_edit.text().strip(),
                "api_key": self.api_key_edit.text().strip(),
                "timeout": int(self.timeout_spin.value()),
            },
            "ui": {"style": self.current_style() or theme.DEFAULT_STYLE},
        }

    def _on_style_changed(self, _index: int) -> None:
        self.stylePreview.emit(self.current_style())

    def _on_save_clicked(self) -> None:
        if not self.url_edit.text().strip():
            return
        if self._on_save is not None:
            error = self._on_save(self.values())
            if error:
                # 写盘失败：保留对话框与用户输入，等用户处理。
                self.validation_hint.setText(error)
                return
        self.accept()

    def _update_save_enabled(self) -> None:
        ok = bool(self.url_edit.text().strip())
        self.btn_save.setEnabled(ok)
        self.validation_hint.setText("" if ok else "接口地址不能为空")
