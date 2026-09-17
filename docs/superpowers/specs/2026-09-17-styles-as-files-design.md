# 样式外置为 .qss 文件 — 设计文档

- 日期：2026-09-17
- 状态：待评审
- 目标平台：Windows（开发机 Win10/11，Python 3.13 + PySide6 6.11）
- 前置：`2026-09-17-git-ai-commit-design.md`（v1 已实现并合并）
- 后续：`2026-09-17-settings-dialog-design.md`（设置界面，依赖本文的多文件加载能力）

## 1. 背景与目标

v1 的界面样式全部是 `app/ui/theme.py` 里的 Python f-string（`BASE_QSS` + `DIRECTION_QSS`，约 140 行），颜色/间距靠 `{TEXT}`、`{SPACE_SM}` 这类令牌插值。这带来三个问题：

1. 改样式必须改 Python 代码，编辑器对 f-string 里的 QSS 没有语法高亮
2. `theme.py` 341 行里样式文本占四成，和「调色板/字体/图标/状态着色」混在一起
3. 无法支持「多套样式切换」——样式是唯一的一份字符串

目标：把 QSS 外置为**真实文件**，一份文件一套样式，目录扫描即可发现；`theme.py` 收缩为「QSS 管不了的东西 + 装载器」。

### 非目标

- 不改任何窗口结构、控件、文案、快捷键
- 不做深色主题（用户已定：只用黑白灰阶）
- 不做样式的运行时热重载/文件监听（切换由设置界面触发）
- 不引入 `.qrc` 资源编译、不做 PyInstaller 打包适配（当前无打包配置；装载器按 `Path(__file__)` 定位，将来打包时只需确保 `styles/` 随包分发）

## 2. 实测结论（设计依据）

以下四点全部实测过，不是推断。探针脚本：`%TEMP%\opencode\palette_probe*.py`、`style_probe.py`、`row_probe.py`、`header_probe.py`。

| 结论 | 证据 |
|---|---|
| **调色板可以完全交给 QSS** | 去掉 `setPalette`+`setFont`，QSS 里补 `*` 字体规则与窗口/状态栏/tooltip 底色规则后，四个状态（默认 / 有选中行+已填信息 / 全不选 / 干净空状态）与现状**逐像素相同：0 / 545600**，非灰阶像素数也完全一致 |
| **`QPalette` 不是逐项着色** | `QSS 无法按单元格数据着色`：`::item[status="untracked"]`、`[text="..."]`、`:first`、`:nth-child(1)`、把 item 当控件选等 7 种写法全部无效，状态列颜色仍来自代码 |
| **行高可由 QSS 控制** | `QHeaderView { qproperty-defaultSectionSize: 32; }` → 行高 24→32 生效。注意：**不能带 `px` 后缀**，且该选择器会同时命中水平表头（`h.defaultSectionSize` 也变 32）；改用 `QHeaderView#verticalHeader { ... }` 后行高生效而 `h.default` 保持 100 |
| **网格线与斑马纹可由 QSS 控制** | `gridline-color: transparent` 使网格线像素 2243→140（残留是表格外框）；`alternate-background-color` 设成底色使斑马纹像素 12532→0；两者都无需改 `setShowGrid`/`setAlternatingRowColors`（保持 `True`） |

## 3. 目标结构

```
app/ui/
├─ styles/
│  ├─ traditional.qss        # 默认：现行黑白「传统框感」
│  ├─ flat.qss               # 扁平原型（证明可切换；也是自定义样式的样板）
│  └─ icons/check.svg        # 由 app/ui/icons/ 移入（git mv），供样式用相对路径引用
├─ theme.py                  # 瘦身：装载器 + QSS 管不了的四件事
├─ main_window.py
└─ worker.py
```

样式文件的显示名：首行可选注释 `/* 名称: 传统框感 */`；没有就用文件名（`flat` → `flat`）。

`available_styles()` 只收录 `*.qss`，**跳过**以 `_` 或 `.` 开头的文件（留给将来的共享片段，也避免编辑器临时文件混进列表）。列表按「默认样式优先，其余按文件名排序」。

## 4. `.qss` 文件规格

### 4.1 通用约定

- 编码 UTF-8，换行 LF（含中文注释）
- **字面值**：写 `#1f1f1f`、`8px`、`6px`，不做任何令牌插值
- 只用灰阶色（`r == g == b`）
- `url()` 用**相对本文件目录**的路径，如 `image: url("icons/check.svg")`

### 4.2 `traditional.qss` 必须包含的规则

缺任何一条都算回归（等价于 v1 的 `BASE_QSS` + `DIRECTION_QSS` + 调色板职责）：

| 类别 | 规则 |
|---|---|
| 全局 | `*`（字体族 `"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI"` + `font-size: 9pt`）、`QWidget { color }` |
| 表面底色 | `QMainWindow`、`QDialog`、`QStatusBar`、`QMenu`、`QMessageBox`、`QToolTip`（原来是调色板承担的） |
| 输入 | `QLineEdit`、`QPlainTextEdit`、`QTextEdit`（含 `:focus`、`selection-background-color`/`selection-color`） |
| 按钮 | `QPushButton`（含 `:hover`/`:pressed`/`:focus`/`:disabled`）、`#primaryButton`、`#chip` |
| 标签 | `#repoName`、`#repoPath`、`#branchChip`、`#sectionLabel`、`#hintLabel`、`#emptyState`、`#statusLabel` |
| 勾选框 | `QCheckBox::indicator`、`QTableView::indicator`（含 `:hover`、`:checked`、`:checked:hover`，`image: url("icons/check.svg")`） |
| 表格 | `QTableWidget`、`::item`、`::item:selected`、`QHeaderView`、`QHeaderView::section`、`QTableCornerButton::section` |
| **行高** | `QHeaderView#verticalHeader { qproperty-defaultSectionSize: 24; }` |
| 滚动条 | `QScrollBar` 纵横（handle / hover / add-line / sub-line / add-page / sub-page） |
| **新增** | `QComboBox`、`QComboBox::drop-down`、`QComboBox QAbstractItemView`（弹窗选中色）、`QAbstractSpinBox`/`QSpinBox`、`QAbstractItemView` 选中色、`QMenu::item:selected` |

新增那批是为设置界面准备的，且**是删除调色板之后唯一挡住 Fusion 蓝色高亮的防线**（Fusion 的默认 `Highlight` 是蓝的）。

### 4.3 `flat.qss` 与默认的差异

用于证明「一份文件 = 一套样式」，同时充当自定义样式的样板：

| 项 | traditional | flat |
|---|---|---|
| 行高 | 24 | 28 |
| 网格线 | `#e6e6e6` | `transparent` |
| 斑马纹 | `#f7f7f7` | `#ffffff`（等于底色，视觉上无斑马纹） |
| 表头 | 填充 `#f2f2f2` + 下边框 | 无填充，仅 1px 底边 |
| 圆角/边框 | 6px 圆角 + 完整边框 | 0 圆角，仅底边 1px |
| 留白 | 4/8 | 8/12 |

## 5. `theme.py` 新接口

```python
STYLES_DIR: Path            # app/ui/styles
ICONS_DIR: Path             # app/ui/styles/icons
DEFAULT_STYLE: str = "traditional"
CHECK_ICON: str             # ICONS_DIR/check.svg 的 posix 绝对路径（测试用）

# 保留：Qt 布局 API 只认数字，QSS 管不到布局
SPACE_XS/SM/MD/LG/XL, WINDOW_MARGINS, LAYOUT_SPACING
TABLE_MIN_VISIBLE_ROWS = 4
TABLE_MIN_HEIGHT_EXTRA = 40

def available_styles() -> list[tuple[str, str]]     # [(key, 显示名)]
def load_stylesheet(style: str | None = None) -> str  # 未知/缺失 → 回退 DEFAULT_STYLE
def apply_style(app, style: str) -> None             # app.setStyleSheet(load_stylesheet(style))
def apply_light_theme(app, style: str = DEFAULT_STYLE) -> None  # Fusion + apply_style + 窗口图标
def app_icon() -> QIcon                              # 程序绘制，保持不变
```

行为细节：

- `load_stylesheet` 把 `url("相对路径")` 按**该 .qss 文件所在目录**解析为绝对 posix 路径再交给 Qt（Qt 不按样式表文件位置解析相对路径）
- 未知样式名、文件不存在、读取失败（OSError/UnicodeDecodeError）→ 回退 `DEFAULT_STYLE`；连默认样式都读不到 → 返回空字符串（Qt 接受空样式表，界面可用但无样式）。装载器不弹窗、不报错、不写日志到界面
- `app_icon()` 保持程序绘制，但配色从令牌改成 `Qt.GlobalColor.black` / `Qt.GlobalColor.white`（这样 `theme.py` 里不留任何颜色字面值；图标是 64px 方形近黑底 + 白字「AI」，改成纯黑在视觉上无差别）
- 删除：`BASE_QSS`、`DIRECTION_QSS`、`stylesheet()`、全部颜色令牌（`BACKGROUND`/`SURFACE*`/`BORDER*`/`GRID`/`HEADER_BG`/`ZEBRA`/`TEXT*`/`INK*`）、`RADIUS`、`STATUS_COLORS`、`BOLD_STATUSES`、`FONT_FAMILIES`、`FONT_SIZE*`、`base_font`、`section_font`、`ink_color`、`light_palette`、`status_color`、`status_is_bold`、`TABLE_ROW_HEIGHT`、`TABLE_GRID`、`TABLE_ZEBRA`
- `stylesheet()` 的调用方改为 `load_stylesheet()`（`tests/test_theme.py`；`main.py`/`tests/conftest.py` 走 `apply_light_theme`）

## 6. `main_window.py` 的连带改动

| 位置 | 改动 |
|---|---|
| `_fill_row` | 删除 4 处逐项着色/加粗（`suffix_item`/`status_item` 的 `setForeground`、`status_item.setFont`、数字列的 `setForeground`） |
| `_set_status` | 不再切换字体（取消「出错加粗」） |
| 表格构造 | 删除 `setDefaultSectionSize(TABLE_ROW_HEIGHT)`；改为 `verticalHeader().setObjectName("verticalHeader")`（让 QSS 精确命中）；`setShowGrid(True)`、`setAlternatingRowColors(True)` 写死（外观交给 QSS） |
| 表格最小高度 | 新增 `_sync_table_min_height()`：`defaultSectionSize() * TABLE_MIN_VISIBLE_ROWS + TABLE_MIN_HEIGHT_EXTRA`；在 `showEvent` 与应用样式之后调用（QSS 的行高要 polish 后才可读） |

## 7. 视觉变化（用户已确认放弃）

QSS 无法按单元格数据着色（见 §2），因此以下 5 处区分消失：

| # | 位置 | 原样 | 之后 |
|---|---|---|---|
| 1 | 扩展名列 | 弱化灰 | 正文色 |
| 2 | 添加/删除行数列 | 弱化灰 | 正文色 |
| 3 | 未跟踪行状态列 | 弱化灰 | 正文色 |
| 4 | 冲突行状态列 | 加粗 | 常规 |
| 5 | 状态栏出错 | 加粗 | 常规（仍有「错误：…」文字 + 错误对话框） |

除这 5 处外，`traditional.qss` 必须与改动前**逐像素一致**。

## 8. 测试策略

### 8.1 `tests/test_theme.py`（重写）

| 测试 | 断言 |
|---|---|
| `test_every_style_is_grayscale` | 遍历 `available_styles()`，对每个文件文本里所有 `#hex` 断言 `r == g == b`；且样式数 ≥ 2 |
| `test_no_leftover_token_placeholders` | 所有 `.qss` 不含 `\{[A-Z_]+\}` 形式的残留占位符（不再插值，残留会被 Qt 静默忽略） |
| `test_url_refs_resolve_to_existing_files` | `load_stylesheet()` 结果里每个 `url("...")` 都是存在的绝对路径；`Path(CHECK_ICON).is_file()` |
| `test_style_label_comes_from_first_line_comment` | `traditional.qss` 的显示名为「传统框感」；去掉注释则回退文件名 |
| `test_unknown_style_falls_back_to_default` | `load_stylesheet("nope") == load_stylesheet(DEFAULT_STYLE)` |
| `test_broken_style_file_does_not_crash` | 在临时 styles 目录放语法垃圾 + 放一个非 UTF-8 文件 → 不抛异常、回退默认 |
| `test_apply_light_theme_forces_light` | `app.style() == "Fusion"`、`app.styleSheet() == load_stylesheet(style)`、窗口图标非空 |
| `test_window_renders_white` | 建主窗口 grab → 像素 `(5,5)` 为 `#ffffff`（**替代原调色板断言，测的是真正渲染出来的东西**） |
| `test_style_owns_row_height_grid_and_zebra` | traditional：行高 24、存在 `#e6e6e6` 网格像素、存在 `#f7f7f7` 斑马像素；flat：行高 28、两者像素为 0 |
| `test_min_table_height_follows_style` | 应用样式后 `minimumHeight() == defaultSectionSize() * 4 + 40` |
| `test_main_applies_light_theme` | 更新为接收 style 参数（`main.py` 的调用签名变了） |

### 8.2 `tests/test_main_window.py`（调整）

- 删除状态列颜色/字重断言（`test_numeric_columns_right_aligned_and_status_monochrome` 只留对齐断言，并改名去掉 `monochrome`）
- `_indicator_box` 判断勾选框描边的灰度参考，改为从 `load_stylesheet()` 文本里正则取 `QCheckBox::indicator` 的 border 色（`theme.TEXT_MUTED` 已删）

### 8.3 手工验收

1. `python -m pytest -q` 全绿
2. 改动前后各截一组图（`%TEMP%\opencode\shot.py`，四状态）逐像素比对：只允许 §7 那 5 处差异
3. 往 `app/ui/styles/` 丢一个新 `.qss` → 不重启程序也能出现在 `available_styles()` 里（设置界面阶段验证可视化）
4. 真机冒烟：启动、切样式（阶段二后）、提交路径不受影响

## 9. 错误处理

| 场景 | 行为 |
|---|---|
| 样式名未知 / 文件缺失 / 不可读 | 回退 `DEFAULT_STYLE`，不中断启动 |
| 默认样式也读不到 | 空样式表（界面可用但无样式），不中断启动 |
| `.qss` 语法错误 | Qt 静默容忍（部分规则失效），不做校验；设置界面阶段靠「实时预览 + 取消还原」兜底 |
| 样式未写行高规则 | 用 Qt 默认行高；最小高度按实际 `defaultSectionSize()` 计算，不会截半行 |
| 样式写了非灰阶色 | 由 `test_every_style_is_grayscale` 拦住内置样式；用户自定义样式不在测试范围 |

## 10. 验收标准

- 四状态截图与改动前逐像素一致，仅 §7 的 5 处差异
- `available_styles()` 反映目录内容，新增 `.qss` 无需改代码
- `theme.py` ≤ 100 行，且不含任何颜色字面值 / `#hex`（唯一例外：窗口图标用 `Qt.GlobalColor.black` / `white`）
- 全部测试通过，无 `{TOKEN}` 残留、无 `url()` 未解析

## 11. 风险

| 风险 | 缓解 |
|---|---|
| 删掉调色板后，QSS 未覆盖的控件（下拉弹窗、菜单、消息框）漏出 Fusion 蓝色 | §4.2「新增」那批规则 + 测试里抓弹窗像素断言无彩色（阶段二补强） |
| `qproperty-defaultSectionSize` 依赖 polish 时机，取值可能滞后 | 最小高度在 `showEvent` 与样式应用后各同步一次；测试断言实际值 |
| 用户自定义样式把界面弄到不可读 | 设置界面实时预览 + 取消还原；README 写明删文件或改 `ui.style` 即可回退 |
| `.qss` 里的相对 `url()` 在不支持的环境失效 | 装载器统一转绝对路径 + 测试覆盖 |
