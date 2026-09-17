# 设置界面 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在主窗口加一个「设置」按钮，打开模态对话框：从 `app/ui/styles/*.qss` 里选样式（改一下就当场预览、取消能还原），并编辑接口地址 / 模型名 / API Key / 超时，保存写回 `config.json`。

**Architecture:** `SettingsDialog`（新文件）只做界面与取值，样式变更通过 `stylePreview(str)` 信号抛给主窗口，保存通过注入的 `on_save(values)` 回调执行——所以它不 import `QApplication`、不 import `core.config`，可以脱离应用单测。主窗口提供**唯一**的换样式入口 `MainWindow.apply_style(style)`（应用样式表 + 同步表格最小高度），预览、取消还原、保存后应用都走它；模型参数存进 `self.config` 后，下次点「AI 生成」自然生效。

**Tech Stack:** Python 3.13、PySide6 6.11、pytest（`QT_QPA_PLATFORM=offscreen`，`tests/conftest.py` 已套真实主题）、git。

**Spec:** `docs/superpowers/specs/2026-09-17-settings-dialog-design.md`（依赖已完成的 `2026-09-17-styles-as-files-design.md`）

## Global Constraints

- 平台：Windows（Win10/11）；Python 3.12+（开发机 3.13.13）
- 运行时依赖只有 `PySide6`、`requests`；测试依赖 `pytest`，不新增任何依赖
- 颜色只放在 `.qss` 里：新增界面不得引入任何色值/样式常量，也不得新加 `setStyleSheet`；新控件靠既有选择器（`QComboBox`/`QSpinBox`/`#sectionLabel`/`#hintLabel`/`#primaryButton`）拿样式
- 间距刻度 4/8/12/16/24，沿用 `theme.SPACE_*`/`theme.WINDOW_MARGINS`/`theme.LAYOUT_SPACING`
- 文案中文；所有 git/AI 调用不在 UI 主线程（本计划不涉及）
- 配置读写只用 `core.config` 的 `load_config`/`save_config`/`deep_merge`；配置文件路径 `%USERPROFILE%\.git_ai_commit\config.json`
- **API Key 明文存储**（既有事实），README 必须写明
- 测试统一跑 `python -m pytest -q`（offscreen + 真实主题由 conftest 保证，不要绕过）
- 提交信息用英文 `type(scope): subject` 风格

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `app/ui/settings_dialog.py` | 设置对话框：样式下拉 + 双列参数 + 保存/取消 | 新建 |
| `tests/test_settings_dialog.py` | 对话框单元测试（不依赖 QApplication 之外的全局状态） | 新建 |
| `app/ui/main_window.py` | 「设置」按钮、`apply_style()`、`open_settings()`、`_save_settings()` | 修改 |
| `app/core/config.py` | `DEFAULT_CONFIG["ui"]["style"] = "traditional"` | 修改 |
| `app/main.py` | 启动时按配置里的样式套主题 | 修改 |
| `tests/test_theme.py` | `test_main_applies_light_theme` 跟上传参变化 | 修改 |
| `tests/test_main_window.py` | 设置入口 / 样式切换 / 保存回环 / 取消还原 | 修改 |
| `README.md` | 「设置」与「样式」章节 + API Key 明文提醒 | 修改 |

---

### Task 1: `SettingsDialog` + 它的单元测试

**Files:**
- Create: `app/ui/settings_dialog.py`
- Create: `tests/test_settings_dialog.py`

**Interfaces:**
- Consumes: `theme.available_styles()`、`theme.DEFAULT_STYLE`、`theme.SPACE_*`、`theme.WINDOW_MARGINS`、`theme.LAYOUT_SPACING`
- Produces（Task 2 依赖的精确签名）：
  - `SettingsDialog(config: dict, on_save=None, parent=None)`
  - `SettingsDialog.stylePreview = Signal(str)`
  - `SettingsDialog.values() -> dict`（`{"api": {url, model, api_key, timeout}, "ui": {"style": key}}`）
  - `SettingsDialog.current_style() -> str`、`SettingsDialog.original_style() -> str`
  - `on_save(values: dict) -> str | None`（返回文案则不关闭对话框）
  - 控件属性名（Task 2 的测试会用）：`style_combo`、`url_edit`、`model_edit`、`api_key_edit`、`timeout_spin`、`btn_save`、`btn_cancel`、`validation_hint`

- [ ] **Step 1: 写失败测试**

创建 `tests/test_settings_dialog.py`：

```python
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
```

- [ ] **Step 2: 运行确认失败**

Run: `python -m pytest tests/test_settings_dialog.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.ui.settings_dialog'`

- [ ] **Step 3: 实现 `app/ui/settings_dialog.py`**

```python
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
        self.timeout_spin.setValue(int(api.get("timeout") or 60))

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
            "ui": {"style": self.current_style()},
        }

    def _on_style_changed(self, _index: int) -> None:
        self.stylePreview.emit(self.current_style())

    def _on_save_clicked(self) -> None:
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
```

- [ ] **Step 4: 运行确认通过**

Run: `python -m pytest tests/test_settings_dialog.py -q`
Expected: PASS（8 passed）

- [ ] **Step 5: 跑全量测试**

Run: `python -m pytest -q`
Expected: 全绿（110 + 8 = 118）

- [ ] **Step 6: 提交**

```powershell
git add app/ui/settings_dialog.py tests/test_settings_dialog.py
git commit -m "feat(ui): add settings dialog (style picker, preview signal, model fields)"
```

---

### Task 2: 主窗口接入 + 配置键 + 启动时读样式

**Files:**
- Modify: `app/ui/main_window.py`（导入、`_build_actions`、`apply_style`、`open_settings`、`_save_settings`）
- Modify: `app/core/config.py`（`ui.style` 默认值）
- Modify: `app/main.py`（按配置样式启动）
- Modify: `tests/test_theme.py`（`test_main_applies_light_theme`）
- Modify: `tests/test_main_window.py`（新增 5 条）
- Test: `tests/test_main_window.py`

**Interfaces:**
- Consumes: Task 1 的 `SettingsDialog(config, on_save=None, parent=None)`、`stylePreview`、`values()`、`current_style()`、`original_style()`；阶段一的 `theme.apply_style(app, style)`、`MainWindow._sync_table_min_height()`、`theme.DEFAULT_STYLE`
- Produces:
  - `MainWindow.apply_style(style: str) -> None`
  - `MainWindow.open_settings() -> None`
  - `MainWindow._save_settings(values: dict) -> str | None`
  - `MainWindow.btn_settings`（按钮）
  - `DEFAULT_CONFIG["ui"]["style"] = "traditional"`

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_main_window.py` 末尾（该文件已有 `_make_window`、`qapp`）：

```python
def test_settings_button_opens_dialog_with_config(qapp, tmp_path, monkeypatch):
    from app.ui import settings_dialog as sd

    seen: list = []

    def fake_exec(self):
        seen.append(self)
        return int(sd.SettingsDialog.DialogCode.Rejected)

    monkeypatch.setattr(sd.SettingsDialog, "exec", fake_exec)
    monkeypatch.setattr(mw, "SettingsDialog", sd.SettingsDialog, raising=False)
    window = _make_window(tmp_path, monkeypatch)
    assert hasattr(window, "btn_settings")

    window.btn_settings.click()

    assert len(seen) == 1
    assert seen[0].original_style() == window.config.get("ui", {}).get("style")


def test_apply_style_updates_min_table_height(qapp, tmp_path, monkeypatch):
    window = _make_window(tmp_path, monkeypatch)
    window.show()
    qapp.processEvents()

    window.apply_style("flat")

    row_height = window.changes_table.verticalHeader().defaultSectionSize()
    assert row_height == 28, "flat 的行高应来自样式表"
    assert (
        window.changes_table.minimumHeight()
        == row_height * theme.TABLE_MIN_VISIBLE_ROWS + theme.TABLE_MIN_HEIGHT_EXTRA
    )
    window.apply_style(theme.DEFAULT_STYLE)


def test_open_settings_saves_and_reloads_config(qapp, tmp_path, monkeypatch):
    import json

    from app.core import config as config_module
    from app.ui import settings_dialog as sd

    cfg_path = tmp_path / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_FILE", cfg_path)
    monkeypatch.setattr(mw, "SettingsDialog", sd.SettingsDialog, raising=False)

    def fake_exec(self):
        self.url_edit.setText("http://example.test/v1")
        self.model_edit.setText("demo-model")
        self.api_key_edit.setText("k")
        self.timeout_spin.setValue(15)
        flat = self.style_combo.findData("flat")
        self.style_combo.setCurrentIndex(flat)
        self.btn_save.click()
        return self.result()

    monkeypatch.setattr(sd.SettingsDialog, "exec", fake_exec)
    window = _make_window(tmp_path, monkeypatch)
    window.open_settings()

    saved = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert saved["api"]["url"] == "http://example.test/v1"
    assert saved["api"]["model"] == "demo-model"
    assert saved["api"]["api_key"] == "k"
    assert saved["api"]["timeout"] == 15
    assert saved["ui"]["style"] == "flat"
    assert window.config["api"]["url"] == "http://example.test/v1"
    assert "已保存" in window.status.text()
    window.apply_style(theme.DEFAULT_STYLE)


def test_open_settings_cancel_restores_style_and_writes_nothing(qapp, tmp_path, monkeypatch):
    from app.core import config as config_module
    from app.ui import settings_dialog as sd

    cfg_path = tmp_path / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_FILE", cfg_path)
    monkeypatch.setattr(mw, "SettingsDialog", sd.SettingsDialog, raising=False)
    window = _make_window(tmp_path, monkeypatch)
    window.apply_style(theme.DEFAULT_STYLE)  # 固定起点，免受同会话其它用例影响
    before = qapp.styleSheet()

    def fake_exec(self):
        # 模拟用户先预览了 flat，然后取消
        flat = self.style_combo.findData("flat")
        self.style_combo.setCurrentIndex(flat)
        window.apply_style("flat")
        self.reject()
        return self.result()

    monkeypatch.setattr(sd.SettingsDialog, "exec", fake_exec)
    window.open_settings()

    assert qapp.styleSheet() == before, "取消后必须还原打开前的样式"
    assert not cfg_path.exists(), "取消不应写盘"


def test_save_settings_failure_returns_error_and_keeps_config(qapp, tmp_path, monkeypatch):
    from app.core import config as config_module

    cfg_path = tmp_path / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_FILE", cfg_path)
    window = _make_window(tmp_path, monkeypatch)
    before = copy.deepcopy(window.config)

    def boom(_config):
        raise OSError("磁盘只读")

    monkeypatch.setattr(mw, "save_config", boom)

    error = window._save_settings({"api": {"url": "http://x/v1"}, "ui": {"style": "flat"}})

    assert error is not None and "保存失败" in error
    assert window.config == before, "保存失败时内存配置不应变化"
    assert not cfg_path.exists()
```

- [ ] **Step 2: 运行确认失败**

Run: `python -m pytest tests/test_main_window.py -q -k "settings or apply_style"`
Expected: FAIL — `AttributeError: 'MainWindow' object has no attribute 'btn_settings'`

- [ ] **Step 3: 改 `app/core/config.py`**

把 `ui` 段：

```python
    "ui": {"window_width": 720, "window_height": 520, "show_untracked": False},
```

改为：

```python
    "ui": {
        "window_width": 720,
        "window_height": 520,
        "show_untracked": False,
        "style": "traditional",
    },
```

- [ ] **Step 4: 改 `app/ui/main_window.py`**

(a) 导入区：QtWidgets 列表里加 `QApplication`、`QDialog`；config 导入补两个函数；新增 `SettingsDialog` 导入：

```python
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QCheckBox,
    QDialog,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QSizePolicy,
    QStyle,
    QStyleOptionViewItem,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..core import ai, repo
from ..core.config import deep_merge, load_config, save_config
from . import theme
from .settings_dialog import SettingsDialog
from .worker import FunctionWorker
```

(b) `_build_actions` 里，在 `btn_generate` 之前加「设置」按钮，并加进布局：

```python
    def _build_actions(self) -> QHBoxLayout:
        self.btn_settings = QPushButton("设置")
        self.btn_settings.setToolTip("选择界面样式，填写模型参数")
        self.btn_settings.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.btn_settings.clicked.connect(self.open_settings)

        self.btn_generate = QPushButton("AI 生成")
```

并把布局改为（「设置」在最左，其余不动）：

```python
        row = QHBoxLayout()
        row.setSpacing(theme.SPACE_SM)
        row.addWidget(self.btn_settings)
        row.addWidget(self.btn_generate)
        row.addWidget(self.btn_cancel)
        row.addWidget(self.action_hint)
        row.addStretch(1)
        row.addWidget(self.btn_commit)
        return row
```

(c) 新增三个方法（放在 `_sync_table_min_height` 之后）：

```python
    # --- 设置 ---

    def apply_style(self, style: str) -> None:
        """换样式：设置应用样式表并同步依赖行高的布局。

        样式表是全应用级的，换样式会把所有已建窗口重新 polish，行高随之变化；
        设置对话框的预览、取消还原、保存后应用都必须走这里。
        """
        app = QApplication.instance()
        if app is not None:
            theme.apply_style(app, style)
        self._sync_table_min_height()

    def open_settings(self) -> None:
        """打开设置对话框：实时预览样式，取消还原，保存写盘。"""
        dialog = SettingsDialog(self.config, on_save=self._save_settings, parent=self)
        dialog.stylePreview.connect(self.apply_style)
        accepted = dialog.exec() == QDialog.DialogCode.Accepted
        if not accepted:
            self.apply_style(dialog.original_style())

    def _save_settings(self, values: dict) -> str | None:
        """写回配置并应用新样式；失败时返回文案（对话框保持打开）。"""
        try:
            save_config(deep_merge(self.config, values))
        except OSError as exc:
            return f"保存失败：{exc}"
        self.config = load_config()
        self.apply_style(self.config.get("ui", {}).get("style") or theme.DEFAULT_STYLE)
        self._set_status("设置已保存")
        return None
```

- [ ] **Step 5: 改 `app/main.py`**

把导入与调用改为（保持原有导入顺序，只多两行）：

```python
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
```

- [ ] **Step 6: 改 `tests/test_theme.py` 的入口测试**

把 `test_main_applies_light_theme` 换成（新增 `load_config` 打桩 + 断言样式名被传进去）：

```python
def test_main_applies_light_theme(monkeypatch):
    """入口必须在建窗口前套用配置里的样式，否则系统深色模式下会变黑底。"""
    import app.core.config as config_module
    import app.core.repo as repo_module
    import app.main as main_module
    import app.ui.main_window as mw_module

    events = []

    class FakeApplication:
        def __init__(self, argv):
            events.append("app-created")

        def exec(self):
            return 0

    class FakeWindow:
        def __init__(self, root):
            events.append(("window", root))

        def show(self):
            events.append("shown")

    monkeypatch.setattr("PySide6.QtWidgets.QApplication", FakeApplication)
    monkeypatch.setattr(
        theme,
        "apply_light_theme",
        lambda app, style=None: events.append(("theme", style)),
    )
    monkeypatch.setattr(config_module, "load_config", lambda: {"ui": {"style": "flat"}})
    monkeypatch.setattr(repo_module, "find_repo_root", lambda start: "R")
    monkeypatch.setattr(mw_module, "MainWindow", FakeWindow)

    assert main_module.main(["prog", "somewhere"]) == 0
    assert events == ["app-created", ("theme", "flat"), ("window", "R"), "shown"]
```

- [ ] **Step 7: 运行并修到全绿**

Run: `python -m pytest -q`
Expected: 全绿（118 + 5 = 123）。若 `test_main_applies_light_theme` 因为 main.py 里 `load_config` 的导入位置而打不上桩，确认 `main()` 内部是函数级 `from app.core.config import load_config`，或改成在测试里打桩 `app.core.config.load_config` 后重试。

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(ui): wire the settings dialog into the main window (preview, save, restore)"
```

---

### Task 3: README + 真机验收

**Files:**
- Modify: `README.md`
- Test: 无（真机脚本）

**Interfaces:**
- Consumes: Task 1/2 的全部功能
- Produces: 验收结论（无代码接口）

- [ ] **Step 1: 改 `README.md`**

(a) 「使用说明」列表里，在「AI 生成」那条**之前**插入一条（编号按现有列表顺延，不要打乱既有条目）：

```
6. 点「设置」可切换界面样式（改一下就当场预览，取消会还原）并填写接口地址 / 模型名 / API Key / 超时；保存后写回配置文件，模型参数下次点「AI 生成」即生效。
```

（序号按现有列表顺延，不要打乱既有条目编号。）

(b) 「配置字段」表里加一行：

```
| `ui.style` | `traditional` | 界面样式，取 `app/ui/styles/<名字>.qss` 的文件名；设置界面里的样式下拉就是它。未知名字会回退 `traditional`。 |
```

(c) 在 `api.api_key` 那一行附近补一句提醒（若表中已存在该行则改其说明）：

```
| `api.api_key` | `ollama` | 接口密钥。**以明文保存在配置文件里**（不做加密），建议使用权限受限的密钥。 |
```

(d) 「界面」章节里说明样式目录与自定义方法：

```
- 样式是真实文件：`app/ui/styles/` 下每份 `.qss` 就是一套样式（`traditional.qss` 默认、`flat.qss` 扁平），往这个目录丢新的 `.qss` 就会出现在设置界面的样式下拉里（文件名就是样式名，首行可写 `/* 名称: 中文名 */` 指定显示名）。样式文件里 `url("...")` 按相对该文件解析；颜色必须只用灰阶。想回退就删掉那个 `.qss`，或在设置界面选回 `traditional`。
```

- [ ] **Step 2: 真机跑一遍设置界面并截图**

写 `%TEMP%\opencode\settings_shots.py`（**必须写文件并 `os._exit(0)` 收尾**；内联 `python -c` 创建 QApplication 后可能挂死）：

```python
"""真机截图：设置对话框、切换样式后的主窗口、下拉弹窗。"""

import copy
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, r"D:\wlr\ai\git-ai-commit")

import app  # noqa: E402,F401
from PySide6.QtWidgets import QApplication  # noqa: E402

from app.core.config import DEFAULT_CONFIG  # noqa: E402
from app.ui import theme  # noqa: E402
from app.ui.settings_dialog import SettingsDialog  # noqa: E402

OUT = Path(tempfile.gettempdir()) / "settings-shots"
OUT.mkdir(exist_ok=True)


def main() -> int:
    qapp = QApplication([])
    theme.apply_light_theme(qapp, theme.DEFAULT_STYLE)

    dialog = SettingsDialog(copy.deepcopy(DEFAULT_CONFIG))
    dialog.resize(460, 260)
    dialog.show()
    qapp.processEvents()
    dialog.grab().save(str(OUT / "dialog.png"), "PNG")
    print("弹窗前的样式:", dialog.current_style(), flush=True)

    # 预览 flat：主窗口由调用方负责，这里只验证信号与取值链路
    seen: list[str] = []
    dialog.stylePreview.connect(seen.append)
    dialog.style_combo.setCurrentIndex(dialog.style_combo.findData("flat"))
    qapp.processEvents()
    print("stylePreview 收到:", seen, flush=True)
    print("values() 的 ui 段:", dialog.values()["ui"], flush=True)

    dialog.style_combo.showPopup()
    qapp.processEvents()
    popup = dialog.style_combo.view()
    popup.grab().save(str(OUT / "popup.png"), "PNG")
    print("下拉项:", [dialog.style_combo.itemText(i) for i in range(dialog.style_combo.count())], flush=True)
    dialog.style_combo.hidePopup()
    dialog.close()
    print(f"输出: {OUT}", flush=True)
    return 0


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    os._exit(code)
```

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8
python -X utf8 "$env:TEMP\opencode\settings_shots.py"
```

Expected: 打印 `弹窗前的样式: traditional`、`stylePreview 收到: ['flat']`、`values() 的 ui 段: {'style': 'flat'}`、两项下拉项，输出目录里有两个 PNG。

- [ ] **Step 3: 看图确认**

用图片查看器打开 `%TEMP%\settings-shots\dialog.png` 与 `popup.png`，逐条确认：

- 对话框白底、分组标题「外观」「模型」比字段名更醒目
- 下拉框与数字框是扁平的 1px 描边（不是 Fusion 立体边框），下拉弹窗里被选中项是浅灰底黑字（**不是蓝色**）
- 「保存」是近黑底白字，「取消」是普通按钮；接口地址为空时「保存」变灰且下方有提示
- 没有任何彩色像素

把最有代表性的一张拷进 `.superpowers/sdd/shots/settings-*.png`（该目录 gitignore，不入库）。

- [ ] **Step 4: 主窗口冒烟 + 保存回环**

```powershell
$env:PYTHONIOENCODING='utf-8'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$repo = Join-Path $env:TEMP "smoke10_$(Get-Random)"
New-Item -ItemType Directory -Path $repo -Force | Out-Null
git -C $repo init -q -b main; git -C $repo config user.name t; git -C $repo config user.email t@e.com
Set-Content -LiteralPath (Join-Path $repo 'a.txt') -Value 'x' -Encoding utf8
git -C $repo add -A; git -C $repo commit -qm init
Set-Content -LiteralPath (Join-Path $repo 'a.txt') -Value 'xy' -Encoding utf8
$p = Start-Process -FilePath python -ArgumentList @('app\main.py', $repo) -PassThru -RedirectStandardError (Join-Path $repo 'err.txt')
Start-Sleep -Seconds 8
if (-not $p.HasExited) { Write-Output "窗口正常打开"; $p.Kill(); $p.WaitForExit() } else { Write-Output "提前退出 code=$($p.ExitCode)" }
$err = Get-Content (Join-Path $repo 'err.txt') -Raw -ErrorAction SilentlyContinue
Write-Output "stderr: $(if ($err) { $err } else { '(空)' })"
Remove-Item -Recurse -Force $repo -ErrorAction SilentlyContinue
Write-Output "残留 python 进程: $((Get-Process python -ErrorAction SilentlyContinue | Measure-Object).Count)"
```

Expected: `窗口正常打开`、`stderr: (空)`、`残留 python 进程: 0`

然后确认启动时读到了配置里的样式（打印生效样式）：

```powershell
python -X utf8 -c "import app; from app.core.config import load_config; from app.ui import theme; print('配置里的样式:', load_config()['ui']['style']); print('可用样式:', theme.available_styles())"
```

Expected: 打印当前配置的样式名（默认 `traditional`）与两份可用样式。

- [ ] **Step 5: 追加台账**

`.superpowers/` 是 gitignore 的临时区，**不要提交**。在 `.superpowers/sdd/progress.md` 末尾追加：

```
=== SDD run: settings dialog (plan docs/superpowers/plans/2026-09-17-settings-dialog.md) ===
- SettingsDialog + MainWindow.apply_style/open_settings/_save_settings + ui.style config key + main.py reads the style at startup.
- Acceptance: dialog screenshots (flat single-line borders, grey popup selection, disabled Save when url empty), real-platform smoke clean, save round-trip writes config.json and reloads.
```

---

## 自审记录

**Spec 覆盖检查**

| Spec 章节 | 落到的任务 |
|---|---|
| §2 界面规格（分组、控件、密码模式、范围、主按钮） | Task 1 Step 3 |
| §3.1 打开（底部「设置」按钮 + 模态） | Task 2 Step 4 |
| §3.2 实时预览 / 取消还原（统一入口 + 同步最小高度） | Task 2 Step 4（`apply_style`）、Step 1（两条测试） |
| §3.3 保存（deep_merge → save_config → load_config → apply_style → 状态栏） | Task 2 Step 4（`_save_settings`）、Step 1（回环测试） |
| §3.4 校验（url 为空禁用保存） | Task 1 Step 1（`test_save_disabled_while_url_empty`） |
| §4 组件接口（含 `on_save` 回调、`original_style`） | Task 1 Step 3 |
| §5 配置变更（`ui.style`、main.py 读样式、`test_main_applies_light_theme`） | Task 2 Step 3/5/6 |
| §6 错误处理（写盘失败保持对话框、未知样式回退） | Task 1（`test_on_save_error_keeps_dialog_open_and_keeps_input`、`test_unknown_style_falls_back_to_default`）、Task 2 Step 1 |
| §7 测试策略 | Task 1 Step 1、Task 2 Step 1 |
| §8 验收标准（含 README、黑白无彩色） | Task 3 |
| §9 风险（API Key 明文提醒、弹窗漏色） | Task 3 Step 1(c)、Step 3 |

**类型/命名一致性**：`SettingsDialog(config, on_save=None, parent=None)`、`stylePreview(str)`、`values()`、`current_style()`、`original_style()`、`MainWindow.apply_style(style)`、`open_settings()`、`_save_settings(values) -> str | None`、`btn_settings`、`ui.style` —— 各任务引用一致。

**占位符扫描**：无 TBD/TODO；每个代码步骤都给了可直接使用的完整内容（对话框全文、主窗口补丁、main.py 片段、测试全文、真机脚本全文）。
