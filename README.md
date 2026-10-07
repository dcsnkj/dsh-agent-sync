# dsh-agent-sync

> 让 **DeepSeek Harness (DSH)** 与 **Codex**、**WorkBuddy** 互相看见对方在同一个实验里做了什么。

你在同时用好几个 coding agent 推进**同一批实验**时，真正的痛点不是"模型不够强"，
而是**上下文困在另一个窗口里**。这个插件解决这件事：三方共用一条事件总线，
彼此实时看见对方改了什么文件、跑了什么命令、得出什么结论，
并且可以把其中一方的活**无缝接过来继续干**。

三个 agent 在同一台机器、同一个工作目录里推进时，最容易出的问题是：
重复改同一个文件、重复跑同一条命令、基于过期的假设继续往下做。
这个插件把三方的**聊天记录 + 关键操作**汇到一条共享总线上，实时互相注入，并提供一个
动手前的「防重复闸门」；每个聊天还能独立开关同步。

> **这是 DSH 的树外插件**，走官方支持的扩展点安装，**不需要 fork 或修改 DSH 本体**。
> 属于 DSH 生态的 `dsh-plugin`。

---

## 它到底做了什么

| 能力 | 机制 |
|---|---|
| **实时同步 Codex / WorkBuddy 的聊天与操作** | 只读跟随 `~/.codex/sessions/**.jsonl` 与 `~/.workbuddy/projects/**/*.jsonl`，解析成统一事件，追加进共享总线 |
| **我能沿着它们的足迹回答你** | `agent_chat`：按参与方/时间/关键词/类别检索真实记录，而不是我猜 |
| **盯住某一条对话（分支旁路）** | `agent_target` 绑定一条外部会话；之后 `agent_chat(deep=true)` 直接深读该会话的**完整历史文件** |
| **接着它把活干完** | `agent_handoff` 生成交接简报：目标、已改动文件、命令与失败、最后一次结论、还没做完的点 |
| **它们能看见我的操作（双向）** | 我的工具调用、结论、命令、改动的文件自动写进总线；再物化成 `inbox/<agent>.md` 供 Codex / WorkBuddy 读取 |
| **实时注入，不用你复述** | `systemPrompt.context` 每步重算 → 对方的新动作直接出现在我当前上下文里；有新事件时额外 `agent.inject` 一条 notice |
| **防重复、防冲突** | `agent_write(action="check")`：改文件/跑命令前先问「别人是不是刚做过」，命中就报冲突 |
| **每个聊天独立可切换** | `sync_mode`：`off`（只留自己的记录）/ `read`（只看对方）/ `write`（只推自己）/ `both`（双向，默认） |

---

## 三种典型用法

### A. 分支旁路查询（主窗口不停）

Codex 在跑一个长实验，你在 DSH 这边问细节：

```
（你说）盯着 Codex 那个 Stage 1 的对话，它的接触窗口实验参数是怎么改的？
```

我会 `agent_target(action="bind")` 绑定那条会话 → `agent_chat(deep=true, query="...")` 深读完整
历史 → 给出带时间戳的真实记录。**Codex 那边的会话完全不受影响。**

### B. 接管它剩下的活

```
（你说）Codex 太慢了，你接着把它剩下的活干完。
```

我会 `agent_handoff` 生成交接简报（目标 / 33 个已改动文件 / 106 条命令与退出码 /
未完成信号），据此继续执行。想让接手过程不占用主窗口，就把简报交给 `subagent` 去跑。

### C. 防止两边重复动手

动手前我会 `agent_write(action="check", paths=[...])`：
若 Codex 30 分钟内改过同一文件、或跑过同一条命令，它会直接报冲突，我据此避让。

---

## 三方格式（已实测）

| Agent | 会话文件 | 方言 |
|---|---|---|
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `session_meta` / `response_item`(message, function_call, function_call_output) / `event_msg` / `token_usage_record` |
| WorkBuddy | `~/.workbuddy/projects/<slug>/<uuid>.jsonl` | `session-meta` / `message` / `function_call` / `function_call_result` / `file-history-snapshot` / `ai-title`（Claude Code 风格） |
| DSH | `~/.dsh/sessions/<slug>/session-*.jsonl.zstd` | 由本插件挂 Host 事件实时转写，不解析自己的日志文件 |

Codex 与 WorkBuddy 都是 Codex/Claude 系分支，但 JSONL 结构不同，所以各有独立解析器。

---

## 前置条件

- **DeepSeek Harness**（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)）。
  本插件是 DSH 的树外插件（out-of-tree plugin），走官方支持的 `cordis.patch.yml` 扩展点，
  **不需要 fork或修改 DSH 本体**。
- Node.js ≥ 22.15（内置 zlib zstd 支持；Node 24 已在 Windows / macOS / Linux 验证）。
- 本机已存在至少一个 Codex 或 WorkBuddy 的本地会话记录（否则插件能加载，但没有可同步的内容）。

>⚠️ **DSH 目前是 developer preview，官方明确会有 breaking changes。**
> 本插件依赖若干尚未稳定的内部契约（见文末「宿主契约」一节），
> DSH 升级后可能需要跟着调整。遇到问题请开 issue，附上 `~/.dsh/agent-sync/boot.json` 内容。

## 安装

```powershell
git clone https://github.com/dcsnkj/dsh-agent-sync.git
```

1. **链接到 profile 的共享依赖目录**（desktop / web 都用这一个），把 `<PLUGIN_DIR>` 换成你的 clone 路径：

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-agent-sync" `
     -Target "<PLUGIN_DIR>"
   ```

2. **在 profile 的 `cordis.patch.yml` 末尾追加**（desktop profile 的路径是
   `~/.dsh/profiles/desktop/cordis.patch.yml`）：

   ```yaml
   - insert:
       - id: agent-sync
         name: "@local/dsh-agent-sync"
         config:
           participants:
             - codex
             - workbuddy
           defaultMode: both
           pollMs: 1500
           watch: true
   ```

3. **重启 DSH**（profile 配置在启动时读取；本插件不依赖运行时 HMR）。

**验证是否装好**：

```powershell
Get-Content "$env:USERPROFILE\.dsh\agent-sync\boot.json"
```

最后一个阶段应是 `"ready"`、`state` 为 `running`，且同目录下**没有** `last-error.json`。

<details>
<summary>跑测试（可选）</summary>

工程自带的 `node_modules/@deepseek-ai/*` 通常是指向 `~/.dsh/profiles/node_modules`
的 junction，好让测试能解析真实依赖。若缺失：

```powershell
cd <PLUGIN_DIR>
New-Item -ItemType Junction -Path node_modules\@deepseek-ai\dsh-tools `
  -Target "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh-tools"
node --test "test/**/*.test.mjs"
```

</details>

---

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `baseDir` | `~/.dsh/agent-sync` | 同步根目录（总线、状态、收件箱、hooks 都在这里） |
| `participants` | `[codex, workbuddy]` | 参与同步的其它 agent |
| `defaultMode` | `both` | 新聊天的默认同步模式 |
| `pollMs` | `1500` | 采集轮询间隔 |
| `recentWindowMs` | `3600000` | 注入时回看多久内的对方动作 |
| `pushMs` | `5000` | 收件箱刷新间隔 |
| `watch` | `true` | 关掉后只保留显式工具能力，不采集 |

---

## 模型可用的六个工具

- **`agent_target`** — 把本聊天绑定到某条外部会话（`list` / `bind` / `unbind` / `current`）。绑定后其余工具默认针对它。
- **`agent_chat`** — 检索三方的聊天与操作。`deep=true` 时直接深读目标会话的完整历史文件（不只是总线尾部）；支持 `fileTarget` 临时换目标、`query` / `kinds` / `keyOnly` / `sinceMinutes`。
- **`agent_handoff`** — 生成「接着干」的交接简报（目标 / 已改动文件 / 命令与失败 / 结论 / 未完成信号），可 `checkDisk` 核对文件是否真的还在。
- **`agent_watch`** — 对方最近在干嘛、有没有你还没看过的新动作、采集器与自诊断健康度。
- **`agent_write`** — `check`（动手前查冲突）/ `note`（登记结论）/ `claim`（登记即将执行的操作）。
- **`sync_mode`** — 切换本聊天的同步模式与参与方。

用户在对话里说「盯着 Codex 那个对话」「它太慢了接着干」「这个聊天不要同步了」，
模型会调用对应工具落实，无需手工改配置。

### 自诊断

`agent_watch` 的 `sources.selflog` 会报告：本插件累计看到多少 session 事件、写出多少条、
被模式/类别过滤掉多少、最后一条事件类型、订阅到几个 agent、以及最近的错误。
写回不生效时，先看这里区分「订阅没生效」和「没有操作可记」。

DSH 侧另有 5 分钟一次的心跳（`agent/pre-step` 触发，不经任何过滤），
用于让 Codex / WorkBuddy 知道 DSH 在线，同时作为订阅健康度的探针。

---

## 让 Codex / WorkBuddy 也能看到 DSH 的操作

我方操作会持续写入 `~/.dsh/agent-sync/inbox/codex.md` 与 `inbox/workbuddy.md`。

**方式一（零配置）**：在 Codex / WorkBuddy 里说

> 读 ~/.dsh/agent-sync/inbox/codex.md，看 DeepSeek Harness 最近做了什么，再继续我的实验。

**方式二（hook 自动带上）**：`~/.dsh/agent-sync/hooks/` 下已生成 `read-inbox.ps1` / `read-inbox.sh`，
把它们挂到对方的 hooks 配置（如 Codex 的 `~/.codex/hooks.json`）即可。详见该目录的 `README.md`。

> 我方无法改写对方的 prompt 组装，所以采用「共享收件箱 + 对方读取」的方式；
> 这是唯一不需要修改对方程序就能双向同步的做法。

---

## 数据与隐私

这个插件会**读取你本机其他 AI 助手的会话记录**，所以有必要说清楚它碰了什么。

**它会读：**

- `~/.codex/sessions/**/*.jsonl`（或 `.jsonl.zst`）—— 只读，解析成统一事件
- `~/.workbuddy/projects/**/*.jsonl` —— 同上
- `~/.dsh/` 下自己的同步目录

**它绝不会做：**

- **不修改** `~/.codex` 与 `~/.workbuddy` 下的任何内容（全程只读打开）
- **不读取** `~/.codex/auth*.json`、`config.toml` 等凭据文件
- **不上报**任何数据 —— 没有任何网络请求，全部数据留在本机

**它会写（都在自己的目录里）：**

- 总线：`~/.dsh/agent-sync/events.ndjson`（追加式，按 `participant+sessionId+sourceId` 去重）
- 状态：`state.json`（每个聊天的同步开关）、`cursors.json`（每个 reader 的已读位置）
- 收件箱：`inbox/<agent>.md` —— 供 Codex / WorkBuddy 反向读取 DSH 的操作

**解析时主动丢弃的内容：**

- `base_instructions`、`developer` / `system` 角色的消息、`world_state`
- token 记录只保留数字字段，不保留正文
- 永远不会把密钥/令牌写进总线

> 想彻底关掉某个聊天的同步：在该聊天里调用 `sync_mode(mode="off")`。
> 想彻底停用插件：注释掉 `cordis.patch.yml` 里那段并重启 DSH。

---

## 开发与验证

前置：把 `@deepseek-ai/dsh-tools` 等 peer 依赖链进 `node_modules`（或直接用
`npm install` 后替换为本地路径的 `@deepseek-ai/dsh` 包）。下面命令假定 Node 可直接调用。

```powershell
# 单元 + 集成测试
node --test "test/**/*.test.mjs"

# 插件在「Host 等价环境」里真实执行 apply()（会注册工具并调用一次 agent_chat）
node test\apply-smoke.mjs "$env:USERPROFILE\.dsh\profiles\desktop"

# 真实文件端到端：跟随活跃 Codex 会话并检索
node test\e2e-real.mjs

# 防重复闸门确定性验证（5 个用例）
node test\conflict-gate.mjs
```

### 文件结构

```
lib/
  contract.js      跨 agent 同步信封契约（唯一协议层，含工具名→类别映射）
  bus.js           追加式事件总线（去重、seq 游标、内存裁剪后回落读文件）
  sessions.js      会话级同步开关 + 协同台账（文件/命令维度，防重复判定）
  selflog.js       DSH 操作 → 总线（只记关键操作，跳过注入型消息防回环）
  injector.js      对方动作 → 本会话上下文（systemPrompt.context + pre-step notice）
  push.js          我方操作 → 对方可读收件箱 + hooks 脚本
  tools.js         四个模型工具
  index.js         插件入口（装配、注册、生命周期）
  parsers/
    contract.js    SourceAdapter 接口契约
    codex.js       Codex rollout 解析器
    workbuddy.js   WorkBuddy 项目会话解析器
  watch.js         增量跟随 + 活跃会话发现
```

---

## 排查：插件没生效时按这个顺序看

**1. 确认 Loader 里这个条目是什么状态**（最直接）

```
plugin_manager(action="list_plugins", offset=150, limit=50)
```

看 `include:agent-sync`：
- `fiberPhase: "active"` → 已加载成功
- `fiberPhase: "failed"` → 加载了但初始化抛异常，看下一步
- 条目根本不存在 → `cordis.patch.yml` 的 patch 没被采纳（检查 `- insert:` 的位置与 YAML）

**2. 看落地自诊断文件**

桌面端看不到 Host 的 console 输出，所以插件把关键阶段直接写进文件：

```
~/.dsh/agent-sync/boot.json        每次 apply 都写；stages 记录走到了哪一步
~/.dsh/agent-sync/last-error.json  任何异常都会写：where / message / stack / 已完成的 stages
```

`boot.json` 最后一条 stage 就是成功到达的位置。若 `last-error.json` 存在，
其 `where` 字段直接指出失败阶段（`apply-sync` 同步期 / `async-init` 异步初始化期）。

**3. 看写回是否生效**（总线里 `dsh` 事件为 0 就是没生效）

```
agent_watch → sources.selflog
```

- `sessionEventsSeen > 0` 且 `eventsRecorded == 0` → 被同步模式或类别过滤了
- `sessionEventsSeen == 0` → `session/event` 订阅没生效（**不是**"没有操作可记"）

另有 5 分钟一次的 DSH 心跳（挂在 `agent/pre-step`、不经任何过滤条件）作为兜底探针。

**4. 在 Host 等价环境里复现**（绕过 Electron 与桌面端差异）

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
node <仓库路径>\test\apply-smoke.mjs $env:USERPROFILE\.dsh\profiles\desktop
```

会真实执行 `apply()`、注册全部工具、跑一次 `agent_target` / `agent_handoff` 并打印结果。

> 关键提醒：**修改本插件代码后必须重启 DSH**。Host 是长驻进程，
> 文件改了但进程里跑的还是旧模块——这一点会造成"改了没生效"的误判。

---

## 三个必须知道的宿主契约（都是踩过的坑）

**1. `session/event` 派发的是完整日志条目，业务负载在 `event.data` 里**

```js
ctx.on("session/event", (session, event) => {
  const payload = event.data ?? event;   // ← 必须这样取
  // event = { type, seq, time, data }
  // turn/start 的 turn 号在 event.data.turn，不在 event.turn
});
```

直接读 `event.turn` / `event.content` 只会拿到 `undefined`，表现是事件里出现
`turn undefined`。每条 record 都要带上 `seq`，作为稳定 sourceId 的兜底。

**2. `output.schema` 用的是 DSL，不是裸 JSON Schema，而且不支持声明必填**

- `parameters` 用 `required: true` 注释（隐式根对象）
- `output.schema` 是 `ValueSchemaSpec`：`ObjectValueSchemaSpec` 只有
  `properties` / `additionalProperties`，**没有 `required`**
- 写错会在 `ctx.tools.register()` 抛 `JsonSchemaError`，整个插件变成 `fiberPhase: "failed"`

守卫：测试里有用例用真实的 `assertSupportedJsonSchema` 断言全部 6 个 schema。
**不要用打桩的 `defineTool` 写测试**——它会把这类错误全部藏起来。

**3. 去重键绝不能包含时间**

`session/event` 会被「全局兜底 + 逐 agent 作用域」两条订阅路径各投递一次，
两次处理相差几毫秒。去重键一旦含 `ts`，同一条逻辑事件就会落两遍。
现在 `eventKey` 只用信封里的稳定 `id`（由 participant+sessionId+sourceId 派生），
并且 `selflog` 保证每个事件都有稳定 `sourceId`（缺失时退到 `seq`）。

> 解析器侧同理：`file-history-snapshot` 的 `sourceId` 必须带上记录自身的
> `timestamp` 与字节偏移——多个快照会共享同一个 `snap.messageId`。

---

## 已知边界

- **实时性** = 采集轮询间隔（默认 1.5s）+ 我方的 step 边界。不是逐 token 流式同步。
- Codex / WorkBuddy 的 hooks 是否把收件箱内容带进它们的模型上下文，取决于对方实现；不确定时用「方式一」最稳。
- 采集团队不持久化 offset 账本（进程内 Map）。重启后会重放活跃会话尾部（默认 512KB），
  靠总线 id 去重保证不产生重复事件，代价是一次性重读。
- 冲突窗口默认 30 分钟（文件）/ 30 分钟（命令），超出即视为「不是同一轮操作」而放行。
