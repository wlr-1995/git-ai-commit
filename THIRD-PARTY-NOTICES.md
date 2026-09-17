# Third-Party Notices

本项目的 Git 变更分析与 AI 调用思路参考了以下 MIT 许可项目，代码为改写实现：

- **duolabmeng6/ai_git_commit_gui** — MIT — https://github.com/duolabmeng6/ai_git_commit_gui

以下项目仅作设计参考，未复制任何代码：

- **sourcegit-scm/sourcegit** — MIT — https://github.com/sourcegit-scm/sourcegit
- **gitextensions/gitextensions** — GPL-3.0 — 仅参考 UI/UX，未复制代码

## 打包产物内含的运行时

`npm run package` 产出的便携目录里包含 Electron 及其运行时依赖，由 electron-builder 原样打包，未做修改：

- **Electron** — MIT — https://github.com/electron/electron
- **Chromium** — BSD-3-Clause 及其它开源许可 — https://www.chromium.org/
- **Node.js** — MIT — https://nodejs.org/

各组件随包附带的许可证原文位于 `dist/win-unpacked/resources/` 与 Electron 的 `LICENSES.chromium.html`。

本项目已不再依赖 PySide6 / Qt。
