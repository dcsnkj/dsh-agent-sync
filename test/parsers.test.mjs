// dsh-agent-sync — 解析器 / watcher 测试（node:test，无第三方依赖）
//
// 覆盖：
//   1) 合成 JSONL（test/fixtures）解析出的 kind / participant / sessionId 正确；
//   2) 增量：同一文件解析两次，第二次 0 条新事件；
//   3) 损坏行（半行 JSON、空行、非 JSON 垃圾）被跳过且不抛；
//   4) classifyToolName：apply_patch→file_write、shell/bash→command 等；
//   5) 真实文件冒烟：遍历 ~/.codex/sessions 与 ~/.workbuddy/projects 取最新文件各解析一次；
//   6) watch.js：增量投递、offset 记忆、stop() 幂等且不留悬挂 timer。
//
// 运行：node --test test/

import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";

import { KINDS, classifyToolName } from "../lib/contract.js";
import { createCodexAdapter, defaultSessionsDir, resolveRolloutPath } from "../lib/parsers/codex.js";
import { createWorkBuddyAdapter, defaultProjectsDir } from "../lib/parsers/workbuddy.js";
import { createWatcher } from "../lib/watch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const CODEX_FIX = join(FIXTURES, "codex");
const CODEX_ZST_FIX = join(FIXTURES, "codex-zst");
const CODEX_CORRUPT_FIX = join(FIXTURES, "codex-corrupt");
const WB_FIX = join(FIXTURES, "workbuddy");

const CODEX_UUID = "11111111-2222-3333-4444-555555555555";
const WB_UUID = "aaaaaaaa-1111-2222-3333-444444444444";
const WB_MAIN = join(WB_FIX, "c-Users-fixture-demo-2026-01-02-03-04-05", `${WB_UUID}.jsonl`);
const WB_WSFOLDER = join(WB_FIX, "c-Users-fixture-wsfolder-2026-01-02-03-04-05", "cccccccc-1111-2222-3333-444444444444.jsonl");
const WB_SLUGONLY = join(WB_FIX, "c-Users-fixture-slugonly-2026-01-02-03-04-05", "dddddddd-1111-2222-3333-444444444444.jsonl");
const CODEX_MAIN = join(CODEX_FIX, `rollout-2026-01-02T03-04-05-${CODEX_UUID}.jsonl`);

/** 与 lib/contract.js 的信封约定逐条对齐。 */
function assertEnvelope(ev, participant) {
  assert.equal(ev.v, 1, "v 必须是 1");
  assert.equal(ev.participant, participant);
  assert.ok(KINDS.includes(ev.kind), `kind ${ev.kind} 必须在 KINDS 里`);
  assert.ok(typeof ev.sessionId === "string" && ev.sessionId.length > 0, "sessionId 不能为空");
  assert.ok(typeof ev.id === "string" && ev.id.length > 0, "id 不能为空");
  assert.ok(Number.isFinite(ev.ts) && ev.ts > 0, "ts 必须是 epoch ms");
  assert.ok(typeof ev.sourceFile === "string" && ev.sourceFile.length > 0, "sourceFile 必须有");
  assert.ok(Number.isInteger(ev.sourceOffset) && ev.sourceOffset >= 0, "sourceOffset 必须是字节偏移整数");
}

/** kind → 条数，便于整数断言，防止噪声记录混进来。 */
function kindCounts(events) {
  const out = {};
  for (const ev of events) out[ev.kind] = (out[ev.kind] ?? 0) + 1;
  return out;
}

/** 事件里可见的全部文本（含 data），用于断言"不该出现的东西没出现"。 */
function haystack(ev) {
  return `${ev.text}\n${ev.sessionTitle ?? ""}\n${JSON.stringify(ev.data ?? null)}`;
}

async function waitFor(predicate, timeoutMs = 4000, step = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(step);
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// 1) Codex 合成 JSONL
// ---------------------------------------------------------------------------

test("codex：合成 JSONL 的 kind / participant / sessionId 与噪声过滤", async () => {
  const adapter = createCodexAdapter({ sessionsDir: CODEX_FIX });
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 1, "fixtures/codex 下应只有一个会话");

  const s = sessions[0];
  assert.equal(s.participant, "codex");
  assert.equal(s.sessionId, CODEX_UUID);
  assert.equal(s.cwd, "E:\\fixtures\\codex-demo");
  assert.equal(s.events, 18, "摘要里的记录数 = 文件行数（含噪声行）");
  assert.equal(s.title, "请给 demo.py 补注释并跑测试", "标题要跳过 <environment_context> 那条自动上下文");
  assert.ok(s.filesTouched.includes("demo.py"), "apply_patch 改的文件要进 filesTouched");
  assert.ok(s.commands.includes("python -m pytest -q"));
  assert.ok(s.commands.includes("git status --short"));

  const { events, offset, bytes } = await adapter.readSession(s, { sinceOffset: 0 });
  assert.equal(events.length, 12, "18 行里只有 12 行该产出事件");
  assert.deepEqual(kindCounts(events), {
    meta: 2, // session_meta + token_usage_record
    turn: 2, // task_started + task_complete
    user: 1,
    assistant: 1,
    command: 3, // function_call(shell) + custom_tool_call(exec) + function_call(write_stdin)
    tool: 1, // function_call_output
    file_write: 1, // custom_tool_call(apply_patch)
    reasoning: 1,
  });
  events.forEach((ev) => assertEnvelope(ev, "codex"));
  assert.equal(offset, bytes, "读到文件末尾（fixture 以换行结束）");

  const user = events.find((e) => e.kind === "user");
  assert.equal(user.text, "请给 demo.py 补注释并跑测试");
  assert.equal(user.ts, Date.parse("2026-01-02T03:04:06.000Z"));
  assert.equal(user.sessionId, CODEX_UUID);
  assert.equal(user.cwd, "E:\\fixtures\\codex-demo");
  assert.equal(user.role, "user");
  assert.equal(user.sourceFile, CODEX_MAIN);

  const shell = events.find((e) => e.data?.name === "shell");
  assert.equal(shell.kind, "command", "shell → command");
  assert.equal(shell.data.command, "python -m pytest -q");
  assert.equal(shell.sourceId, "call-1");

  const exec = events.find((e) => e.data?.name === "exec");
  assert.equal(exec.kind, "command", "Codex 的 exec 脚本沙箱算命令");
  assert.equal(exec.data.command, "git status --short", "从 exec 脚本里抽出真正的命令");

  const stdin = events.find((e) => e.data?.name === "write_stdin");
  assert.equal(stdin.kind, "command", "write_stdin 是给进程写 stdin，不能误判成 file_write");

  const patch = events.find((e) => e.kind === "file_write");
  assert.deepEqual(patch.data.paths, ["demo.py"]);
  assert.equal(patch.sourceId, "call-2");

  const result = events.find((e) => e.kind === "tool");
  assert.equal(result.data.exitCode, 0, "function_call_output 要抽出 exit_code");
  assert.equal(result.data.callId, "call-1");

  const usage = events.find((e) => e.kind === "meta" && e.data?.usage);
  assert.equal(usage.data.usage.input_tokens, 100);
  assert.equal(usage.data.usage.total_tokens, 120);
  assert.ok(usage.text.includes("total=120"));
  assert.equal(usage.data.usage.secret_note, undefined, "非数字字段不得进 data");
  assert.ok(!JSON.stringify(usage).includes("FIXTURE-SECRET"), "token 记录里只留数字");

  const reasoning = events.find((e) => e.kind === "reasoning");
  assert.equal(reasoning.text, "先跑测试，再改文件。");

  // 噪声与机密：developer/system/world_state/item_completed/encrypted/base_instructions 一律不得出现
  const forbidden = [
    "FIXTURE-BASE-INSTRUCTIONS-MUST-NOT-LEAK",
    "FIXTURE-DEVELOPER-NOISE",
    "FIXTURE-ENV-CONTEXT-NOISE",
    "FIXTURE-SYSTEM-NOISE",
    "FIXTURE-WORLD-STATE-NOISE",
    "FIXTURE-ENCRYPTED-MUST-NOT-LEAK",
    "FIXTURE-SECRET-MUST-NOT-LEAK",
    "FIXTURE-ITEM-COMPLETED-DUPLICATE",
  ];
  const all = events.map(haystack).join("\n");
  for (const needle of forbidden) assert.ok(!all.includes(needle), `${needle} 不应出现在任何事件里`);

  // sourceOffset 单调递增且都落在文件内；sourceId 唯一
  const offsets = events.map((e) => e.sourceOffset);
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b), "sourceOffset 必须递增");
  assert.ok(Math.max(...offsets) < bytes);
  assert.equal(new Set(events.map((e) => e.id)).size, events.length, "事件 id 必须唯一");
});

// ---------------------------------------------------------------------------
// 2) 增量
// ---------------------------------------------------------------------------

test("增量：同一文件解析两次，第二次 0 条新事件", async () => {
  const adapter = createCodexAdapter({ sessionsDir: CODEX_FIX });
  const [s] = await adapter.listSessions();

  const first = await adapter.readSession(s, { sinceOffset: 0 });
  assert.ok(first.events.length > 0);
  const second = await adapter.readSession(s, { sinceOffset: first.offset });
  assert.equal(second.events.length, 0, "从上次 offset 继续读不应再产出事件");
  assert.equal(second.offset, first.offset, "offset 不应回退");

  // 有点偏移（哪怕不落在行首）也要对齐到下一行，不产出重复事件
  const mid = await adapter.readSession(s, { sinceOffset: 40 });
  assert.equal(new Set(mid.events.map((e) => e.sourceOffset)).size, mid.events.length);
  assert.ok(mid.events.length < first.events.length, "从文件中间开始读，事件数应更少");

  // WorkBuddy 同理
  const wb = createWorkBuddyAdapter({ projectsDir: WB_FIX });
  const wbSessions = await wb.listSessions();
  const wbMain = wbSessions.find((x) => x.sessionId === WB_UUID);
  assert.ok(wbMain, "应能发现 WorkBuddy 主 fixture");
  const wbFirst = await wb.readSession(wbMain, { sinceOffset: 0 });
  assert.ok(wbFirst.events.length > 0);
  const wbSecond = await wb.readSession(wbMain, { sinceOffset: wbFirst.offset });
  assert.equal(wbSecond.events.length, 0);
});

// ---------------------------------------------------------------------------
// 3) 损坏行
// ---------------------------------------------------------------------------

test("损坏行：半行 JSON / 空行 / 非 JSON 垃圾被跳过且不抛", async () => {
  const adapter = createCodexAdapter({ sessionsDir: CODEX_CORRUPT_FIX });
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 1);
  const s = sessions[0];

  const first = await adapter.readSession(s);
  assert.equal(first.events.length, 3, "只有 session_meta + 两条完整 message 能产出事件");
  assert.deepEqual(
    first.events.map((e) => e.kind),
    ["meta", "user", "assistant"],
  );
  assert.equal(first.events[1].text, "坏行之后仍然要读到这条", "坏行不能中断后续解析");
  assert.ok(first.offset < s.bytes, "末尾半行不能被消费掉");
  assert.ok(first.events.at(-1).sourceOffset < s.bytes);

  // 半行停留处再读：0 条，且不抛
  const second = await adapter.readSession(s, { sinceOffset: first.offset });
  assert.equal(second.events.length, 0);

  // 文件根本不存在也不能抛
  const missing = await adapter.readSession({ participant: "codex", sessionId: "x", file: join(CODEX_CORRUPT_FIX, "nope.jsonl") });
  assert.deepEqual(missing.events, []);

  // 目录不存在时 listSessions 返回空数组而不是抛错
  const nowhere = createCodexAdapter({ sessionsDir: join(CODEX_CORRUPT_FIX, "does-not-exist") });
  assert.deepEqual(await nowhere.listSessions(), []);
  assert.equal(await nowhere.findActive(), null);
});

// ---------------------------------------------------------------------------
// 4) classifyToolName
// ---------------------------------------------------------------------------

test("classifyToolName：apply_patch→file_write、shell/bash→command", () => {
  assert.equal(classifyToolName("apply_patch"), "file_write");
  assert.equal(classifyToolName("shell"), "command");
  assert.equal(classifyToolName("bash"), "command");
  assert.equal(classifyToolName("Bash"), "command");
  assert.equal(classifyToolName("PowerShell"), "command");
  assert.equal(classifyToolName("exec_command"), "command");
  assert.equal(classifyToolName("Write"), "file_write");
  assert.equal(classifyToolName("Edit"), "file_write");
  assert.equal(classifyToolName("Read"), "file_read");
  assert.equal(classifyToolName("read_file"), "file_read");
  assert.equal(classifyToolName("TodoWrite"), "plan");
  assert.equal(classifyToolName("WebFetch"), "tool");
});

// ---------------------------------------------------------------------------
// WorkBuddy 合成 JSONL
// ---------------------------------------------------------------------------

test("workbuddy：合成 JSONL 的 kind / participant / sessionId 与快照去重", async () => {
  const adapter = createWorkBuddyAdapter({ projectsDir: WB_FIX });
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 3, "三个 fixture 工程目录都应被发现");
  assert.deepEqual(
    sessions.map((s) => s.sessionId).sort(),
    [WB_UUID, "cccccccc-1111-2222-3333-444444444444", "dddddddd-1111-2222-3333-444444444444"].sort(),
  );

  const s = sessions.find((x) => x.sessionId === WB_UUID);
  assert.ok(s, "session-meta 里的 sessionId 要生效");
  assert.equal(s.participant, "workbuddy");
  assert.equal(s.cwd, "E:\\fixtures\\wb-demo", "cwd 取记录里的 cwd 字段");
  assert.equal(s.title, "修复 main.py 的 bug", "ai-title 优先作为标题");
  assert.ok(s.filesTouched.includes("E:\\fixtures\\wb-demo\\main.py"));

  const { events } = await adapter.readSession(s, { sinceOffset: 0 });
  assert.equal(events.length, 12, "14 行里 file-history-snapshot(main.py) 因与 Edit 重复被抑制、notice 被丢弃");
  assert.deepEqual(kindCounts(events), {
    meta: 2, // session-meta + ai-title
    user: 1,
    reasoning: 1,
    file_read: 1,
    file_write: 2, // Edit + snapshot(tests/test_main.py)
    command: 1, // Bash
    tool: 3, // Read / Edit / Bash 的结果
    plan: 1, // TaskUpdate 是待办/计划通道
  });
  events.forEach((ev) => assertEnvelope(ev, "workbuddy"));
  assert.ok(events.every((e) => e.sessionId === WB_UUID), "sessionId 全部来自 session-meta");
  assert.ok(events.every((e) => e.sessionTitle === "修复 main.py 的 bug"), "标题要带上");
  assert.ok(events.every((e) => e.cwd === "E:\\fixtures\\wb-demo"));

  const edit = events.find((e) => e.kind === "file_write" && e.data?.name === "Edit");
  assert.deepEqual(edit.data.paths, ["E:\\fixtures\\wb-demo\\main.py"]);
  assert.equal(edit.text.startsWith("Edit: "), true);

  const snapshot = events.find((e) => e.kind === "file_write" && !e.data?.name);
  assert.deepEqual(snapshot.data.paths, ["E:\\fixtures\\wb-demo\\tests\\test_main.py"], "相对路径按 cwd 补全");

  const read = events.find((e) => e.kind === "file_read");
  assert.equal(read.data.name, "Read");
  assert.equal(read.data.callId, "call-wb-1");

  const bash = events.find((e) => e.kind === "command");
  assert.equal(bash.data.command, "python -m pytest -q");

  const plan = events.find((e) => e.kind === "plan");
  assert.equal(plan.data.name, "TaskUpdate", "TaskCreate/TaskUpdate 归入 plan 通道");
  assert.equal(plan.data.callId, "call-wb-4");

  const result = events.find((e) => e.kind === "tool" && e.data?.callId === "call-wb-1");
  assert.equal(result.data.status, "completed");
  assert.ok(result.text.includes("main.py"));

  // providerData.reasoning 是重复内容，不应单独产出事件
  assert.ok(!events.map(haystack).join("\n").includes("providerData 里的思考"), "providerData.reasoning 不应产出事件");
});

test("workbuddy：cwd 兜底（Workspace Folder 行 / project-slug 反解）与 sessionId 兜底", async () => {
  const adapter = createWorkBuddyAdapter({ projectsDir: WB_FIX });

  // 没有 session-meta，也没有 cwd 字段 → sessionId 取文件名，cwd 取 "Workspace Folder:" 行
  const wsFolder = await adapter.readSession(
    { participant: "workbuddy", sessionId: "cccccccc-1111-2222-3333-444444444444", file: WB_WSFOLDER },
    { sinceOffset: 0 },
  );
  assert.equal(wsFolder.events.length, 2);
  assert.ok(wsFolder.events.every((e) => e.cwd === "E:\\fixtures\\ws-fallback"));
  wsFolder.events.forEach((ev) => assertEnvelope(ev, "workbuddy"));
  assert.equal(wsFolder.events[0].kind, "user");

  const wsSummary = (await adapter.listSessions()).find((x) => x.file === WB_WSFOLDER);
  assert.equal(wsSummary.sessionId, "cccccccc-1111-2222-3333-444444444444", "无 session-meta 时退化到文件名");
  assert.equal(wsSummary.cwd, "E:\\fixtures\\ws-fallback");

  // 既无 session-meta / cwd，也无 Workspace Folder 行 → cwd 由 slug 反解
  const slug = (await adapter.listSessions()).find((x) => x.file === WB_SLUGONLY);
  assert.equal(slug.sessionId, "dddddddd-1111-2222-3333-444444444444");
  assert.equal(slug.cwd, "C:\\Users\\fixture\\slugonly\\2026-01-02-03-04-05");
  const slugEvents = await adapter.readSession(slug, { sinceOffset: 0 });
  assert.equal(slugEvents.events.length, 1);
  assert.equal(slugEvents.events[0].cwd, "C:\\Users\\fixture\\slugonly\\2026-01-02-03-04-05");
});

// ---------------------------------------------------------------------------
// 5) 真实文件冒烟（目录不存在则跳过，不硬编码日期）
// ---------------------------------------------------------------------------

/** 取最新会话；若最新文件恰好解析不出事件，就往下找最近一个能解析出事件的会话。 */
async function smokeLatest(adapter, t, label, maxTries = 5) {
  const sessions = await adapter.listSessions();
  assert.ok(sessions.length > 0, `${label}: 至少要发现一个会话`);
  let lastError = null;
  for (const s of sessions.slice(0, maxTries)) {
    let res;
    try {
      res = await adapter.readSession(s, { sinceOffset: 0 });
    } catch (err) {
      lastError = err;
      continue;
    }
    if (res.events.length > 0) {
      res.events.forEach((ev) => assertEnvelope(ev, adapter.participant));
      t.diagnostic(
        `${label}: ${basename(s.file)} bytes=${s.bytes} mtime=${new Date(s.mtime).toISOString()} 摘要records=${s.events}` +
          ` 解析events=${res.events.length} kinds=${JSON.stringify(kindCounts(res.events))}`,
      );
      for (const ev of res.events.slice(0, 3)) {
        t.diagnostic(`  样例 ${ev.kind}: ${JSON.stringify(ev).slice(0, 200)}`);
      }
      return { session: s, events: res.events };
    }
  }
  assert.fail(`${label}: 前 ${maxTries} 个会话都解析不出事件${lastError ? ` (${lastError.message})` : ""}`);
}

test("真实冒烟：Codex 最新会话能解析出事件", { skip: !existsSync(defaultSessionsDir()) }, async (t) => {
  const adapter = createCodexAdapter();
  const { events, session } = await smokeLatest(adapter, t, "codex");
  assert.ok(events.length > 0);
  assert.ok(session.sessionId && session.sessionId.length > 0);
  // 每个事件都要有合法信封字段与递增偏移
  const offsets = events.map((e) => e.sourceOffset);
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
  t.diagnostic(`codex: sessionId=${session.sessionId} cwd=${session.cwd ?? "-"} title=${session.title ?? "-"}`);
});

test("真实冒烟：WorkBuddy 最新会话能解析出事件", { skip: !existsSync(defaultProjectsDir()) }, async (t) => {
  const adapter = createWorkBuddyAdapter();
  const { events, session } = await smokeLatest(adapter, t, "workbuddy");
  assert.ok(events.length > 0);
  assert.ok(session.sessionId && session.sessionId.length > 0);
  t.diagnostic(`workbuddy: sessionId=${session.sessionId} cwd=${session.cwd ?? "-"} title=${session.title ?? "-"}`);
});

// ---------------------------------------------------------------------------
// 6) watch.js
// ---------------------------------------------------------------------------

/** 只做去重 + 记录的最小总线替身（EventBus 的 append 语义）。 */
function fakeBus() {
  const ids = new Set();
  const events = [];
  return {
    events,
    append(input) {
      const list = Array.isArray(input) ? input : [input];
      let n = 0;
      for (const ev of list) {
        if (!ev || !ev.id || ids.has(ev.id)) continue;
        ids.add(ev.id);
        events.push(ev);
        n += 1;
      }
      return n;
    },
    head() {
      return events.length;
    },
  };
}

test("watch.js：增量投递、offset 记忆、stop() 幂等且不留悬挂 timer", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "dsh-watch-"));
  const dst = join(tmp, basename(CODEX_MAIN));
  copyFileSync(CODEX_MAIN, dst);
  // 必须把 mtime 拨到现在：codex adapter 的 findActive() 只认「1 小时内被写入」的
  // 活跃会话，而 copyFileSync 保留源文件时间戳。fixture 一旦放置超过 1 小时，
  // findActive() 就会返回 null，这个用例会毫无预兆地开始失败（与代码改动无关）。
  const nowSec = Date.now() / 1000;
  utimesSync(dst, nowSec, nowSec);

  const adapter = createCodexAdapter({ sessionsDir: tmp, pollMs: 30 });
  const bus = fakeBus();
  const w = createWatcher({ adapters: [adapter], bus, pollMs: 30, indexEveryMs: 0, log: () => {} });
  try {
    const st0 = await w.start();
    assert.equal(st0.started, true);
    assert.ok(bus.events.length > 0, "启动时应把活跃会话增量读入总线");
    const baseline = bus.events.length;
    assert.ok(st0.offsets[dst] > 0, "offset 账本要记下已读字节");
    assert.equal(st0.activeSources.length, 1);
    assert.equal(st0.activeSources[0].participant, "codex");
    assert.ok(st0.lastPollAt > 0);
    assert.equal(new Set(bus.events.map((e) => e.id)).size, bus.events.length);

    // 追加一条新记录 → 跟随/轮询必须把它投递出来，且不重复
    appendFileSync(
      dst,
      `${JSON.stringify({
        timestamp: "2026-01-02T05:00:00.000Z",
        type: "response_item",
        payload: { type: "message", id: "appended-1", role: "user", content: [{ type: "input_text", text: "增量追加的一条" }] },
      })}\n`,
      "utf8",
    );
    const grew = await waitFor(() => bus.events.length > baseline, 5000);
    assert.ok(grew, "追加后应产出新事件");
    assert.ok(bus.events.some((e) => e.text === "增量追加的一条"));
    assert.equal(new Set(bus.events.map((e) => e.id)).size, bus.events.length, "不得重复投递");

    // stop 必须幂等，且之后不再投递
    await w.stop();
    await w.stop();
    const afterStop = bus.events.length;
    await delay(200);
    assert.equal(bus.events.length, afterStop, "stop 之后不得再投递");
    assert.equal(w.status().started, false);
    assert.ok(Object.keys(w.status().offsets).includes(dst), "stop 后保留 offset，便于不留重复地重启");

    // 带 offsets 重新 start：不得重复投递旧内容
    const w2 = createWatcher({ adapters: [adapter], bus, pollMs: 30, offsets: w.offsets, log: () => {} });
    await w2.start();
    await w2.stop();
    assert.equal(new Set(bus.events.map((e) => e.id)).size, bus.events.length, "重启后 id 仍不得重复");

    // 必填参数缺失要抛（Lead 会 catch 后降级）
    await assert.rejects(() => createWatcher({ adapters: [adapter] }).start(), /bus/);
  } finally {
    await w.stop();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── zstd 压缩会话（借鉴 codex-trace 的 compression.rs）──────────────────────
// Codex 上游的后台压缩 worker 会把冷下来的 rollout-*.jsonl 换成同名
// .jsonl.zst 并删掉原文件。若只认 ".jsonl"，届时会话会从列表消失、
// 正在跟随的文件会静默停更，且不报任何错。

test("codex：发现 .jsonl.zst 压缩会话，且与明文版摘要一致", async () => {
  const adapter = createCodexAdapter({ sessionsDir: CODEX_ZST_FIX });
  const sessions = await adapter.listSessions();
  const zst = sessions.find((s) => s.file.endsWith(".jsonl.zst"));
  assert.ok(zst, "应发现 .jsonl.zst 会话");
  // 关键：标题/cwd 必须从压缩内容里解出来，不能是 undefined
  assert.equal(zst.title, "请给 demo.py 补注释并跑测试", "压缩会话应能解出标题");
  assert.equal(zst.cwd, "E:\\fixtures\\codex-demo", "压缩会话应能解出 cwd");
  assert.equal(zst.events, 6, "应统计出全部 6 条记录");
  assert.equal(zst.sessionId, "77777777-2222-3333-4444-555555555555");
});

test("codex：多帧 zstd 必须全部解出（内置 API 只给第一帧）", async () => {
  // 实测：把 6 行分 3 帧压缩后，Node 内置 zstdDecompressSync 只解出 2 行，
  // 剩下 4 行静默丢失。因此我们实现了自制的多帧解码器。
  const adapter = createCodexAdapter({ sessionsDir: CODEX_ZST_FIX });
  const sessions = await adapter.listSessions();
  const zst = sessions.find((s) => s.file.includes("77777777") && s.file.endsWith(".zst"));
  const r = await adapter.readSession(zst, { sinceOffset: 0 });
  assert.ok(r.events.length >= 4, `多帧应解出至少 4 个事件，实际 ${r.events.length}`);
  const kinds = r.events.map((e) => e.kind);
  assert.ok(kinds.includes("meta"), "首帧的 session_meta 应解出");
  assert.ok(kinds.includes("user") || kinds.includes("assistant"), "后续帧的内容不应丢失");

  // 对照：内置 API 在同样输入上会丢数据（证明这个测试是有意义的）
  const raw = readFileSync(zst.file);
  const naive = zstdDecompressSync(raw).toString("utf8").split("\n").filter(Boolean).length;
  assert.ok(naive < 6, `内置 API 预期只能解出部分帧（实得 ${naive} 行）`);
});

test("codex：resolveRolloutPath 在明文被换成 .zst 后能回退", async () => {
  const plain = join(CODEX_ZST_FIX, "rollout-2026-01-02T03-04-05-77777777-2222-3333-4444-555555555555.jsonl");
  // 明文不存在、.zst 存在 → 应回退到 .zst
  assert.equal(await resolveRolloutPath(plain), `${plain}.zst`);
  // 传入的就是 .zst → 原样返回
  assert.equal(await resolveRolloutPath(`${plain}.zst`), `${plain}.zst`);
  // 两者都不存在 → null
  assert.equal(await resolveRolloutPath(join(CODEX_ZST_FIX, "nope.jsonl")), null);
});

// ── 命令退出码回填（Codex 把一次调用拆成"发起"与"结果"两条记录）──────────
// 实测：223 条 call_output 里大多数 output 是**字符串**形态，退出码写成
// 自然语言 "Process exited with code 0"，而不是 JSON 的 "exit_code":0。
// 只认 JSON 形态会让退出码大面积缺失 → 交接简报里"成功 0，失败 0"，失败也看不出。

test("contract: extractResultData 同时认JSON 与自然语言两种退出码", async () => {
  const { extractResultData } = await import("../lib/contract.js");
  // JSON 形态
  assert.equal(extractResultData('{"exit_code":0,"output":"ok"}').exitCode, 0);
  assert.equal(extractResultData('{"exit_code":2}').exitCode, 2);
  // 自然语言形态（function_call_output 的 string output）
  assert.equal(extractResultData("Process exited with code 0").exitCode, 0);
  assert.equal(extractResultData("Process exited with code 1").exitCode, 1);
  assert.equal(extractResultData("Exit code: 127").exitCode, 127);
  assert.equal(extractResultData("exit status 3").exitCode, 3);
  // 非0 即失败
  assert.equal(extractResultData("Process exited with code 1").isError, true);
  assert.equal(extractResultData("Process exited with code 0").isError, undefined);
  // 无退出码时不应臆造
  assert.equal(extractResultData("plain output").exitCode, undefined);
});

test("codex：命令事件的退出码能从结果记录回填", async () => {
  // 构造一个最小场景：发起(function_call) 与 结果(*_call_output) 两条记录，
  // 验证结果侧的 exitCode 会被挂回发起侧。
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const tmp = mkdtempSync(join(tmpdir(), "dsh-cmd-"));
  try {
    const uuid = "12345678-2222-3333-4444-555555555555";
    const recs = [
      { timestamp: "2026-01-02T03:04:05.000Z", type: "session_meta", payload: { session_id: uuid, cwd: "E://t", cli_version: "0" } },
      { timestamp: "2026-01-02T03:04:06.000Z", type: "response_item", payload: { type: "function_call", name: "shell", call_id: "call_a1", arguments: JSON.stringify({ command: ["bash","-lc","exit 3"] }) } },
      { timestamp: "2026-01-02T03:04:07.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_a1", output: "Process exited with code 3" } },
      { timestamp: "2026-01-02T03:04:08.000Z", type: "response_item", payload: { type: "function_call", name: "shell", call_id: "call_b2", arguments: JSON.stringify({ command: ["bash","-lc","echo hi"] }) } },
      { timestamp: "2026-01-02T03:04:09.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_b2", output: "Process exited with code 0" } },
    ];
    const file = join(tmp, `rollout-2026-01-02T03-04-05-${uuid}.jsonl`);
    writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    const adapter = createCodexAdapter({ sessionsDir: tmp, activeWindowMs: 0 });
    const [s] = await adapter.listSessions();
    const r = await adapter.readSession(s, { sinceOffset: 0 });
    const cmds = r.events.filter((e) => e.kind === "command");
    assert.equal(cmds.length, 2, "两条 shell 调用都应产出 command 事件");
    const a1 = cmds.find((c) => c.data?.callId === "call_a1");
    const b2 = cmds.find((c) => c.data?.callId === "call_b2");
    assert.equal(a1?.data?.exitCode, 3, "失败命令的退出码应回填");
    assert.equal(a1?.data?.isError, true, "非 0 退出码应标记 isError");
    assert.equal(b2?.data?.exitCode, 0, "成功命令的退出码应回填");
    assert.equal(b2?.data?.isError, undefined, "exit 0 不应标记失败");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
