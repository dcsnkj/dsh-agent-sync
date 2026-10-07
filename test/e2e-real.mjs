// 端到端验证：真实 EventBus + 真实 watcher + 真实 Codex/WorkBuddy 文件，
// 然后用 agent_chat 工具回答一个「实验细节」问题——即用户最想要的那个能力。
//
// 用法：node test/e2e-real.mjs [--keep] [--minutes 1440]

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { EventBus } from "../lib/bus.js";
import { SessionSyncStore } from "../lib/sessions.js";
import { createCodexAdapter } from "../lib/parsers/codex.js";
import { createWorkBuddyAdapter } from "../lib/parsers/workbuddy.js";
import { createWatcher } from "../lib/watch.js";
import { buildTools } from "../lib/tools.js";

const keep = process.argv.includes("--keep");
const minutesArg = process.argv.indexOf("--minutes");
const minutes = minutesArg > -1 ? Number(process.argv[minutesArg + 1]) : 1440;

const dir = await mkdtemp(join(tmpdir(), "agent-sync-e2e-"));
console.log("临时同步目录:", dir, "\n");

const bus = new EventBus({ busFile: join(dir, "events.ndjson"), cursorFile: join(dir, "cursors.json") });
const store = new SessionSyncStore({
  file: join(dir, "state.json"),
  defaultMode: "both",
  enabledParticipants: ["codex", "workbuddy"],
});
await bus.load();
await store.load();

const adapters = [createCodexAdapter({ log: () => {} }), createWorkBuddyAdapter({ log: () => {} })];
const watcher = createWatcher({ adapters, bus, pollMs: 1000, log: () => {} });

console.log("== 启动 watcher（真实文件，只读）==");
const t0 = Date.now();
await watcher.start();
// 给它时间做首轮索引 + 跟随
await new Promise((r) => setTimeout(r, 6000));
await bus.flush();

const st = watcher.status();
console.log("status:", JSON.stringify({
  activeSources: st.activeSources,
  lastPollAt: st.lastPollAt,
  started: st.started,
  followed: st.followed,
  adapters: st.adapters,
  indexFiles: st.offsets ? Object.keys(st.offsets).length : undefined,
}, null, 1));

console.log(`\n== 总线内容 ==`);
console.log("事件总数:", bus.all().length);
const byParticipant = {};
const byKind = {};
for (const e of bus.all()) {
  byParticipant[e.participant] = (byParticipant[e.participant] ?? 0) + 1;
  byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
}
console.log("按 participant:", JSON.stringify(byParticipant));
console.log("按 kind:", JSON.stringify(byKind));

await watcher.stop();

// ── 用工具回答真实问题 ────────────────────────────────────────────────────
const sourceStatus = () => ({ state: "running", adapters: ["codex", "workbuddy"], watcher: st });
const tools = buildTools({ bus, store, sourceStatus, log: () => {} });
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const exec = {
  agent: {
    session: {
      // 用 Codex 那个活跃会话的 cwd，模拟“同一个实验目录”
      header: { id: "e2e-session", cwd: "E:\\VS Code\\embodied AI\\C500\\VLA-JEPA" },
    },
  },
};

console.log("\n== agent_chat: 先列会话清单 ==");
const list = await byName.agent_chat.execute({ listSessions: true, sinceMinutes: minutes }, exec);
console.log(`命中 ${list.total} 条，会话 ${list.sessions.length} 个:`);
for (const s of list.sessions.slice(0, 8)) {
  console.log(`  - [${s.participant}] ${s.sessionId} 「${s.title ?? ""}」 ${s.events} 事件 / 改动文件 ${s.files.length} / 命令 ${s.commands}`);
}

console.log("\n== agent_chat: 关键操作时间线（最近 40 条）==");
const key = await byName.agent_chat.execute({ keyOnly: true, sinceMinutes: minutes, limit: 40 }, exec);
for (const line of key.lines.slice(-40)) console.log("  " + line);

console.log("\n== agent_chat: 关键词检索“实验/训练/评估” ==");
for (const q of ["训练", "评估", "实验"]) {
  const r = await byName.agent_chat.execute({ query: q, sinceMinutes: minutes, limit: 6 }, exec);
  console.log(`\n  查询「${q}」→ ${r.total} 条命中`);
  for (const line of r.lines.slice(-3)) console.log("    " + line.slice(0, 220));
}

console.log("\n== agent_write: 防重复检查（Codex 刚改过的文件）==");
const someFile = bus.all().find((e) => e.kind === "file_write" && (e.data?.wrotePaths ?? []).length)
  ?.data.wrotePaths[0];
if (someFile) {
  const chk = await byName.agent_write.execute({ action: "check", paths: [someFile] }, exec);
  console.log(`  文件 ${someFile} → 冲突 ${chk.conflictCount} 处`);
  for (const c of chk.conflicts) console.log("    " + c);
} else {
  console.log("  （本轮没抓到 file_write，跳过）");
}

console.log("\n== agent_watch ==");
const w = await byName.agent_watch.execute({ sinceMinutes: minutes }, exec);
console.log(`  活跃会话 ${w.active.length} 个，未读 ${w.unread} 条，最近动作 ${w.recent.length} 条`);
for (const line of w.recent.slice(-5)) console.log("    " + line.slice(0, 200));

console.log(`\n总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (!keep) await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
else console.log("保留目录:", dir);
