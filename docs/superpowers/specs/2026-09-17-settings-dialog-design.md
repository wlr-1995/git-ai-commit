# 设置界面 — 设计文档

- 日期：2026-09-17
- 状态：待评审
- 目标平台：Windows（开发机 Win10/11，Python 3.13 + PySide6 6.11）
- 依赖：`2026-09-17-styles-as-files-design.md`（多 `.qss` 加载与 `available_styles()`）

## 1. 背景与目标

现在改样式要改代码（本轮之前），改模型参数要手改 `%USERPROFILE%\.git_ai_commit\config.json` —— 对一个从资源管理器右键唤起的小工具来说太重。

目标：在主窗口里加一个**设置对话框**，提供两件事：

1. **选择样式**：从 `app/ui/styles/*.qss` 里选（阶段一已支持多文件）
2. **设置模型参数**：接口地址、模型名、API Key、超时

### 非目标（用户已明确）

- 不做「测试连接」按钮
- 不新增采样参数（`temperature`/`top_p`/自定义请求头）——`app/core/ai.py` 的请求体不变
- 不暴露 `api.prompt`、`api.language`、`api.max_tokens`、`git.max_diff_lines`（仍可手改配置文件）
- 不做配置文件的导入/导出、不做多套配置档

## 2. 界面规格

模态对话框，标题「设置」，宽约 460px，两个分组：

```
 外观
   样式        [ 传统框感            ▾ ]
 模型
   接口地址    [ http://localhost:11434/v1           ]
   模型名      [ qwen2.5-coder:7b                    ]
   API Key     [ ••••••••                            ]
   超时（秒）  [ 60                                  ]

                              [ 取消 ]  [ 保存 ]
```

- 分组标题用 `QLabel#sectionLabel`；字段标签用默认 `QLabel`
- 样式下拉用 `QComboBox`，表项文本 = `available_styles()` 的显示名（首行注释 `/* 名称: xxx */`，缺省文件名）
- API Key 用 `QLineEdit` + `EchoMode.Password`
- 超时用 `QSpinBox`，范围 1–600，后缀「 秒」
- 「保存」用 `objectName("primaryButton")`（近黑底白字），「取消」为普通按钮
- 对话框本身套用当前应用样式（含阶段一新增的 `QComboBox`/`QSpinBox` 规则），保持黑白

## 3. 行为

### 3.1 打开

- 主窗口底部按钮行（`app/ui/main_window.py` 的 `_build_actions`）在「AI 生成」**左侧**加一个「设置」按钮
- 点击 → 用当前 `self.config` 构造 `SettingsDialog`，`exec()` 模态显示

### 3.2 实时预览（关键）

- 打开时记录「原样式」
- 样式下拉的选中项一变，立即把新样式应用到整个应用 → 用户当场看到效果
- **取消 / Esc / 关窗** → 把原样式应用回去，不写盘
- **保存** → 保留新样式，写盘

对话框**不直接操作 `QApplication`**：只发 `stylePreview(str)` 信号，主窗口负责预览——主窗口用 `QApplication.instance()` 取到应用，调用 `theme.apply_style(app, name)` 并同步表格最小高度。这样对话框可脱离 QApplication 单测。

### 3.3 保存

主窗口收到 `accept()` 后：

1. `self.config = deep_merge(self.config, dialog.values())`——`values()` 只含 `api` 的 4 个键与 `ui.style`，所以深合并不会碰其它配置
2. `save_config(self.config)` 写盘（UTF-8，保持既有格式）
3. `self.config = load_config()` 重载（保证内存与磁盘一致）
4. 应用新样式 + `_sync_table_min_height()`
5. 状态栏提示「设置已保存」

模型参数**不需要重启也不立刻发请求**：`_generate` 每次都从 `self.config.get("api")` 现取，下次点「AI 生成」自然生效。

### 3.4 校验

- 接口地址为空 → 「保存」禁用，下方提示「接口地址不能为空」（与 `app/core/ai.py:35` 的报错信息一致）
- 超时由 `QSpinBox` 范围保证
- 模型名、API Key 允许为空

## 4. 组件接口

```python
# app/ui/settings_dialog.py
class SettingsDialog(QDialog):
    stylePreview = Signal(str)          # 预览样式变更，参数为样式 key

    def __init__(self, config: dict, parent=None) -> None: ...
    def values(self) -> dict:
        """{"api": {"url":…, "model":…, "api_key":…, "timeout":…},
            "ui": {"style": <key>}}"""
    def current_style(self) -> str: ...  # 当前下拉选中的样式 key
```

- 只读入参 `config` 的副本，不改原字典
- 未知样式（配置文件里写了一个已被删除的样式名）→ 下拉回退到 `theme.DEFAULT_STYLE` 并选中它
- 不 import `main_window`，不 import `QApplication`

## 5. 配置变更

```jsonc
{
  "ui": {
    "window_width": 720,
    "window_height": 520,
    "show_untracked": false,
    "style": "traditional"        // 新增；旧配置靠 deep_merge 自动补齐
  }
}
```

- `DEFAULT_CONFIG["ui"]["style"] = "traditional"`
- `app/main.py:46` 的 `apply_light_theme(app)` 改为读配置里的样式启动（避免先按默认样式画一帧再切换）
- `tests/test_theme.py::test_main_applies_light_theme` 的假函数签名同步更新（现在会带样式名参数）

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| 写盘失败（磁盘满/权限/路径不可写） | 不关闭对话框，走主窗口既有 `_error`（状态栏 + 错误对话框），保留用户输入 |
| 配置里 `ui.style` 是未知样式 | 下拉回退默认样式，启动与预览都不崩（`load_stylesheet` 已回退） |
| 预览的样式文件语法错误 | 实时预览 + 取消还原即可脱困；README 写明改回 `ui.style` 或删除该 `.qss` |
| 用户在预览状态下选错样式后强杀进程 | 未保存，磁盘配置不变，下次启动仍是原样式 |

## 7. 测试策略

| 测试 | 断言 |
|---|---|
| `test_dialog_lists_available_styles` | 下拉项 == `theme.available_styles()` 的显示名，且选中项 == 配置里的样式 |
| `test_dialog_unknown_style_falls_back` | 配置写 `style = "ghost"` → 下拉选中默认样式，不抛异常 |
| `test_preview_signal_fires_on_style_change` | 改变下拉 → 收到 `stylePreview`，参数为新 key（用 `QSignalSpy`/回调计数） |
| `test_cancel_restores_previous_style` | 主窗口层：打开 → 切样式 → 取消 → `app.styleSheet()` 与打开前一致，且配置文件未被改写 |
| `test_values_returns_expected_fields` | `values()` 只含 4 个 api 字段 + `ui.style`，不含 `prompt`/`language`/`max_tokens` |
| `test_api_key_is_masked` | `echoMode() == QLineEdit.EchoMode.Password` |
| `test_save_writes_config_and_reloads` | 用临时 `CONFIG_FILE`（monkeypatch）→ 保存后文件里 url/model/api_key/timeout/style 都是新值，`window.config` 同步更新 |
| `test_save_disabled_when_url_empty` | 清空接口地址 → 「保存」禁用 + 有提示文案 |
| `test_save_failure_keeps_dialog_open` | monkeypatch `save_config` 抛 `OSError` → 不 accept、不崩、提示出现 |
| `test_settings_button_opens_dialog` | monkeypatch `SettingsDialog.exec` → 点按钮后对话框被构造且传入的是 `window.config` |
| `test_combo_popup_is_monochrome` | 打开下拉弹窗 → 抓弹窗 view 像素，无非灰阶像素（证明 `QComboBox QAbstractItemView` 的选中色规则生效，没有漏出 Fusion 蓝） |

## 8. 验收标准

1. 从主窗口能打开「设置」，改样式时**当场**看到界面变化，取消能完整还原
2. 保存后 `config.json` 里 5 个键被更新，重启程序仍是保存的样式与参数
3. 下次点「AI 生成」使用的是新保存的 url/model/api_key/timeout（可用本地假服务或断言 `window.config` 验证）
4. 设置对话框、下拉弹窗、数字框全部黑白，无彩色
5. `python -m pytest -q` 全绿；README 增加「设置」与「样式」章节

## 9. 风险

| 风险 | 缓解 |
|---|---|
| API Key 明文存于 `config.json` | 不引入加密（本地工具，加密的密钥材料也在同一台机器）；README 明确提示此点，建议使用权限受限的密钥 |
| 删掉调色板后下拉弹窗/菜单漏出 Fusion 蓝 | 阶段一的 QSS 规则 + 本节 `test_combo_popup_is_monochrome` |
| 用户在预览态选了坏样式，界面不可读导致无法取消 | `Esc` 仍可用（对话框无边框样式依赖）；README 给出「删 `.qss` 或改 `ui.style`」的脱困路径 |
| 设置对话框后续再加字段会膨胀 | 字段分组化（外观/模型），新增字段只需在对应组加一行；`values()` 显式列举要保存的键，不会误写配置 |
