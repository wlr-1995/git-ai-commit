# AGENTS.md

Windows 桌面小工具：在资源管理器里右键一个 Git 仓库目录 → 勾选文件 → AI 写提交信息 → 提交；可看 diff、双击用 WinMerge 对比。
`README.md` 是用户向的权威说明（安装、配置表、快捷键、交付方式）——改行为时同步更新它，不要把它的内容抄进本文件。

## 命令

**没有 linter / formatter / CI**（无 eslint、prettier、`.github`）——唯一的门是 `npm run typecheck` + 测试。

```powershell
npm run typecheck   # tsc --noEmit，提交前必跑
npm test            # vitest run：tests/**/*.test.ts（node 环境）
npx vitest run tests/core/winmerge.test.ts               # 单个文件
npx vitest run tests/core/winmerge.test.ts -t "找不到"     # 单个用例
npm run coverage    # 覆盖门：src/core/** 聚合行覆盖 >= 90%（npm test 本身不跑覆盖率）
npm run e2e         # 先 electron-vite build，再 Playwright 驱动真 Electron（约 20s，workers:1）
npm run dev         # 开发模式（渲染层热更新）
npm run shots       # 抓界面截图到 %TEMP%\electron-shots\
npm run package     # -> dist\win-unpacked\（便携目录，约 368MB）
```

安装/校验右键菜单：`pwsh -NoProfile -File install\install.ps1`，随后 `install\verify.ps1`、`install\verify-launch.ps1`（后者真启动并核对窗口标题）。

## 架构硬约束（破坏前先想清楚）

- `src/core/**` 是纯逻辑：**不得 import electron 或 renderer**，只能 `src/shared/**`。这是靠自觉的约定，**没有测试强制**，破了不会立刻红。
- 所有 git 调用走 `runGit`（`src/core/gitcmd.ts`）：`spawn` + argv 数组，**禁止拼 shell 字符串**。统一带 `-c core.quotepath=false`（中文路径）与 `GIT_LITERAL_PATHSPECS=1`（文件名里的 `*?[` 不当通配）。用 `spawn` 而非 `execFile`：后者 1MB maxBuffer 会截断大仓库的 status。
- 要写盘的二进制用 `stdoutBuffer`（原始字节），不要用 utf8 解码后的 `stdout`（图片/压缩包会被改坏）。
- IPC 一律返回 `Result<T>` 判别联合（`src/core/types.ts`），**不跨进程抛异常**（Electron 序列化会丢 Error 字段）。加通道要同时改 `src/shared/ipc.ts`（`CHANNELS` + `IpcApi`）+ preload 的唯一实现。
- 渲染层无 Node（`contextIsolation` + `sandbox`），只能经 preload 白名单；渲染层传来的只有**仓库内相对路径**，主进程必须自己 `resolveInsideRepo` 校验并重新 `listChanges` 取文件（不信渲染层其它字段）。diff 一律 `textContent` 写入。
- 逻辑尽量做成可测纯函数（`renderer/state.ts`、`renderer/components/`），DOM 操作留在 `renderer/render.ts`；`tests/renderer/` 测的就是这些纯函数。

## Windows / PowerShell 坑（都踩过）

- `install/*.ps1` 与 `install/*.cmd` **必须保持 UTF-8 BOM**：目标机器默认只有 Windows PowerShell 5.1，无 BOM 时中文全是乱码。编辑后确认 BOM 还在。
- 这些脚本按**自身所在目录**定位 exe，所以经 `electron-builder.yml` 的 `extraFiles` 被拷进便携目录；`-Dir` 只用于纯脚本部署。
- 把 git 输出重定向到文件前先 `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8`，否则写盘的是被 GBK 解码后的乱码。

## 测试约定

- 临时仓库 helper 在 `tests/helpers/repo.ts`（`initRepo*` / `commitAll` / `porcelain`…），单测别自己拼 git 命令。
- 仅测试用的环境变量：`GIT_AI_COMMIT_CONFIG`（覆盖配置文件路径）、`GIT_AI_COMMIT_NO_DIALOG=1`（错误只写 stderr，不弹原生框）。
- E2E 起真 Electron + 真临时仓库：`electron.launch({ args: [".", repo], env })` —— **仓库路径是 argv[1]**（打包后也是从 argv 取，见 `main/index.ts` 的 `resolveStartPath`）。
- 本机通常**没装 WinMerge**，E2E 用 `process.execPath`（node.exe）冒充。node 会把首个参数 `/s` 当脚本，故改用**小写 `node_options=--require=<boot>`**（Playwright 会 `delete env.NODE_OPTIONS`，换个大小写恰好绕过）。boot 目录只能在 `beforeAll` 里建：Playwright 收集阶段会在主进程也求值一遍本文件，顶层建的没人清。
- 假 WinMerge 的标记文件里出现 `HEAD` / `WORKTREE` 才证明「左=HEAD、右=工作区」两边都真读到了。
- `app.process().pid` 是 Windows 上 cmd.exe 包装进程，不是 Electron 主进程 —— 要进主进程问：`app.evaluate(() => process.pid)`。

## 交付 / 运行

- 便携交付物是 `dist\win-unpacked\` **整个目录**（只拷 exe 会缺 dll / `resources` / `locales`）；目录挪位后要**重新双击一次**「安装右键菜单.cmd」（注册表里存绝对路径）。免管理员，只写 `HKCU\Software\Classes`。
- 配置在 `%USERPROFILE%\.git_ai_commit\config.json`（API Key 明文，见 README 表）；主题是 `themes\*.css` 外置文件。
- `src/core/config.ts` 只在 `ui.window_width/height` **恰好等于旧 Python 版默认 720×520** 时升级到 1100×640，其它值原样保留 —— 别放宽这段迁移。

## 仓库 / 文档

- **无远端**，改动直接提交到 `master`（无 feature 分支、无 PR）。`out/`、`dist/`、`coverage/`、`test-results/`、`.vitest/` 均已忽略。
- 本仓库**没有 `.codegraph/` 索引** —— 直接 grep/glob 搜即可。
- 旧 Python 版已彻底删除（磁盘上没有任何 `.py`）。若编辑器仍报 `tests/test_*.py`、`app/*.py` 的 import 错误，那是**陈旧 LSP 缓存**，别去创建这些文件。`.pytest_cache/` 只是空壳残留。
- `docs/superpowers/specs|plans/` 是设计文档与实施计划（`日期-主题.md`）；`.superpowers/` 是执行台账与评审包暂存区，由内部 `.gitignore`（内容 `*`）整体忽略 —— **别提交，也别当垃圾清掉**。
- 界面文案与注释都是中文；注释写「为什么」（多是 Windows / Electron 的非显然取舍），不是「做了什么」。沿用这个风格。
