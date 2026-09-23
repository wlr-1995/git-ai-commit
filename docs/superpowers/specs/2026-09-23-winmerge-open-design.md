# 双击用 WinMerge 打开 · 设计文档

- 状态：待实施
- 日期：2026-09-23
- 前置：`2026-09-17-electron-rewrite-design.md`（本功能在其之上增量）

## 1. 背景与目标

内置 diff 面板是「文本行级」查看，够判断「改了什么」，但做不到 WinMerge 那种并排全文对照、逐块合并、忽略空白/大小写等。日常最自然的动作是**在变更列表里双击一个文件，用 WinMerge 看它跟 HEAD 的差异**。

目标：双击变更列表的一行 → 打开 WinMerge，**左侧 = HEAD 里的版本**，**右侧 = 工作区真实文件**。

### 已确认的决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 比什么 | HEAD ↔ 工作区 | 与「勾选即提交」的模型一致：提交的就是工作区相对 HEAD 的差异 |
| 触发 | **仅双击行** | 单击保持原语义（选中该行 + 右栏内置 diff）；不加按钮/右键菜单/Enter，避免与刚做的界面弱化方向相悖 |
| WinMerge 位置 | 配置 `tools.winmerge_path` → 注册表 → 常见路径；找不到报错 | 免安装场景不能假设路径固定 |
| 右侧 | **永远给工作区真实路径**（不落快照） | 在 WinMerge 里直接看/直接改真实文件才是本意 |
| 启动参数 | `WinMergeU /s /e /u <左> <右>` | 见 §5.2 |
| 已删除的文件 | 左侧 = HEAD 版临时文件，右侧 = 同扩展名**空文件占位** | 官方文档：路径不存在时 WinMerge 会打开「选择文件或文件夹」对话框 → 会多出一个窗口 |

### 非目标

- 不做三方对比、不做合并写回、不做「用别的工具打开」
- 不改内置 diff 面板的行为，不替代它
- 不支持 macOS/Linux（本工具仅 Windows）
- 不为 WinMerge 写配置文件/注册 difftool（只走命令行参数列表）

## 2. 为什么给不存在的路径不行（实证）

WinMerge 2.16 官方手册 *Command line* 原文：

> If WinMerge cannot find either of the specified paths, it opens the Select Files or Folders dialog, where you can browse for the correct paths.

所以「已删除的文件右侧给真实路径」会让用户额外得到一个「选择文件或文件夹」对话框窗口。空文件占位是**为了让这个对话框不出现**，不是随手取巧。

## 3. 被否方案

| 方案 | 否掉的原因 |
|---|---|
| 左右两侧都快照（都复制到临时文件） | 在 WinMerge 里「合并到右侧」不会写回工作区，与「右侧是真实文件」的本意相反 |
| 走 `git difftool` | 需要写用户的 git 配置、依赖 shell 与用户环境，违背本项目「git 只走参数列表、不碰用户配置」的原则 |
| 不落临时文件、用 `git show` 管道 | WinMerge 只认文件路径，不读标准输入 |
| 删除的文件不打开 | 用户明确要求「只打开一个窗口」，而空占位能让它照常工作；不打开反而丢功能 |

## 4. 组件与接口

### 4.1 新增 `src/core/winmerge.ts`

```ts
/** 找 WinMergeU.exe：配置优先，其次注册表，其次常见安装路径。返回绝对路径或 null。 */
export function detectWinMerge(configured: string, probe?: Probe): string | null

/** 一次对比该落哪些文件（纯函数，不碰磁盘，便于单测）。 */
export function comparePlan(
  change: { path: string; status: string; origPath: string | null },
  stageDir: string,
): { leftPath: string; leftFromHead: string | null; rightPath: string; rightEmpty: boolean }

/** 启动 WinMerge（detached，不等待）。 */
export function launchWinMerge(exe: string, left: string, right: string): void
```

- `Probe` 注入点（`exists`、`readRegistryInstallLocation`、`listCommonPaths`），让探测逻辑可单测，不在测试里依赖真实安装。
- 左值源：`leftFromHead = "HEAD:<path>"`（重命名时用 `origPath`）；`null` 表示左侧也写成空文件。
- 右侧：`rightPath = <repoRoot>\<path>`（真实路径）；`rightEmpty = true` 时（仅已删除）改成占位空文件。

### 4.2 状态 → 落盘计划

| 列表状态 | 左（HEAD） | 右（工作区） | 效果 |
|---|---|---|---|
| 已修改 `modified` | `git show HEAD:<path>` → 临时文件 | 真实路径 | 并排看改动 |
| 已重命名 `renamed` | `git show HEAD:<origPath>` → 临时文件 | 真实路径（新名） | 直接看到重命名 + 内容改动 |
| 已添加 `added` / 未跟踪 `untracked` | 空临时文件 | 真实路径 | 整文件新增 |
| 已删除 `deleted` | `git show HEAD:<path>` → 临时文件 | **空临时文件占位** | 整文件删除，且不弹「选择文件」对话框 |

- 临时文件路径：`%TEMP%\git-ai-commit\<pid>\<seq>\<原文件名>`。**保留原文件名**（WinMerge 按扩展名决定语法高亮），`<seq>` 是**本进程内的自增计数器**（每次双击 +1），避免同名文件互相覆盖。
- 左值为空文件时，用同样保留扩展名的方式建一个 0 字节文件。
- 左值一律**按字节写**：`git show` 的输出当 Buffer 原样落盘，不做 UTF-8 转码——二进制文件（图片、压缩包）才不会在打开前就被改坏；WinMerge 自己会识别二进制。
- `git show HEAD:<path>` 非 0 退出时（例如该路径其实不在 HEAD 里）按「左侧为空」处理，**不报错**：宁可少一边内容，也不拦着用户看 diff。

### 4.3 IPC

`CHANNELS.winmergeOpen = "winmerge:open"`

```ts
winmergeOpen(path: string): Promise<Result<void>>
```

- 渲染层只传**仓库内相对路径**（与 `diff:read` 同一套规矩，`resolveInsideRepo` 校验；绝对路径、`..` 越界、NUL 一律拒绝）。
- 主进程**不信任渲染层给的其它字段**：自己 `listChanges(repoRoot)` 重新查出这条记录拿 `status` / `origPath`；查不到（列表已过期）返回 `PATH_INVALID`（文案：请先按 F5 刷新）。
- 新错误码：`WINMERGE_NOT_FOUND`、`WINMERGE_LAUNCH_FAILED`。

## 5. 行为细节

### 5.1 触发

- `src/renderer/render.ts` 的行事件里加 `dblclick`；**事件源是勾选框（`input[type=checkbox]`）时直接返回**，否则双击会连带切换勾选。
- 单击逻辑一行不动（选中行 + 内置 diff）。
- 表格空白处/表头双击无动作。

### 5.2 启动参数与进程

```
"<WinMergeU.exe>" /s /e /u "<左>" "<右>"
```

| 参数 | 作用（官方手册原文要点） |
|---|---|
| `/s` | `Limits WinMerge windows to a single instance` —— 重复双击复用同一个窗口，不会越开越多 |
| `/e` | `Enables you to close WinMerge with a single Esc key press` —— 当外部工具用时的惯例 |
| `/u` | `Prevents WinMerge from adding either path to the Most Recently Used (MRU) list` —— 我们落的是临时文件，不该污染它的最近列表 |

- `spawn(exe, ["/s", "/e", "/u", left, right], { detached: true, stdio: "ignore" })` + `unref()`：**不等待、不阻塞界面**，WinMerge 的生命周期与主程序无关。
- 不用 shell，参数以数组传递 → 含空格/中文的路径无需转义。

### 5.3 临时文件生命周期

- 目录按**进程 pid** 隔离：`%TEMP%\git-ai-commit\<pid>\`，避免多开实例互删。
- `app.on("will-quit")` 递归删除本进程目录，**尽力而为**：WinMerge 还开着文件时删除会失败，忽略错误、不拦退出。
- 不主动清理别的 pid 目录（YAGNI；`%TEMP%` 本身由系统清理）。

### 5.4 错误处理

| 情况 | 错误码 | 弹层文案 |
|---|---|---|
| 找不到 WinMerge（含配置指向了不存在的文件） | `WINMERGE_NOT_FOUND` | `未找到 WinMerge。装一个，或在设置里填写 WinMergeU.exe 的路径。`（配置过就补一句：`当前配置的路径是 <path>`） |
| spawn 抛错（权限、损坏的 exe） | `WINMERGE_LAUNCH_FAILED` | `WinMerge 启动失败：<原因>` |
| 路径不在仓库内 | `PATH_INVALID` | 沿用现有文案 |
| 列表里已没有该路径 | `PATH_INVALID` | `变更列表已过期，请按 F5 刷新后重试。` |

- 失败一律**不改动**勾选状态与提交信息。

## 6. 配置

新增 `tools.winmerge_path`（默认 `""` = 自动探测）。

- 设置弹层加一组「工具」，一个文本输入框：`WinMerge 路径（留空自动查找）`，placeholder 提示 `如 C:\Program Files\WinMerge\WinMergeU.exe`。
- 不参与现有「接口地址不能为空」那类校验（留空合法）。
- `config.ts` 的 `deepMerge` 自动补默认值，旧配置文件缺该键时回落到 `""`。

## 7. 测试策略

### 单元

- `comparePlan`：四种状态（modified / renamed / added+untracked / deleted）各自的左右落盘计划；空值侧一定是 0 字节占位且**保留扩展名**；`<seq>` 递增不覆盖。
- `detectWinMerge` 优先级：**配置了 `tools.winmerge_path` 就只认它**（存在才用；不存在直接返回 `null` → 报 `WINMERGE_NOT_FOUND`，错误文案带上配置的路径）。这样「改错了路径」会明说，而不是悄悄换成机器上另一个安装；顺带让「路径填错」的用例在任何机器上都确定复现。未配置时：注册表 InstallLocation → 常见安装路径 → 都没有返回 `null`。
- `launchWinMerge` 参数顺序：`/s /e /u` 在路径之前，左在右之前（用注入的 spawn 断言 argv，不真启动）。

### E2E（真 Electron）

1. **能真的拉起来 + 左值确实取自 HEAD**：把 `tools.winmerge_path` 指向 `node.exe`，仓库里放 `probe.js`——HEAD 版内容写 `HEAD`、工作区版写 `WORKTREE`，脚本把读到的自身内容写到一个标记文件。双击该行后断言标记文件里是 **`HEAD`**。这一条同时证明：配置路径被使用、左值来自 `git show HEAD:`、左右参数顺序正确、进程真被拉起。
2. **双击不切换勾选**：双击已勾选的行，勾选框仍为勾选；双击未勾选的行，仍为未勾选。
3. **找不到 WinMerge 时弹错误弹层**：`tools.winmerge_path` 指向不存在的路径（因此必然判定为找不到，与本机是否装了 WinMerge 无关），断言出现 `WINMERGE_NOT_FOUND` 文案，且勾选与提交信息不变。
4. **退出清临时目录**：双击后 `%TEMP%\git-ai-commit\<app pid>` 存在；`app.close()` 后该目录不存在（用 `app.process().pid` 定位）。

## 8. 风险

| 风险 | 处理 |
|---|---|
| 本机没装 WinMerge，真机观感无法自动验证 | E2E 用假 WinMerge（`node.exe`）覆盖「拉起 + 左值正确 + 参数」；真机效果列为交付后人工确认项 |
| WinMerge 版本差异（老版本不支持 `/s`） | 参数是官方 2.16 手册记载项；不支持的版本最多忽略未知参数。若实测有老版本报错，退路是只传 `/e /u`（一次改动） |
| `%TEMP%` 清理失败导致残留 | 尽力而为 + 按 pid 隔离；不影响功能，且系统会清 `%TEMP%` |
| 双击与勾选框/dblclick 语义冲突 | 事件源判断 + E2E ② 覆盖 |
| 大文件左值写临时文件耗时 | 左值已由 `git show` 产出，仅一次写盘；工作区侧重命名/未跟踪文件另有 1 MB 上限（`diffOne` 既有逻辑），不受本功能影响 |

## 9. 验收标准

1. 双击已修改文件的行 → 打开 WinMerge：左侧 `HEAD` 版、右侧工作区文件；按一次 Esc 关闭。
2. 连点多个文件 → 始终只有一个 WinMerge 窗口（内容被替换）。
3. 已删除文件双击 → 左侧有内容、右侧空白，**不出现**「选择文件或文件夹」对话框。
4. 新增/未跟踪文件双击 → 左侧空白、右侧完整内容。
5. 重命名文件双击 → 左取旧路径的 HEAD 版，右取新路径。
6. 双击勾选框不会改变勾选状态；单击行为与现在完全一致。
7. `tools.winmerge_path` 留空且系统没装 WinMerge → 弹「未找到 WinMerge」错误弹层，界面其它状态不被改动。
8. 退出程序后 `%TEMP%\git-ai-commit\<pid>` 被清掉（WinMerge 未占用时）。
9. 既有测试全绿：单元 117+ / E2E 10+，`tsc --noEmit` 干净。
