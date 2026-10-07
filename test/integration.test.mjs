// dsh-agent-sync — 集成测试：验证总线、自记录、注入、工具与跨进程共享。
// 这里用假 agent/session 驱动真实模块（不启动 Host），覆盖同步链路的关键行为。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../lib/bus.js";
import { SessionSyncStore, buildLedger, fileConflict } from "../lib/sessions.js";
import { createSelfLog, blocksToText } from "../lib/selflog.js";
import { createInjector } from "../lib/injector.js";
import { createPush } from "../lib/push.js";
import { buildTools } from "../lib/tools.js";
import { makeEvent } from "../lib/contract.js";
// 真实校验器：只读断言，不启动 Host。用它守住 output.schema 的合法性。
import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";

/** 一个足够真实的假 agent：插件只依赖这些字段。 */
function fakeAgent({ id = "sess-1", cwd = "E:\\proj\\T3VF" } = {}) {
  const injected = [];
  return {
    injected,
    agent: {
      session: { header: { id, cwd, title: "测试会话" } },
      inject(msg) {
        injected.push(msg);
      },
    },
  };
}

/** 简易事件总线（插件事件用）。 */
function fakeCtx() {
  const handlers = new Map();
  return {
    handlers,
    on(name, fn) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    /** 触发某个事件，模拟 Host 派发。 */
    async emitEvent(name, ...args) {
      for (const fn of handlers.get(name) ?? []) await fn(...args);
    },
    tools: { registered: [], register(t) { this.registered.push(t); } },
  };
}
async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-agent-sync-test-"));
  try {
    return await fn(dir);
  } finally {
    // 总线写入是异步队列；先让被跟踪的写入落盘，避免测试结束后仍有写盘活动
    for (const bus of pendingBuses) await bus.flush().catch(() => {});
    pendingBuses.clear();
    // Windows 上文件句柄释放有延迟，rm 偶发 ENOTEMPTY；重试几次即可
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
}

/** 跟踪本测试创建的 bus，便于收尾时 flush。 */
const pendingBuses = new Set();

async function makeStack(dir, opts = {}) {
  const bus = new EventBus({
    busFile: join(dir, "events.ndjson"),
    cursorFile: join(dir, "cursors.json"),
  });
  const store = new SessionSyncStore({
    file: join(dir, "state.json"),
    defaultMode: opts.defaultMode ?? "both",
    enabledParticipants: ["codex", "workbuddy"],
  });
  await bus.load();
  await store.load();
  pendingBuses.add(bus);
  return { bus, store };
}

// ── 总线 ────────────────────────────────────────────────────────────────────

test("bus: append 去重、seq 单调、query 过滤、unread/ack 游标", async () => {
  await withTmp(async (dir) => {
    const { bus } = await makeStack(dir);
    const ev = makeEvent({
      participant: "codex",
      sessionId: "t1",
      kind: "command",
      text: "$ pytest -q",
      data: { command: "pytest -q", exitCode: 0 },
      ts: 1000,
      sourceId: "call-1",
    });
    assert.equal(bus.append(ev), 1);
    // 同一条再投一次：必须被去重
    assert.equal(bus.append(ev), 0);
    assert.equal(bus.all().length, 1);

    bus.append(
      makeEvent({ participant: "workbuddy", sessionId: "t2", kind: "file_write", text: "改 a.py", data: { paths: ["a.py"], wrotePaths: ["a.py"] }, ts: 2000 }),
    );
    assert.equal(bus.all().length, 2);
    assert.ok(bus.all()[1].seq > bus.all()[0].seq, "seq 必须单调递增");

    assert.equal(bus.query({ participants: ["codex"] }).length, 1);
    assert.equal(bus.query({ kinds: ["file_write"] }).length, 1);
    assert.equal(bus.query({ since: 1500 }).length, 1);
    assert.equal(bus.query({ keyOnly: true }).length, 2);

    // 游标语义
    const first = bus.all()[0].seq;
    assert.equal((await bus.unread("me")).length, 2);
    await bus.ack("me", first);
    assert.equal((await bus.unread("me")).length, 1, "ack 之后只剩未读的那条");
  });
});

test("bus: 内存裁剪后 cursor 仍按 seq 正确（回落到读文件，不错位）", async () => {
  await withTmp(async (dir) => {
    const { bus } = await makeStack(dir);
    bus.maxInMemory = 5;
    for (let i = 0; i < 12; i += 1) {
      bus.append(makeEvent({ participant: "codex", sessionId: "s", kind: "command", text: `cmd-${i}`, ts: 1000 + i, sourceId: `c${i}` }));
    }
    // ack 到第 5 条
    const fifthSeq = 5;
    await bus.ack("me", fifthSeq);
    await bus.flush(); // 确保 12 条都落盘，再验证“从文件补读”
    const unread = await bus.unread("me");
    assert.equal(unread.length, 7, "裁剪到 5 条内存后，仍应能从文件读到剩余 7 条未读");
    assert.ok(unread.every((e) => e.seq > fifthSeq));
    // 完整历史也能读回来
    const all = await bus.queryFull({ limit: 100, tail: true });
    assert.equal(all.length, 12, "queryFull 应能从文件读出全部 12 条");
  });
});

test("bus: 跨进程共享（重新 load 一个实例能读到同样内容，且不重复）", async () => {
  await withTmp(async (dir) => {
    const a = await makeStack(dir);
    a.bus.append(makeEvent({ participant: "dsh", sessionId: "s", kind: "assistant", text: "结论", ts: 5000, sourceId: "m1" }));
    await a.bus.flush();

    const b = new EventBus({ busFile: join(dir, "events.ndjson"), cursorFile: join(dir, "cursors.json") });
    await b.load();
    assert.equal(b.all().length, 1);
    assert.equal(b.all()[0].text, "结论");
    // 第二个实例重复投同一条：依然去重
    assert.equal(
      b.append(makeEvent({ participant: "dsh", sessionId: "s", kind: "assistant", text: "结论", ts: 5000, sourceId: "m1" })),
      0,
    );
  });
});

// ── 自记录（DSH 的操作 → 总线）──────────────────────────────────────────────

test("selflog: 记录改文件/命令/结论，且跳过注入型 user 消息（防回环）", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    const ctx = fakeCtx();
    createSelfLog({ bus, store, log: () => {} }).attach(ctx);
    const session = { header: { id: "sess-1", cwd: "E:\\proj\\T3VF", title: "T" } };

    // 一次 apply_patch 写文件
    await ctx.emitEvent("session/event", session, {
      type: "tool/call",
      callId: "c1",
      name: "apply_patch",
      arguments: JSON.stringify({ input: "*** Begin Patch\n*** Update File: a.py\n+x\n*** End Patch" }),
    });
    // 一条命令 + 结果
    await ctx.emitEvent("session/event", session, {
      type: "tool/call",
      callId: "c2",
      name: "bash",
      arguments: JSON.stringify({ command: "python train.py --seed 0" }),
    });
    await ctx.emitEvent("session/event", session, {
      type: "tool/result",
      message: { callId: "c2", name: "bash", content: [{ type: "text", text: '{"exit_code":1,"output":"boom"}' }] },
    });
    // 人类指令
    await ctx.emitEvent("session/event", session, {
      type: "user/message",
      id: "u1",
      content: [{ type: "text", text: "把 seed 改成 1" }],
      source: { kind: "user" },
    });
    // 插件注入的上下文：不得进总线
    await ctx.emitEvent("session/event", session, {
      type: "user/message",
      id: "u2",
      content: [{ type: "text", text: "<agent-sync>对方改了 x</agent-sync>" }],
      source: { kind: "plugin", plugin: "dsh-agent-sync" },
    });
    // 结论
    await ctx.emitEvent("session/event", session, {
      type: "assistant/message",
      message: { id: "a1", content: [{ type: "text", text: "实验失败，原因是 OOM" }] },
    });

    const kinds = bus.all().map((e) => `${e.participant}:${e.kind}`);
    assert.ok(kinds.includes("dsh:file_write"), "应记录写文件");
    assert.ok(kinds.includes("dsh:command"), "应记录命令");
    assert.ok(kinds.includes("dsh:user"), "应记录人类指令");
    assert.ok(kinds.includes("dsh:assistant"), "应记录结论");
    assert.equal(bus.all().filter((e) => e.kind === "user").length, 1, "注入型 user 消息不得进总线");

    const cmd = bus.all().find((e) => e.kind === "command");
    assert.equal(cmd.data.exitCode, 1, "命令结果应带上退出码");
    const fw = bus.all().find((e) => e.kind === "file_write");
    assert.deepEqual(fw.data.wrotePaths, ["a.py"], "apply_patch 应抽出被改文件");
  });
});

test("selflog: mode=read 时不往外写（遵守同步开关）", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir, { defaultMode: "read" });
    const ctx = fakeCtx();
    createSelfLog({ bus, store, log: () => {} }).attach(ctx);
    await ctx.emitEvent(
      "session/event",
      { header: { id: "s1", cwd: "E:\\p" } },
      { type: "tool/call", callId: "c1", name: "bash", arguments: JSON.stringify({ command: "ls" }) },
    );
    assert.equal(bus.all().length, 0, "read 模式不应写出任何事件");
  });
});

// ── 注入（对方的操作 → 我的上下文）─────────────────────────────────────────

test("injector: 把 Codex 的操作渲染进运行时上下文，并在 pre-step 注入 notice", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    bus.append(
      makeEvent({
        participant: "codex",
        sessionId: "codex-1",
        cwd: "E:\\proj\\T3VF",
        kind: "file_write",
        text: "改 train.py",
        data: { paths: ["train.py"], wrotePaths: ["train.py"] },
        ts: Date.now(),
        sourceId: "w1",
      }),
    );
    bus.append(
      makeEvent({
        participant: "codex",
        sessionId: "codex-1",
        cwd: "E:\\proj\\T3VF",
        kind: "command",
        text: "$ python train.py",
        data: { command: "python train.py", exitCode: 1 },
        ts: Date.now(),
        sourceId: "c1",
      }),
    );

    const injector = createInjector({ bus, store, log: () => {} });
    const wrapped = fakeAgent();
    const agent = wrapped.agent;

    const text2 = injector.contextProvider({ agent });
    assert.ok(text2 && text2.includes("agent-sync"), "应生成运行时上下文");
    assert.ok(text2.includes("train.py"), "应包含对方改动的文件");
    assert.ok(text2.includes("Codex"), "应标明来源 agent");
    assert.ok(text2.includes("exit 1"), "应带上命令退出码");

    // 不在同一目录的会话不应看到（防止别的项目噪声）
    // 注意必须断言空串而不是 undefined：PromptContext.text 契约是 string，
    // 宿主interpolate() 会无条件调 text.indexOf()，undefined 会让整个 turn 崩掉。
    const otherWrapped = fakeAgent({ id: "sess-2", cwd: "E:\\proj\\Other" });
    const otherText = injector.contextProvider({ agent: otherWrapped.agent });
    assert.equal(typeof otherText, "string", "contextProvider 必须返回字符串");
    assert.equal(otherText, "", "不同工作目录不应注入对方事件");

    // pre-step 注入
    const ctx = fakeCtx();
    injector.attach(ctx);
    await ctx.emitEvent("agent/pre-step", { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal });
    assert.equal(wrapped.injected.length, 1, "应注入一条 notice");
    assert.equal(wrapped.injected[0].source.kind, "plugin");
    assert.ok(wrapped.injected[0].content[0].text.includes("train.py"));

    // 第二次没有新事件 → 不再重复注入
    await ctx.emitEvent("agent/pre-step", { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal });
    assert.equal(wrapped.injected.length, 1, "没有新事件不应重复注入");
  });
});

// ── 协同台账 / 防重复 ──────────────────────────────────────────────────────

test("ledger: fileConflict 与 buildLedger 能识别别人改过的文件", async () => {
  await withTmp(async (dir) => {
    const { bus } = await makeStack(dir);
    const now = Date.now();
    bus.append(
      makeEvent({
        participant: "codex",
        sessionId: "c1",
        cwd: "E:\\p",
        kind: "file_write",
        text: "改 config.py",
        data: { paths: ["config.py"], wrotePaths: ["config.py"] },
        ts: now - 60000,
        sourceId: "x1",
      }),
    );
    const ledger = buildLedger(bus.all(), { excludeParticipant: "dsh", now });
    const conflict = fileConflict(ledger.files, "E:\\p\\config.py", "dsh", { now });
    assert.ok(conflict, "应识别出冲突");
    assert.deepEqual(conflict.writers, ["codex"]);
    // 自己改过的文件不算冲突
    assert.equal(fileConflict(ledger.files, "config.py", "codex", { now }), undefined);
  });
});

// ── 工具层 ──────────────────────────────────────────────────────────────────

test("tools: agent_write 在别人改过同一文件时报告冲突；sync_mode 能切模式", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    const now = Date.now();
    bus.append(
      makeEvent({
        participant: "codex",
        sessionId: "c1",
        cwd: "E:\\proj\\T3VF",
        kind: "file_write",
        text: "改 models/vla.py",
        data: { paths: ["models/vla.py"], wrotePaths: ["models/vla.py"] },
        ts: now - 30000,
        sourceId: "w1",
      }),
    );
    const tools = buildTools({ bus, store, sourceStatus: () => ({ state: "running" }), log: () => {} });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepEqual(
      Object.keys(byName).sort(),
      ["agent_chat", "agent_handoff", "agent_target", "agent_watch", "agent_write", "sync_mode"],
    );

    const { agent } = fakeAgent("sess-1");
    const exec = { agent };

    // check：应报告冲突
    const chk = await byName.agent_write.execute(
      { action: "check", paths: ["E:\\proj\\T3VF\\models\\vla.py"] },
      exec,
    );
    assert.equal(chk.conflictCount, 1, "应报告 1 处冲突");
    assert.ok(chk.conflicts[0].includes("Codex"));

    // chat：能读到对方记录
    const chat = await byName.agent_chat.execute({ keyOnly: true, sinceMinutes: 60 }, exec);
    assert.equal(chat.denied, false);
    assert.ok(chat.total >= 1);
    assert.ok(chat.lines.some((l) => l.includes("Codex")), "结果里应有 Codex 的记录");

    // 切到只读：不再写出，但仍能读
    await byName.sync_mode.execute({ mode: "read" }, exec);
    const s = store.settingsFor("sess-1");
    assert.equal(s.mode, "read");
    assert.deepEqual(s.writeParticipants, []);
    assert.deepEqual(s.readParticipants, ["codex", "workbuddy"]);

    // off：读写都关
    await byName.sync_mode.execute({ mode: "off" }, exec);
    assert.deepEqual(store.settingsFor("sess-1").readParticipants, []);
    const denied = await byName.agent_chat.execute({}, exec);
    assert.equal(denied.denied, true, "off 模式下读取应被拒绝");

    // 只留 codex
    await byName.sync_mode.execute({ mode: "both", participants: ["codex"] }, exec);
    const s2 = store.settingsFor("sess-1");
    assert.deepEqual(s2.readParticipants, ["codex"]);
    assert.deepEqual(s2.writeParticipants, ["codex"]);
  });
});

test("tools: agent_write 的 claim 会写进总线（双向同步的写通道）", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    const tools = buildTools({ bus, store, sourceStatus: () => ({}), log: () => {} });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const { agent } = fakeAgent();
    const r = await byName.agent_write.execute(
      { action: "claim", summary: "准备跑 M3 全量", paths: ["scripts/run_m3.sh"] },
      { agent },
    );
    assert.equal(r.recorded, true);
    assert.equal(r.conflictCount, 0);
    const mine = bus.all().filter((e) => e.participant === "dsh");
    assert.equal(mine.length, 1);
    assert.ok(mine[0].text.includes("[claim]"));
  });
});

test("bus: 同一逻辑事件在不同时刻投递两次也只落一条（去重键不含 ts）", async () => {
  // 回归守卫：session/event 会被“全局兜底 + 逐 agent 作用域”两条路径各投递一次，
  // 两次处理相差几毫秒。去重键一旦含 ts，同一条逻辑事件就会被记两遍。
  await withTmp(async (dir) => {
    const { bus } = await makeStack(dir);
    const base = { participant: "dsh", sessionId: "s1", kind: "turn", text: "turn 7 开始", sourceId: "turn:1649:start" };
    assert.equal(bus.append(makeEvent({ ...base, ts: 1000 })), 1);
    assert.equal(bus.append(makeEvent({ ...base, ts: 1003 })), 0, "ts 不同但 sourceId 相同 → 必须去重");
    assert.equal(bus.all().length, 1);
    assert.equal(bus.append(makeEvent({ ...base, ts: 1003, sourceId: "turn:1650:start" })), 1, "不同 sourceId 仍是两条");
    assert.equal(bus.all().length, 2);
  });
});

test("bus: load() 把文件里已有的重复行压实到磁盘，并留备份", async () => {
  await withTmp(async (dir) => {
    const busFile = join(dir, "events.ndjson");
    await mkdir(dir, { recursive: true });
    const one = makeEvent({ participant: "dsh", sessionId: "s", kind: "turn", text: "turn 1 开始", ts: 5000, sourceId: "t1" });
    // 手工写 3 行，其中两行是同一条逻辑事件（模拟历史遗留重复）
    await writeFile(busFile, [
      JSON.stringify({ ...one, seq: 1 }),
      JSON.stringify({ ...one, ts: 5001, seq: 2 }),
      JSON.stringify({ ...one, ts: 5002, seq: 3 }),
    ].join("\n") + "\n", "utf8");

    const fresh = new EventBus({ busFile, cursorFile: join(dir, "cursors.json") });
    await fresh.load();
    assert.equal(fresh.all().length, 1, "内存里只保留一条");
    assert.match(String(fresh.stats.compacted ?? ""), /→ 1$/, "应记录压实结果");
    const onDisk = (await readFile(busFile, "utf8")).trim().split("\n");
    assert.equal(onDisk.length, 1, "磁盘文件也被压成一行");
  });
});

test("tools: 六个 output.schema 都能通过真实 JSON Schema 校验器", async () => {
  // 回归守卫：曾经把 required 写进 output.schema（DSH 的 schema DSL 不支持），
  // 导致插件在真实 Host 里 tools.register 抛 JsonSchemaError、fiberPhase=failed。
  // 打桩的 defineTool 发现不了这类错，所以这里用真实校验器断言。
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    const tools = buildTools({ bus, store, sourceStatus: () => ({}), adapters: new Map(), log: () => {} });
    assert.equal(tools.length, 6);
    for (const t of tools) {
      assert.doesNotThrow(() => assertSupportedJsonSchema(t.output.schema), `${t.name} 的 output.schema 非法`);
      assert.equal(typeof t.output.render, "function", `${t.name} 缺 render`);
      assert.ok(t.description?.length > 10, `${t.name} 的 description 太短`);
    }
  });
});

// ── 真实宿主事件形状（回归守卫）────────────────────────────────────────────
// 真实 dsh-session 派发 session/event 时传的是完整日志条目 {type, seq, time, data}，
// 业务负载全在 .data 里。上面那些测试用扁平结构是历史遗留，所以下面的用例
// 严格按真实形状构造——它们对应的两个 bug 都曾让线上「每一轮都失败」。

/** 按 dsh-session 的真实形状造一个 session/event 负载。 */
function realEvent(type, seq, data) {
  return { type, seq, time: 1_700_000_000_000 + seq * 1000, data };
}

test("selflog: 真实宿主形状下 turn 事件能取到 turn 号与 reason，且不重复", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    const ctx = fakeCtx();
    createSelfLog({ bus, store, log: () => {} }).attach(ctx);
    const session = { header: { id: "sess-1", cwd: "E:\\proj\\T3VF", title: "T" } };

    await ctx.emitEvent("session/event", session, realEvent("turn/start", 946, { turn: 7 }));
    await ctx.emitEvent("session/event", session, realEvent("turn/end", 988, { turn: 7, reason: { kind: "completed" } }));

    const turns = bus.all().filter((e) => e.kind === "turn");
    assert.equal(turns.length, 2, "turn 事件不应重复");
    assert.equal(turns[0].text, "turn 7 开始");
    assert.equal(turns[1].text, "turn 7 结束 (completed)", "必须从 event.data 里取 turn/reason");
    assert.ok(!turns.some((e) => e.text.includes("undefined")), `不应出现 undefined：${turns.map((e) => e.text).join(" | ")}`);
  });
});

test("selflog: 真实宿主形状下 tool/call 与 user 消息仍能被记录", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    const ctx = fakeCtx();
    createSelfLog({ bus, store, log: () => {} }).attach(ctx);
    const session = { header: { id: "sess-1", cwd: "E:\\proj\\T3VF", title: "T" } };

    await ctx.emitEvent(
      "session/event",
      session,
      realEvent("tool/call", 12, { callId: "c1", name: "bash", arguments: JSON.stringify({ command: "python train.py" }) }),
    );
    await ctx.emitEvent(
      "session/event",
      session,
      realEvent("tool/result", 13, { message: { callId: "c1", name: "bash", content: [{ type: "text", text: '{"exit_code":0}' }] } }),
    );
    await ctx.emitEvent(
      "session/event",
      session,
      realEvent("user/message", 14, {
        id: "u1",
        content: [{ type: "text", text: "改 seed 为 1" }],
        source: { kind: "user" },
      }),
    );

    const kinds = bus.all().map((e) => e.kind);
    assert.ok(kinds.includes("command"), "命令应被记录（负载在 data 里）");
    assert.ok(kinds.includes("user"), "人类指令应被记录");
    const cmd = bus.all().find((e) => e.kind === "command");
    assert.equal(cmd.data.exitCode, 0, "退出码应从 data 里取到");
  });
});

test("injector: contextProvider 永不返回 undefined（否则宿主每轮抛 indexOf 崩溃）", async () => {
  // 回归守卫：PromptContext.text 的契约是 string，dsh-system-prompt 的
  // interpolate() 会无条件调 text.indexOf("{{")。曾经这里返回 undefined，
  // 导致 agent-sync 上下文为空时整个 turn 失败：
  //   "Cannot read properties of undefined (reading 'indexOf')"
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    const injector = createInjector({ bus, store, log: () => {}, recentWindowMs: 60_000 });

    // 总线为空 → 无事件 → 旧实现返回 undefined
    const empty = injector.contextProvider({ agent: { session: { header: { id: "s1", cwd: "E:\\p" } } } });
    assert.equal(typeof empty, "string", "无事件时必须返回字符串，不能是 undefined");
    assert.equal(empty, "");

    // 连 agent 都没有的畸形调用同样必须是字符串
    assert.equal(typeof injector.contextProvider({}), "string", "缺 agent 时也必须返回字符串");
    assert.equal(typeof injector.contextProvider(undefined), "string");

    // 有事件时返回真实文本
    bus.append(
      makeEvent({
        participant: "codex",
        sessionId: "cx",
        cwd: "E:\\p",
        kind: "file_write",
        text: "改了 a.py",
        data: { wrotePaths: ["a.py"] },
        ts: Date.now(),
        sourceId: "x1",
      }),
    );
    const filled = injector.contextProvider({ agent: { session: { header: { id: "s1", cwd: "E:\\p" } } } });
    assert.ok(filled.includes("a.py"), "有事件时应渲染出内容");
  });
});

// ── 同步一致性（回归守卫）──────────────────────────────────────────────────
// 这一组针对九个具体缺陷：模式开关被绕过、缓存不随设置失效、ack 从不推进、
// 参数不校验导致静默读错会话，等等。全部按真实宿主形状与真实 store 构造。

/** 往总线塞一条 codex 事件。 */
function seedCodex(bus, over = {}) {
  return bus.append(
    makeEvent({
      participant: "codex",
      sessionId: "cx-1",
      cwd: "E:\\proj\\T3VF",
      kind: "file_write",
      text: "Codex 改了 a.py",
      data: { paths: ["a.py"], wrotePaths: ["a.py"] },
      ts: Date.now(),
      sourceId: "seed-1",
      ...over,
    }),
  );
}

test("sync: participants 不能放宽权限——传 dsh 也读不到本方记录", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    const tools = buildTools({ bus, store, sourceStatus: () => ({}), log: () => {} });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const { agent } = fakeAgent();
    const exec = { agent };

    // 本方先写一条
    await byName.agent_write.execute({ action: "note", summary: "DSH 的私密结论" }, exec);
    assert.ok(bus.all().some((e) => e.participant === "dsh" && e.text.includes("私密")));

    // 即使显式点名 dsh，也不该读到自己的记录（注入通道的意义是看别人）。
    // 注意：点名项全被过滤掉时会视作"没点名"而沿用默认白名单，所以 denied 仍可能是 false——
    // 真正的安全属性是「一条 dsh 记录都没漏出来」。
    const r = await byName.agent_chat.execute({ participants: ["dsh"], sinceMinutes: 60 }, exec);
    assert.equal(r.total, 0, "不得读到本方记录");
    assert.ok(!r.lines.some((l) => l.includes("私密")), "本方正文不得泄露");
    assert.ok(!JSON.stringify(r.sessions).includes("私密"));
  });
});

test("sync: 请求的 participants 只能收窄，不能放宽白名单", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    seedCodex(bus);
    bus.append(
      makeEvent({
        participant: "workbuddy",
        sessionId: "wb-1",
        cwd: "E:\\proj\\T3VF",
        kind: "file_write",
        text: "WorkBuddy 改了 b.py",
        data: { paths: ["b.py"], wrotePaths: ["b.py"] },
        ts: Date.now(),
        sourceId: "seed-2",
      }),
    );
    const tools = buildTools({ bus, store, sourceStatus: () => ({ state: "running" }), log: () => {} });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const { agent } = fakeAgent();
    const exec = { agent };

    // 白名单只留 codex，点名 workbuddy 也不该读到
    await byName.sync_mode.execute({ mode: "both", participants: ["codex"] }, exec);
    const r = await byName.agent_chat.execute({ participants: ["workbuddy"], sinceMinutes: 60 }, exec);
    assert.equal(r.denied, true, "点名白名单外的参与方应被拒");
    assert.ok(!r.lines.some((l) => l.includes("WorkBuddy")), "不得读到白名单外的内容");
  });
});

test("sync: mode=off 时 agent_target(list) 也不泄露外部会话标题", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    seedCodex(bus);
    const fakeAdapter = {
      participant: "codex",
      listSessions: async () => [{ sessionId: "cx-1", title: "Codex 的私密会话", mtime: Date.now(), cwd: "E:\\proj\\T3VF", file: "f", bytes: 1 }],
      findActive: async () => null,
      readSession: async () => ({ events: [], offset: 0 }),
      follow: async () => {},
    };
    const tools = buildTools({
      bus,
      store,
      sourceStatus: () => ({}),
      adapters: new Map([["codex", fakeAdapter]]),
      log: () => {},
    });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const { agent } = fakeAgent();
    const exec = { agent };

    // both 模式：能看到候选
    const ok = await byName.agent_target.execute({ action: "list" }, exec);
    assert.equal(ok.candidates.length, 1, "both 模式应能列出候选");

    // off 模式：连"存在哪些会话"都不该泄露
    await byName.sync_mode.execute({ mode: "off" }, exec);
    const denied = await byName.agent_target.execute({ action: "list" }, exec);
    assert.ok(denied.binding?.error, "off 模式应给出错误说明");
    assert.equal(denied.candidates.length, 0, "off 模式不得列出任何外部会话");

    // current 只读自己的绑定，不需要外部权限
    const cur = await byName.agent_target.execute({ action: "current" }, exec);
    assert.equal(cur.action, "current");
  });
});

test("sync: sync_mode 之后上下文立刻按新模式重算（缓存键含模式）", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    seedCodex(bus);
    const injector = createInjector({ bus, store, log: () => {}, recentWindowMs: 60 * 60 * 1000 });
    const { agent } = fakeAgent({ id: "sess-1", cwd: "E:\\proj\\T3VF" });
    const assemble = { agent };

    // 初始：both → 有内容，并被缓存
    const first = injector.contextProvider(assemble);
    assert.ok(first.includes("a.py"), "初始应注入 codex 的动作");
    const headBefore = bus.head();

    // 切成 off。注意 bus.head() 没变——旧实现只看 head，缓存会一直命中。
    await store.setMode("sess-1", "off");
    const after = injector.contextProvider(assemble);
    assert.equal(bus.head(), headBefore, "前提：期间总线没有新事件");
    assert.equal(after, "", "切到 off 后必须立刻变为空，而不是等对方产生新事件");

    // 切回 both：内容必须回来（证明双向都失效重算，而不是单向）
    await store.setMode("sess-1", "both");
    assert.ok(injector.contextProvider(assemble).includes("a.py"), "切回 both 应恢复注入");
  });
});

test("sync: injector.invalidate() 可强制作废缓存（sync_mode 走这条路）", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    seedCodex(bus);
    const injector = createInjector({ bus, store, log: () => {}, recentWindowMs: 60 * 60 * 1000 });
    const { agent } = fakeAgent({ id: "sess-1", cwd: "E:\\proj\\T3VF" });
    const assemble = { agent };
    assert.ok(injector.contextProvider(assemble).includes("a.py"));

    await store.setMode("sess-1", "off");
    injector.invalidate("sess-1");
    assert.equal(injector.contextProvider(assemble), "");
  });
});

test("sync: agent_watch 看过即 ack，unread 不再虚高", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    seedCodex(bus);
    seedCodex(bus, { sourceId: "seed-3", text: "又一条", data: { paths: ["c.py"], wrotePaths: ["c.py"] } });
    const tools = buildTools({ bus, store, sourceStatus: () => ({ state: "running" }), log: () => {} });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const { agent } = fakeAgent({ id: "sess-1" });
    const exec = { agent };

    const first = await byName.agent_watch.execute({ sinceMinutes: 60 }, exec);
    assert.ok(first.unread > 0, "首次应有未读");
    assert.ok((bus.readers.get("sess-1") ?? 0) > 0, "看过之后应写入游标");

    // 没有新事件时，未读必须归零（旧实现下bus.ack 从不被调用，永远虚高）
    const second = await byName.agent_watch.execute({ sinceMinutes: 60 }, exec);
    assert.equal(second.unread, 0, "确认后未读应归零");

    // 来了新事件，未读重新计数
    seedCodex(bus, { sourceId: "seed-4", text: "新动作", data: { paths: ["d.py"], wrotePaths: ["d.py"] } });
    const third = await byName.agent_watch.execute({ sinceMinutes: 60 }, exec);
    assert.equal(third.unread, 1, "只应计入游标之后的新事件");
  });
});

test("sync: fileTarget 格式错误必须显式失败，不能静默读别的会话", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    seedCodex(bus);
    const fakeAdapter = {
      participant: "codex",
      listSessions: async () => [{ sessionId: "cx-1", title: "T", mtime: Date.now(), cwd: "E:\\proj\\T3VF", file: "f", bytes: 1 }],
      findActive: async () => null,
      readSession: async () => ({ events: [{ v: 1, participant: "codex", sessionId: "cx-1", kind: "user", role: "user", text: "真正的目标", data: {}, ts: Date.now(), id: "x" }], offset: 1 }),
      follow: async () => {},
    };
    const tools = buildTools({
      bus,
      store,
      sourceStatus: () => ({}),
      adapters: new Map([["codex", fakeAdapter]]),
      log: () => {},
    });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const { agent } = fakeAgent();
    const exec = { agent };

    // 缺冒号 / 冒号位置错/ 未知 participant / 指向自己：都必须报错
    for (const bad of ["codex-cx-1", "codex:", ":cx-1", "gemini:cx-1", "dsh:cx-1"]) {
      const r = await byName.agent_chat.execute({ deep: true, fileTarget: bad }, exec);
      assert.equal(r.total, 0, `fileTarget="${bad}" 应失败`);
      assert.ok(r.lines[0]?.startsWith("深读失败"), `fileTarget="${bad}" 应给出明确失败原因，实际: ${r.lines[0]}`);
    }

    // 合法格式才走深读
    const ok = await byName.agent_chat.execute({ deep: true, fileTarget: "codex:cx-1" }, exec);
    assert.ok(ok.lines.some((l) => l.includes("真正的目标")), "合法 fileTarget 应读到目标会话");
  });
});

test("sync: agent_write 按 action 校验参数，不产生无目标的空事件", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    const tools = buildTools({ bus, store, sourceStatus: () => ({}), log: () => {} });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const { agent } = fakeAgent();
    const exec = { agent };

    // note 缺 summary
    let r = await byName.agent_write.execute({ action: "note" }, exec);
    assert.equal(r.recorded, false);
    assert.ok(r.errors?.length, "note 缺 summary 应报错");
    assert.equal(bus.all().length, 0, "校验失败不得写进总线");

    // claim 给了 summary 但既无 paths 也无 command
    r = await byName.agent_write.execute({ action: "claim", summary: "要改点东西" }, exec);
    assert.equal(r.recorded, false);
    assert.ok(r.errors?.some((e) => e.includes("paths")), "claim 应要求 paths 或 command");
    assert.equal(bus.all().length, 0);

    // check 什么目标都没给
    r = await byName.agent_write.execute({ action: "check" }, exec);
    assert.ok(r.errors?.length, "check 无目标应报错");

    // 空白串视同没给
    r = await byName.agent_write.execute({ action: "claim", summary: "   ", paths: ["  "] }, exec);
    assert.equal(r.recorded, false, "纯空白应被清理后判为缺失");

    // 合法 claim：paths 优先于 command，且记为 file_write
    r = await byName.agent_write.execute({ action: "claim", summary: "改模型", paths: ["m.py"], command: "pytest" }, exec);
    assert.equal(r.recorded, true);
    assert.equal(bus.all().length, 1);
    assert.equal(bus.all()[0].kind, "file_write");
    assert.deepEqual(bus.all()[0].data.wrotePaths, ["m.py"]);

    // 合法 claim：只有命令
    r = await byName.agent_write.execute({ action: "claim", summary: "跑测试", command: "pytest -q" }, exec);
    assert.equal(bus.all().at(-1).kind, "command");
    assert.equal(bus.all().at(-1).data.command, "pytest -q");
  });
});

test("sync: 数值参数越界时报错而不是默默接受", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    const tools = buildTools({ bus, store, sourceStatus: () => ({}), log: () => {} });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const { agent } = fakeAgent();
    const exec = { agent };
    await assert.rejects(() => byName.agent_chat.execute({ limit: 0 }, exec), /limit/);
    await assert.rejects(() => byName.agent_chat.execute({ limit: 99999 }, exec), /limit/);
    await assert.rejects(() => byName.agent_chat.execute({ sinceMinutes: -5 }, exec), /sinceMinutes/);
    await assert.rejects(() => byName.agent_watch.execute({ sinceMinutes: 0 }, exec), /sinceMinutes/);
    // 边界值合法
    const ok = await byName.agent_chat.execute({ limit: 1, sinceMinutes: 1 }, exec);
    assert.equal(ok.denied, false);
  });
});

test("sync: sync_mode(participants=[]) 表达「不跟任何人同步」", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    const tools = buildTools({ bus, store, sourceStatus: () => ({}), log: () => {} });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const { agent } = fakeAgent();
    const exec = { agent };

    // 显式空数组：清空参与方（旧实现把 [] 当falsy 忽略，无法表达这个意图）
    const r = await byName.sync_mode.execute({ mode: "both", participants: [] }, exec);
    assert.equal(r.mode, "both");
    assert.deepEqual(r.readParticipants, [], "显式空数组应清空参与方");
    assert.deepEqual(r.writeParticipants, []);

    // 读也读不到
    assert.equal((await byName.agent_chat.execute({}, exec)).denied, true);

    // 不传 participants：沿用默认名单（与显式空数组语义不同）
    const r2 = await byName.sync_mode.execute({ mode: "both" }, exec);
    assert.deepEqual(r2.readParticipants, ["codex", "workbuddy"]);

    // 未知模式必须报错。两道防线：schema 的enum 先拦下（消息来自 dsh-tools），
    // 即使绕过 schema，setMode 内部还有一层 SYNC_MODES 校验。
    await assert.rejects(() => byName.sync_mode.execute({ mode: "sideways" }, exec), /mode/);
    await assert.rejects(() => store.setMode("sess-1", "sideways"), /未知模式/);
  });
});

test("store: 参与方名单里的 dsh/未知值被剔除，坏模式回落默认", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    // 直接写坏数据，模拟历史遗留或手工编辑
    store.data.settings["sess-x"] = { mode: "off", readParticipants: ["dsh", "codex", "ghost"] };
    const s = store.settingsFor("sess-x");
    assert.deepEqual(s.readParticipants, [], "off 模式应读不到任何东西");

    store.data.settings["sess-y"] = { mode: "sideways" };
    assert.equal(store.settingsFor("sess-y").mode, "both", "未知模式应回落到默认");

    store.data.settings["sess-z"] = { mode: "read", readParticipants: ["dsh", "ghost", "codex"] };
    assert.deepEqual(store.settingsFor("sess-z").readParticipants, ["codex"], "剔除 dsh 与未启用项");
  });
});

test("store: bind 拒绝非法目标（宁可失败也不要绑错人）", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    await assert.rejects(() => store.bind("s1", { participant: "dsh", targetSessionId: "x" }), /participant/);
    await assert.rejects(() => store.bind("s1", { participant: "codex", targetSessionId: "" }), /targetSessionId/);
    await assert.rejects(() => store.bind("s1", { participant: "codex" }), /targetSessionId/);
    await assert.rejects(() => store.bind("s1", { participant: "gemini", targetSessionId: "x" }), /未启用/);
    const ok = await store.bind("s1", { participant: "codex", targetSessionId: "cx-1" });
    assert.equal(ok.targetSessionId, "cx-1");
  });
});

test("push: 权限变化后收件箱会被重写（否则停留在旧内容）", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    const push = createPush({ bus, store, dir, participant: "codex", log: () => {} });

    // off 状态下先产生一条 dsh 事件（它不会出现在收件箱里）
    await store.setMode("s1", "off");
    bus.append(
      makeEvent({
        participant: "dsh",
        sessionId: "s1",
        cwd: "E:\\p",
        kind: "file_write",
        text: "改 models/vla.py",
        data: { paths: ["models/vla.py"], wrotePaths: ["models/vla.py"] },
        ts: Date.now(),
        sourceId: "p1",
      }),
    );
    await push.pushOnce();
    const blocked = await readFile(join(dir, "inbox", "codex.md"), "utf8");
    assert.ok(!blocked.includes("vla.py"), "off 时不该把内容推出去");

    // 切到 both：权限指纹变化，即使没有新 seq 也必须重写文件。
    // （首次推送时 lastPushedSeq 仍是 0，所以这条事件此刻确实算"新"，pushed=1。）
    await store.setMode("s1", "both");
    await push.pushOnce();
    const after = await readFile(join(dir, "inbox", "codex.md"), "utf8");
    assert.ok(after.includes("vla.py"), "权限放开后收件箱应包含此前被拦下的内容");

    // 真正的"无变化"路径：不应反复重写
    const noop = await push.pushOnce();
    assert.equal(noop.pushed, 0, "无新事件无权限变化时不应重复推送");

    // 权限再变一次（关掉），即使没有新事件也必须重写（内容应被移除）
    await store.setMode("s1", "off");
    const r = await push.pushOnce();
    const revoked = await readFile(join(dir, "inbox", "codex.md"), "utf8");
    assert.ok(!revoked.includes("vla.py"), "权限收回后内容应从收件箱移除");
    assert.equal(r.pushed, 0, "权限变化本身不算新增事件");
  });
});

test("push: 游标只推进到本 participant 可见的最大 seq（不吞掉后续事件）", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    const push = createPush({ bus, store, dir, participant: "codex", log: () => {} });
    await store.setMode("s1", "both");

    bus.append(
      makeEvent({ participant: "dsh", sessionId: "s1", cwd: "E:\\p", kind: "plan", text: "计划一", data: {}, ts: Date.now(), sourceId: "q1" }),
    );
    // 大量 codex 事件把全局 head 顶高，但它们对codex 收件箱不可见
    for (let i = 0; i < 20; i += 1) {
      bus.append(
        makeEvent({ participant: "codex", sessionId: `cx${i}`, cwd: "E:\\p", kind: "plan", text: `别人 ${i}`, data: {}, ts: Date.now(), sourceId: `c${i}` }),
      );
    }
    await push.pushOnce();

    // 随后的 dsh 事件 seq 高于上一批，但低于全局 head——不能被误判为已推送
    bus.append(
      makeEvent({ participant: "dsh", sessionId: "s1", cwd: "E:\\p", kind: "plan", text: "计划二", data: {}, ts: Date.now(), sourceId: "q2" }),
    );
    const r = await push.pushOnce();
    assert.equal(r.pushed, 1, "新的 dsh 事件必须被推送（用 bus.head() 当游标会丢事件）");
    const body = await readFile(join(dir, "inbox", "codex.md"), "utf8");
    assert.ok(body.includes("计划二"));
  });
});

test("args: 布尔/整数参数容忍字符串形态（模型常把 true 传成\"true\"）", async () => {
  // 回归守卫：宿主的参数校验在 execute 之前执行，类型不符直接抛 ToolArgsError，
  // 而模型拿到 `"deep" must be a boolean` 往往不知道怎么改，会原地重试
  // （实测同一轮连续 4 次同样的调用，白烧近 3 分钟）。
  // 修法：schema 用 oneOf 同时接受布尔与 "true"/"false"，execute 内再归一化。
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    seedCodex(bus);
    const fakeAdapter = {
      participant: "codex",
      listSessions: async () => [{ sessionId: "cx-1", title: "T", mtime: Date.now(), cwd: "E:\\proj\\T3VF", file: "f", bytes: 1 }],
      findActive: async () => null,
      readSession: async () => ({ events: [{ v: 1, participant: "codex", sessionId: "cx-1", kind: "user", role: "user", text: "深读目标", data: {}, ts: Date.now(), id: "x" }], offset: 1 }),
      follow: async () => {},
    };
    const tools = buildTools({
      bus,
      store,
      sourceStatus: () => ({ state: "running" }),
      adapters: new Map([["codex", fakeAdapter]]),
      log: () => {},
    });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const { agent } = fakeAgent();
    const exec = { agent };

    // 字符串 "true" 必须能用（这正是线上报错的场景）
    const r = await byName.agent_chat.execute({ deep: "true" }, exec);
    assert.ok(r.lines.some((l) => l.includes("深读目标")), `deep:"true" 应等价于 deep:true，实际 ${JSON.stringify(r.lines)}`);

    // 真正的布尔同样可用
    const r2 = await byName.agent_chat.execute({ deep: true }, exec);
    assert.equal(r2.total, r.total, "布尔与字符串两种写法结果应一致");

    // 字符串 "false" 不得被当成 true（否则会误触发深读）。
    // 深读会返回 session-1 的"深读目标"；浅读只会命中总线里那条 codex 事件。
    const r3 = await byName.agent_chat.execute({ deep: "false", keyOnly: "true" }, exec);
    assert.ok(!r3.lines.some((l) => l.includes("深读目标")), "deep:\"false\" 不应触发深读");
    assert.ok(r3.total > 0, "浅读仍应命中总线里已有的事件");

    // 字符串数字
    const w = await byName.agent_watch.execute({ sinceMinutes: "60" }, exec);
    assert.equal(typeof w.unread, "number");
    const h = await byName.agent_handoff.execute({ sinceMinutes: "1440", checkDisk: "false" }, exec);
    assert.ok(typeof h.ok === "boolean");

    // 真正错误的类型仍要被拒（宽容不等于纵容）
    for (const bad of [{ deep: "yes" }, { deep: 1 }, { deep: null }]) {
      await assert.rejects(() => byName.agent_chat.execute(bad, exec), /deep/);
    }
    await assert.rejects(() => byName.agent_watch.execute({ sinceMinutes: "abc" }, exec), /sinceMinutes/);
  });
});

test("args: listSessions 的字符串形态同样可用", async () => {
  await withTmp(async (dir) => {
    const { bus, store } = await makeStack(dir);
    seedCodex(bus);
    const tools = buildTools({ bus, store, sourceStatus: () => ({}), adapters: new Map(), log: () => {} });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const { agent } = fakeAgent();
    const exec = { agent };
    const r = await byName.agent_chat.execute({ listSessions: "true", sinceMinutes: 60 }, exec);
    assert.ok(r.sessions.length > 0, "listSessions:\"true\" 应返回会话清单");
  });
});

// ── 辅助函数 ────────────────────────────────────────────────────────────────

test("blocksToText 能拍平 ContentBlock[]", () => {
  assert.equal(blocksToText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(blocksToText("plain"), "plain");
  assert.equal(blocksToText(undefined), "");
});
