# 流式显示 AI 思考 · 设计文档

- 状态：已实施（本文已按实际实现回填；以代码为准）
- 日期：2026-09-24
- 前置：`2026-09-17-electron-rewrite-design.md`（本功能在其之上增量）

## 1. 背景与目标

现在点「AI 生成」是一次请求、拿到完整结果（`ai.ts` 写死 `stream: false`）：生成期间界面只有一个「正在生成…」，用户看不到模型在做什么，思考模型（Qwen3 / DeepSeek-R1 这类）动辄几十秒到几分钟，观感像卡死。

更糟的是：`ai.ts:23` 的 `stripThink()` 会把正文里的 `<think>…</think>` **剥掉再丢弃**——思考内容被静默扔了，用户根本不知道模型想过什么。

目标：**边生成边流式显示**两路内容——
1. **思考**（如果有）：实时滚进输入框下方一块可折叠的「AI 思考」区；
2. **正文**：实时落进提交信息输入框（打字机效果）。

### 已确认的决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 形态 | **真流式**（`stream: true` + SSE 增量推送），不是「生成完再展开」 | 用户要的是「过程」，只有流式才是过程 |
| 思考来源 | 三种都兼容：`delta.reasoning_content` / `delta.reasoning` / 正文内联 `<think>…</think>` | 服务端加不加 `--reasoning-parser` 决定走哪种，不能假设 |
| 解析位置 | **`core` 里手写 SSE 解析**，不引依赖 | 「核心逻辑零运行时依赖」是硬约束 |
| 思考/正文分离 | **`core` 里的增量分离器状态机**（纯函数，可穷举单测） | 标签会被切在两个 chunk 之间，正则每帧重扫既浪费又会错 |
| 正文落输入框 | **实时落**，生成中输入框 `readOnly` | `render.ts:55` 每次 paint 都用 `state.message` 覆写，实时落天然可行；只读避免 paint 冲掉用户正在打的字 |
| 界面位置 | 输入框**正下方**可折叠区（`<details>`），`max-height` + 滚动 | 放右侧会与「看 diff」抢地方；不限高会把变更列表挤下去 |
| 无思考时 | 整块**不出现**（不占位、不显示空框） | 用非思考模型时界面不该多一块没用的东西 |
| 取消 | **不弹错误框**，保留已收到的内容 | 顺手修掉现状缺陷：取消后 `generate()` 会走到 `showError` 弹「AI 请求失败：This operation was aborted」（代码路径唯一，无 abort 特判） |
| 超时 | 从「总时长上限」改为**空闲超时** | 总时长上限会把长思考截死在半路，而用户恰恰要长思考 |
| `chat_template_kwargs` | 新增可选配置 `api.enable_thinking`，**默认不填=不发** | Qwen3 在 SGLang 上有时需要它才吐思考；默认不发就不会弄坏别的服务 |

### 非目标

- 不做多轮对话、不做「让 AI 改提示词重生成」、不做思考内容的保存/导出/复制按钮
- 不改内置 diff 面板、不改提交逻辑
- 不引任何运行时依赖（含 SSE 解析库）
- 不支持 macOS/Linux（仅 Windows）
- 不做「思考折叠状态记忆」（每次生成重置为展开）

## 2. 现状（读代码确认）

| 事实 | 位置 |
|---|---|
| 一次请求，`stream: false` | `src/core/ai.ts:83` |
| `<think>…</think>` 被剥掉丢弃 | `src/core/ai.ts:23,26,128` |
| `message.reasoning_content` 完全没读 | `src/core/ai.ts:127` |
| 输入框每次 paint 由 `state.message` 覆写 | `src/renderer/render.ts:55` |
| 生成中只禁用按钮，**输入框没禁用** | `src/renderer/render.ts:125` |
| 无「主进程 → 渲染层」增量通道 | `src/shared/ipc.ts`（全是 invoke/handle） |
| 超时是 `AbortSignal.timeout(整段)` | `src/core/ai.ts:93` |
| 取消只 abort，错误没被特判 | `src/main/ipc.ts:104`、`src/renderer/main.ts:183` |
| 已有假 AI 服务可复用（非流式） | `tests/e2e/app.spec.ts:212`（用例③） |
| `FetchLike` 只声明 `{status, text, json}` | `src/core/ai.ts:18` |

## 3. 被否方案

| 方案 | 否掉的原因 |
|---|---|
| 渲染层直接 `fetch` AI 服务 | CSP 是 `default-src 'self'`，根本不放行；且会把 API Key 暴露给渲染层 |
| 主进程把原始 SSE 透传给渲染层解析 | 渲染层要懂协议、安全面变大；解析逻辑进不了 core 的单测 |
| 每帧拿累积全文重跑 `stripThink` 正则 | 跨 chunk 的半个标签照样错；且每帧 O(n) 重扫 |
| 只在结束时分离思考（非流式） | 那就没有「过程」了，与目标相悖 |
| 引 `eventsource-parser` 之类的库 | 违背「核心零运行时依赖」 |
| 思考区放右侧 diff 面板 | 与「选中文件看 diff」抢同一块空间，且 diff 面板可能空着或被隐藏 |
| 思考用弹层显示 | 打断主流程，没法边看思考边编辑 |

## 4. 组件与接口

### 4.1 新增 `src/core/sse.ts`——字节流 → 事件

```ts
export interface SseReadResult {
  /** 收到的 `data:` 事件数（`[DONE]` 不算） */
  dataEvents: number
  /** 累积的原文（供「content-type 说是 event-stream、其实是 JSON」兜底） */
  raw: string
}
export interface SseReadOptions {
  /** 每读到一块字节回调一次（空闲超时靠它重置计时） */
  onActivity?: () => void
  /** 中止时取消读流，让挂着的 read() 立刻收尾 */
  signal?: AbortSignal
}
/** 把 SSE 字节流逐事件喂给 onData；返回时表示流正常结束。 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
  options?: SseReadOptions,
): Promise<SseReadResult>
```

**职责边界**：SSE 层只管切帧，`onData` 拿到的就是 `data:` 后的原始字符串；**不做 JSON 解析**——JSON 解析、坏帧的跳过（不抛）都在 `ai.ts`（见 §4.3）。`signal` 中止时取消读流，否则永不 close 的流会让空闲超时一直等下去。

规则（逐条都要单测）：

- 用 `getReader()` 读字节，累积成 `Buffer`，**用 `TextDecoder("utf-8", { stream: true })` 增量解码**——否则一个中文字被 chunk 切开就会变成 `U+FFFD`（中文必须正确）。
- 按 `\n` 切行，去掉行尾 `\r`；**最后一行不完整时留在缓冲里等下一 chunk**，不能当完整行处理。
- 逐行判定：
  - 空行 → 事件边界，忽略（本实现逐行处理 `data:`，不攒多行 data）。
  - 以 `:` 开头 → 注释/心跳（如 `: ping`），忽略。
  - 以 `data:` 开头 → 取冒号后内容，**去掉一个可选的前导空格**；`[DONE]` 表示流结束（返回）；否则当作 JSON 文本交给调用方。
  - `event:` / `id:` / `retry:` → 忽略。
- 解码器冲刷（`decoder.decode()` 无参调用）在流结束时执行一次，防最后一个多字节字符被留在缓冲。

### 4.2 新增 `src/core/think.ts`——增量思考分离器

```ts
export interface ThinkParts { thinking: string; text: string }
export class ThinkSplitter {
  /** 喂一段正文增量，返回本段里属于思考/正文的部分。 */
  push(chunk: string): ThinkParts
  /** 流结束时调用：把「未定前缀」按当前状态归还（不吞字）。 */
  flush(): ThinkParts
}
export function createThinkSplitter(): ThinkSplitter
```

状态机规则（这是全功能最容易错的地方）：

- 状态只有 `inThinking: boolean` 与 `pending: string`（未定前缀：可能是标签开头、也还可能是正文）。
- **标签前的未定前缀**：当前面出现 `<`、`<t`、`<th`… 这类「是 `<think>` 的真前缀但还没收全」的尾巴时，**既不吐给正文也不吞掉**，留进 `pending` 等下一 chunk。只有确定不是标签前缀才归正文。
- 收全 `<think>` → 进入思考态；收全 `</think>` → 退出。
- 思考态里**不处理嵌套**：只找 `</think>`，其间出现的任何 `<think>` 都算思考文本。
- 一段正文里可以有**多个** `<think>…</think>` 块，思考全部拼接。
- `flush()`：思考态下 `pending` 归思考，否则归正文。
- **不吞字**：任何输入最终都能在 `thinking + text` 里找到（除了标签本身）。

### 4.3 改 `src/core/ai.ts`

```ts
export interface AiDelta { kind: "thinking" | "text"; text: string }

export interface GenerateOptions {
  signal?: AbortSignal
  fetchImpl?: FetchLike
  onDelta?: (delta: AiDelta) => void
  /** 流结束时的元信息（`finish_reason`）；**返回值仍是 `string`**，既有调用方不用动 */
  onFinish?: (info: { finishReason: string | null }) => void
  /** 空闲超时（毫秒）：这么久没收到任何字节才算超时。默认沿用 cfg.timeout 秒。 */
  idleTimeoutMs?: number
}

export type AiErrorReason = "aborted" | "timeout" | "http" | "bad_response" | "network"

export class AIError extends Error {
  /** 供上层区分：取消不该当错误弹框 */
  readonly reason: AiErrorReason
  /** 缺省 `"bad_response"` */
  constructor(message: string, reason?: AiErrorReason)
}
```

- `FetchLike` 扩展为 `{ status, headers?, text(), json(), body? }`。**`body` 缺失即视为非流式**——现有单测只提供 `text`/`json`，因此它们会自然走非流式分支、断言不用改。
- `generateCommitMessage` 一律发 `stream: true`，然后按响应判定：
  - **非流式** ＝ `Content-Type` 含 `application/json` **或**响应没有 `body` → 整体 `json()`，复用现有 `choices[0].message` 解析，把 `reasoning_content` / 内联 `<think>` 各发一次 `onDelta`（**非流式也不再静默丢弃思考**）；
  - 否则（`text/event-stream`）→ 走 SSE（§4.1），每个 `delta` 交给 §4.4 路由；
  - 兜底：`event-stream` 但整条流一个 `data:` 都没收到（`dataEvents === 0`）→ 把累积的 `raw` 当 JSON 再试一次（覆盖 content-type 乱写的服务）。
- 返回值仍是最终正文 `string`（= 流式累积的 text，两者按构造一致）。注意返回值经 `.trim()` 处理（`src/core/ai.ts` 末尾 `state.text.trim()`），而流式增量推给 `onDelta` 的 text 是不 trim 的。
- `AiConfig.enable_thinking?: boolean` 是**可选**字段（缺省＝不发，既有单测的最小配置不用改）；`AppConfig.api.enable_thinking` 才是必填、有默认值（§6）。
- `finish_reason` 经 `onFinish` 回报，**返回值仍是 `string`**——这样既有约 10 处 `expect(await generateCommitMessage(...)).toBe(...)` 断言无需改动。
- `onDelta` 可不传（单测/其它调用方），不传就丢弃增量。
- **每次请求新建一个 `ThinkSplitter`**；SSE 流结束时调一次 `flush()`，把结果按 `kind` 发出（防吞字）。
- 非流式分支的两次增量顺序固定为**先 thinking 后 text**（与流式观察到的顺序一致）。
- 保留 `stripThink` 并被非流式分支使用（既有测试不动）。

### 4.4 delta 路由（`ai.ts` 内部）

对每个 SSE 事件的 `choices[0].delta`：

| delta 字段 | 去向 |
|---|---|
| `reasoning_content`（string） | 直接 → `onDelta({kind:"thinking"})` |
| `reasoning`（string） | 同上（别名兼容） |
| `content`（string） | 喂 `ThinkSplitter.push()` → `thinking` 部分发 thinking 增量、`text` 部分发 text 增量 |
| `finish_reason` | 记下（判断 `length`） |

- 容忍 `delta` 缺失但有 `message` 的服务（按同一套字段名处理）。
- `reasoning_content` 与内联标签**不做去重**：服务端要么给字段要么留标签，不会两者同给（无法可靠去重的取舍，写进 README）。
- 中文/emoji 跨 chunk 由 §4.1 的增量解码保证，路由层只见完整字符串。

### 4.5 IPC 与 preload

- `shared/ipc.ts`：
  - `CHANNELS.aiDelta = "ai:delta"`；
  - `export interface AiDelta { kind: "thinking" | "text"; text: string }`（core 与三端共用，core 里 re-export）；
  - `IpcApi` 新增 `onAiDelta(cb: (delta: AiDelta) => void): void`。
- `main/ipc.ts`：`aiGenerate` **返回体是 `{ message: string; truncated: boolean; thinking: string }`**（不是裸 `{ message }`）。`message` 是核心返回的最终正文；`truncated` 来自 `onFinish` 的 `finishReason === "length"`；**`thinking` 由主进程 handler 从它自己已经经手的 `onDelta` 里累积**（`delta.kind === "thinking"` 时拼接）。`onDelta` 同时把每条增量 `win.webContents.send(CHANNELS.aiDelta, delta)`（只在窗口未销毁时发）。
  - **为什么主进程自己攒思考**：`src/core/ai.ts` **不**累积思考（其 `StreamState` 只有 `text` / `finishReason`）。非流式 JSON 响应下 `handle` 的 reply 会超过排队的 `ai:delta` 消息，渲染层的 `busy` 门会把这些思考增量丢掉；返回体带上 `thinking`，渲染层就能在成功时用返回值对账 `state.thinking` / `state.message`（§4.6）而自愈。**不得**用 `setImmediate` / sleep 之类的时序手法来缓解。
- `preload/index.ts`：`onAiDelta(cb)` → `ipcRenderer.on(CHANNELS.aiDelta, (_e, delta) => cb(delta))`。**不提供取消订阅**（整程序生命周期只订阅一次，YAGNI）。
- 取消映射为显式结果：用户 abort → `AIError(reason:"aborted")` → `guarded` 归一为 `{ ok: false, error: { code: "AI_CANCELLED", message: "已取消" } }`（`ErrorCode` 新增 `AI_CANCELLED`）。**渲染层见到 `AI_CANCELLED` 只改状态栏、不弹框。**

### 4.6 渲染层

- `shared/changes.ts` 之外的 `renderer/state.ts`：`UiState` 新增 `thinking: string`（初始 `""`）。
- 纯函数（放 `state.ts`，可单测）：
  ```ts
  export function applyAiDelta(
    current: { thinking: string; message: string },
    delta: AiDelta,
  ): { thinking: string; message: string }
  ```
  `kind:"thinking"` → 拼到 `thinking`；`kind:"text"` → 拼到 `message`。**思考永远不进 `message`。**
- `renderer/main.ts`：
  - `generate()` 开头 `state.thinking = ""`（每次生成重置，避免上一轮思考残留）；`state.message` 保持现状（会被流式正文逐步覆盖）；
  - `generate()` 成功后**用返回值对账**：`state.message = result.value.message`、`state.thinking = result.value.thinking`（非流式 JSON 下迟到的 `ai:delta` 可能被 `busy` 门丢弃，这里兜底自愈；**不得**用 `setImmediate` / sleep 之类的时序手法替代）；
  - 启动时 `api.onAiDelta((delta) => { const next = applyAiDelta(state, delta); state.thinking = next.thinking; state.message = next.message; paint() })`（`applyDelta` 里仍保留 `state.busy === "generate"` 门）。
  - **门的角色已退化**：它不再是「思考不丢」的正确性保证，而只是「**旧 run 的迟到增量不得污染新一轮**」的护栏；思考的最终正确性由上面的返回值对账兜底（验收标准 1、3）。
- `renderer/global.d.ts`：`window.api` 的类型同步加 `onAiDelta`。
- `renderer/render.ts`：
  - `#thinking` 的 `hidden` = `state.thinking === ""`；文本用 `textContent` 写入 `#thinking-body`；
  - 生成中（`busy === "generate"`）且有思考 → `details.open = true` 并滚到底（`scrollTop = scrollHeight`）；
  - `#message` 的 `readOnly = state.busy === "generate"`；
  - 生成结束（完成/取消/出错）时 `readOnly = false`，`thinking` 保留。
- `renderer/index.html`：`#message` 之后插入
  ```html
  <details id="thinking" hidden>
    <summary>AI 思考</summary>
    <pre id="thinking-body"></pre>
  </details>
  ```
- 主题：`tokens.css` 加 `--thinking-bg` / `--thinking-border` / `--thinking-fg`，浅色主题给值；外置主题不提供也有兜底值。

## 5. 行为细节

### 5.1 空闲超时

- 用**手动计时器 + `AbortController`**（`AbortSignal.timeout` 做不到空闲语义），与用户的取消信号 `AbortSignal.any` 合并。
- 计时器在**收到任何字节**时重置；连接建立后到第一个字节之间也算空闲（拿不到首字节即连接超时）。
- 超时 → `AIError(reason:"timeout")`，文案 `AI 请求超时：<N> 秒内没有收到任何数据`。
- `cfg.timeout` 的语义变成「空闲秒数」，README 的配置表同步改措辞。

### 5.2 取消与中断

| 情况 | 行为 |
|---|---|
| 用户点取消 | abort → `AI_CANCELLED` → 状态栏「已取消（已保留已收到内容）」；**保留**已到的思考与正文；不弹框 |
| 空闲超时 | 弹错误框（原因明确）；**保留**已到的思考与正文（不清空） |
| 网络中断 / 服务端提前关闭 | **有意不实现**提前收尾提示：`readSseStream` 在流关闭而未见 `[DONE]` 时按正常结束返回，不区分「正常收尾」与「提前关闭」（要区分须加 `sawDone` 标志）；本轮不做，验收标准也未要求 |
| HTTP 非 200 | 沿用现状：读 body 前 500 字，报错 |
| 整条流零有效内容 | `AIError("AI 未返回有效内容")` |

- 失败/取消后输入框恢复可编辑；**不清空已收到的内容**（现状是「出错保留、取消保留」，取消那条以前会因错误弹框而显得像失败，现修正）。
- 生成会把输入框内容**替换**为流式正文（与现状一致：生成结果覆盖输入框），首次增量到达时即开始覆盖。

### 5.3 finish_reason

- `finish_reason === "length"` → 状态栏「已生成（输出被 max_tokens 截断）」——否则用户会以为模型坏了。
- 其它值/缺失 → 正常「已生成，可编辑后提交」。

### 5.4 `api.enable_thinking`

- 配置项 `api.enable_thinking`（boolean，默认 `false`）。
- 为 `true` 时，请求体额外带 `chat_template_kwargs: { enable_thinking: true }`；为 `false` 时**完全不发**这个字段（不给严格服务 400 的机会）。
- 设置弹层「接口」组加一个复选框：「启用思考模式（发送 enable_thinking）」。

## 6. 配置与文档

- `core/config.ts`：`AppConfig.api.enable_thinking: boolean`，默认 `false`；`deepMerge` 自动补齐旧配置文件。
- 设置弹层的复选框行用 `.field.field-control`（`grid-template-columns: auto 1fr` + 复选框尺寸覆盖），不要塞进默认两栏表单的 84px 标签列：那样「启用思考模式（发送 enable_thinking）」会被折成三行、破坏表单对齐（实现期用截图发现并修的）。
- `README.md` 更新：`api.enable_thinking` 进配置表；`api.timeout` 措辞改为「空闲超时」；「使用」一节的「AI 生成」条目补流式正文 + 思考区说明（含「非思考版模型不会出现思考区」）。
- 思考内容**只在内存与界面**，不落盘、不写进提交信息。

## 7. 测试策略

### 单元

- `tests/core/sse.test.ts`：
  - **中文/emoji 跨 chunk**：把 `data: {"content":"你好🚀"}` 的字节流在**每个位置**切开，断言事件文本恒定、无 `U+FFFD`；
  - `\r\n` 与 `\n` 混用、结尾无换行、空行、`:` 心跳、`event:`/`id:` 行；
  - `[DONE]` 结束；坏 JSON 不归 SSE 层管（`ai.ts` 跳过、不抛）；返回 `dataEvents` 与累积 `raw`；`signal` 中止时取消读流且不把半行当事件；多个事件一 chunk；一个事件跨多 chunk。
- `tests/core/think.test.ts`：
  - 穷举切分：对一段含 `<think>` 的中文文本，**在每个位置切成 1..n 个 chunk**，断言 `thinking` / `text` 拼接结果与整段单次 `push` 完全一致；
  - 未闭合 `<think>`（流结束）→ 已收部分是思考、`pending` 归思考；
  - 多个思考块、标签前后有正文、嵌套 `<think>`、只有 `<`、只有 `<t`（未定前缀不吞字）；
  - 属性断言：`thinking + text` 一定覆盖原文的非标签字符。
- `tests/core/ai.test.ts`（既有文件扩展）：
  - 流式：假 fetch 返回 `ReadableStream` + `body` → 断言 `onDelta` 序列（thinking 与 text 各自有序）、返回值 = text 累积；`reasoning_content` / `reasoning` / 内联标签三种来源各一条；
  - 非流式（`body` 缺失，既有用例）**不回归**；非流式里带 `<think>` 时思考仍被发成 thinking 增量；
  - 空闲超时：假流在一段静默后无数据 → 用假定时器断言 `reason:"timeout"`；
  - 用户 abort → `reason:"aborted"`；`finish_reason:"length"` 被记录；零内容 → 报错；
  - `enable_thinking`：为 true 时请求体含 `chat_template_kwargs`，为 false 时**不含**该键。
- `tests/core/errors.test.ts`：`AI_CANCELLED` 的映射分支被覆盖。
- `tests/renderer/state.test.ts`：`applyAiDelta` 纯函数（思考不进 message、顺序拼装）。

### E2E（真 Electron）

- **改 ③**：假服务改为**按 SSE 分块**返回（思考用 `<think>` 内联 + 正文），断言思考进 `#thinking-body`、`#message` = 正文（不含思考）、`#thinking` 可见；提示词与 messages 的既有断言保持。
- **⑫ 真的在流式**：假服务**分块慢发**（每块间隔约 150ms，至少 3 块），在**未结束时**断言 `#thinking-body` 已含首段思考、`#message` 值已被写入首段正文、且 `#message` 处于只读——证明不是「完成时一次性填」。
- **⑬ 取消不弹框且保留内容**：慢发中途点「取消」→ 断言 `.modal-backdrop` 不可见、状态栏含「已取消」、`#thinking-body`/`#message` 仍保留已收到部分、`#message` 恢复可编辑。
- **⑭ 非流式回退**：假服务无视 `stream` 返回整体 JSON（`Content-Type: application/json`）→ 仍能生成（覆盖 content-type 判定分支）。
- 既有 14 条全绿。

## 8. 风险

| 风险 | 处理 |
|---|---|
| 中文被 chunk 边界切成乱码 | 增量 `TextDecoder` + 逐字节切分的穷举单测 |
| 标签跨 chunk 导致思考漏进正文（或吞字） | 分离器状态机 + 全位置穷举单测 |
| 长思考撑爆界面 / 挤走变更列表 | `#thinking-body` 限高 + 滚动；思考从不写进输入框 |
| 思考污染提交信息 | 分离器保证 text 不含思考 + 独立 DOM 节点 + 单测/ E2E 双证 |
| 模型是非思考版（如 Qwen3-*-Instruct-2507），思考区一直空着 | 界面表现为「不出现思考区」，不算故障；README 写明需要思考版模型或开 `enable_thinking`；交付说明里如实提醒 |
| 服务端不认 `stream: true` | content-type / JSON 兜底回退非流式（E2E ⑭） |
| 空闲超时语义变化让人困惑 | README 配置表改措辞；错误文案明说「N 秒内没有收到任何数据」 |
| 本机没有可用的思考模型服务，真机观感无法自动验证 | 单测（SSE/分离器穷举）+ E2E 假 SSE 服务作证；真机效果列为交付后人工项，**如实写明**（同 WinMerge 功能的处理） |

## 9. 验收标准

1. 勾选文件点「AI 生成」：思考在输入框下方的「AI 思考」区**边收边显示**并自动滚到底；正文**边收边落进输入框**（生成中可见半截）。
2. 生成中输入框只读；生成完成/取消/出错后恢复可编辑。
3. 模型不吐思考时，思考区**完全不出现**（不是空框）。
4. 思考内容**绝不**出现在提交信息输入框里，也绝不被提交。
5. 点「取消」：不弹错误弹层，状态栏「已取消（已保留已收到内容）」，已收到的思考与正文都还在。
6. 服务端返回非流式（无视 `stream`）时，功能照常可用（思考也进思考区）。
7. 思考超过 `api.timeout` 秒没有新数据才算超时；持续有数据就一直不被截断（服务端回整体 JSON 时按整段计时）。
8. `finish_reason` 为 `length` 时状态栏提示输出被 `max_tokens` 截断。
9. `api.enable_thinking: true` 时请求体带 `chat_template_kwargs.enable_thinking`；`false`（默认）时不带该字段。
10. 既有测试全绿：单元 153+ / E2E 14+（含改造后的 ③），`tsc --noEmit` 干净，`src/core` 聚合行覆盖 ≥ 90%。
