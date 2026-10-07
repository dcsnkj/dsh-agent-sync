// 防重复闸门的确定性验证：模拟「Codex 刚改过某文件 / 刚跑过某命令」，
// 再用 agent_write(action=check) 问「我能不能安全地做同一件事」。
// 这是防止两个 agent 重复操作造成误差的核心能力，必须确认它真的会拦。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../lib/bus.js";
import { SessionSyncStore } from "../lib/sessions.js";
import { buildTools } from "../lib/tools.js";
import { makeEvent } from "../lib/contract.js";

const dir = await mkdtemp(join(tmpdir(), "agent-sync-conflict-"));
const bus = new EventBus({ busFile: join(dir, "events.ndjson"), cursorFile: join(dir, "cursors.json") });
const store = new SessionSyncStore({ file: join(dir, "state.json"), defaultMode: "both", enabledParticipants: ["codex", "workbuddy"] });
await bus.load();
await store.load();

const CWD = "E:\\VS Code\\embodied AI\\C500\\T3VF";
const now = Date.now();

// 同一个实验目录里的两个 agent
bus.append(
  makeEvent({
    participant: "codex",
    sessionId: "codex-active",
    cwd: CWD,
    kind: "file_write",
    text: "改 run_m3.sh",
    data: { paths: ["scripts/run_m3.sh"], wrotePaths: ["scripts/run_m3.sh"] },
    ts: now - 3 * 60 * 1000,
    sourceId: "codex-fw-1",
  }),
);
bus.append(
  makeEvent({
    participant: "codex",
    sessionId: "codex-active",
    cwd: CWD,
    kind: "command",
    text: "$ python -m experiments.m3 --seed 0",
    data: { command: "python -m experiments.m3 --seed 0", exitCode: 0 },
    ts: now - 2 * 60 * 1000,
    sourceId: "codex-cmd-1",
  }),
);
// 一个很久以前（窗口外）的改动：不应被当成冲突
bus.append(
  makeEvent({
    participant: "workbuddy",
    sessionId: "wb-old",
    cwd: CWD,
    kind: "file_write",
    text: "改 old_file.py",
    data: { paths: ["old_file.py"], wrotePaths: ["old_file.py"] },
    ts: now - 5 * 3600 * 1000,
    sourceId: "wb-fw-old",
  }),
);
await bus.flush();

const tools = buildTools({ bus, store, sourceStatus: () => ({ state: "running" }), log: () => {} });
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const exec = { agent: { session: { header: { id: "dsh-session", cwd: CWD } } } };

const cases = [
  { name: "改 Codex 3 分钟前刚改过的文件（应拦）", args: { action: "check", paths: ["scripts/run_m3.sh"] }, expect: 1 },
  { name: "改同一文件的绝对路径写法（应拦：路径归一化）", args: { action: "check", paths: ["E:\\VS Code\\embodied AI\\C500\\T3VF\\scripts\\run_m3.sh"] }, expect: 1 },
  { name: "跑 Codex 2 分钟前跑过的同一条命令（应拦）", args: { action: "check", command: "python -m experiments.m3 --seed 0" }, expect: 1 },
  { name: "改一个没人动过的文件（应放行）", args: { action: "check", paths: ["scripts/brand_new.sh"] }, expect: 0 },
  { name: "改 5 小时前别人改过的文件（超出窗口，应放行）", args: { action: "check", paths: ["old_file.py"] }, expect: 0 },
];

let failed = 0;
for (const c of cases) {
  const r = await byName.agent_write.execute(c.args, exec);
  const ok = r.conflictCount === c.expect;
  if (!ok) failed += 1;
  console.log(`${ok ? "✔" : "✖"} ${c.name}\n    期望冲突 ${c.expect}，实际 ${r.conflictCount}${r.conflicts.length ? `\n    → ${r.conflicts.join("\n    → ")}` : ""}`);
}

// 再验证：登记一条结论会真的进总线，并且对方读得到
const note = await byName.agent_write.execute(
  { action: "note", summary: "已确认 M3 全量跑完，结论：related 成功率略低是随机配对缺失导致" },
  exec,
);
await bus.flush();
const mine = bus.query({ participants: ["dsh"], limit: 10 });
console.log(`\n${note.recorded && mine.length === 1 ? "✔" : "✖"} note 已登记进总线（dsh 事件 ${mine.length} 条）`);

await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
console.log(failed === 0 ? "\nCONFLICT-GATE PASS" : `\nCONFLICT-GATE FAIL (${failed} 条不符)`);
process.exit(failed === 0 ? 0 : 1);
