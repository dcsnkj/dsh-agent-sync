// 端到端验证「用户的实际使用场景」：
//   1. 绑定到 Codex 正在跑的那个会话
//   2. 用 deep=true 深读完整历史，问实验细节
//   3. 生成交接简报（准备接着干它剩下的活）
//
// 用法：node test/e2e-takeover.mjs

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../lib/bus.js";
import { SessionSyncStore } from "../lib/sessions.js";
import { createCodexAdapter } from "../lib/parsers/codex.js";
import { createWorkBuddyAdapter } from "../lib/parsers/workbuddy.js";
import { buildTools } from "../lib/tools.js";

const dir = await mkdtemp(join(tmpdir(), "agent-sync-takeover-"));
const bus = new EventBus({ busFile: join(dir, "events.ndjson"), cursorFile: join(dir, "cursors.json") });
const store = new SessionSyncStore({ file: join(dir, "state.json"), defaultMode: "both", enabledParticipants: ["codex", "workbuddy"] });
await bus.load();
await store.load();

const codex = createCodexAdapter({ log: () => {} });
const workbuddy = createWorkBuddyAdapter({ log: () => {} });
const adapterMap = new Map([["codex", codex], ["workbuddy", workbuddy]]);
const tools = buildTools({ bus, store, sourceStatus: () => ({ state: "running", adapters: ["codex", "workbuddy"] }), adapters: adapterMap, log: () => {} });
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

// 模拟用户就在 Codex 那个实验目录里跟我说话
const exec = {
  agent: { session: { header: { id: "dsh-user-session", cwd: "E:\\VS Code\\embodied AI\\C500\\VLA-JEPA" } } },
};

console.log("=== 1) agent_target: 自动选中同目录最近活跃的会话 ===");
const cur = await byName.agent_target.execute({ action: "bind" }, exec);
console.log("绑定结果:", JSON.stringify(cur.binding, null, 1));

console.log("\n=== 2) agent_chat(deep=true): 深读完整历史找细节 ===");
for (const q of ["Stage 1", "成功率", "随机配对"]) {
  const r = await byName.agent_chat.execute({ deep: true, query: q, keyOnly: true, limit: 6 }, exec);
  console.log(`\n查询「${q}」→ 命中 ${r.total} 条（目标 ${r.target?.participant}/${r.target?.sessionId}，${(r.target?.bytes / 1024 / 1024).toFixed(1)}MB）`);
  for (const line of r.lines.slice(-4)) console.log("   " + line.slice(0, 210));
}

console.log("\n=== 3) agent_handoff: 生成交接简报 ===");
const h = await byName.agent_handoff.execute({ sinceMinutes: 1440 }, exec);
console.log(`ok=${h.ok}`);
if (h.ok) {
  console.log(`目标=${h.brief.goal?.slice(0, 90)}`);
  console.log(`改动文件 ${h.brief.files} 个，命令 ${h.brief.commands.total} 条（失败 ${h.brief.commands.failed}）`);
  console.log(`未完成信号 ${h.brief.unresolved.length} 条:`);
  for (const u of h.brief.unresolved.slice(0, 5)) console.log("   - " + u.slice(0, 190));
  console.log("\n---- 简报前 40 行 ----");
  console.log(h.markdown.split("\n").slice(0, 40).join("\n"));
} else {
  console.log("失败:", h.target?.error);
}

await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
