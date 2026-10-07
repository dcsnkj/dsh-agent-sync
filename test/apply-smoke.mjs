// 在「Host 等价环境」里真实执行插件的 apply()。
//
// 目的：证明 lib/index.js 的整个模块图（含 @deepseek-ai 真实依赖）能加载、
// apply() 不抛异常、四个工具与运行时上下文都注册成功。
// 这是重启 DSH 之前的最后一道自检。
//
// 用法（工作目录必须是 profile 目录，才能解析 @local/@deepseek-ai）：
//   node test/apply-smoke.mjs <profileDir>

import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { existsSync } from "node:fs";

const profileDir = process.argv[2] ?? process.cwd();
// profile 自己的 node_modules，或共享的 <profiles>/node_modules（desktop 用后者）
const candidates = [
  join(profileDir, "node_modules", "@local", "dsh-agent-sync", "lib", "index.js"),
  join(profileDir, "..", "node_modules", "@local", "dsh-agent-sync", "lib", "index.js"),
];
const entry = candidates.find((p) => existsSync(p));
if (!entry) {
  console.error("找不到插件入口，试过:\n" + candidates.join("\n"));
  process.exit(2);
}
console.log("entry =", entry);

/** 记录注册内容的假 ctx。 */
function makeCtx() {
  const tools = [];
  const sections = [];
  const contexts = [];
  const handlers = new Map();
  const effects = [];
  let logLines = [];
  return {
    tools: { registered: tools, register: (t) => tools.push(t) },
    systemPrompt: {
      section: (s) => sections.push(s),
      context: (c) => contexts.push(c),
      getSectionOrder: () => 0,
      getContextOrder: () => 0,
    },
    on: (name, fn) => {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    effect: (fn) => {
      const dispose = fn();
      effects.push(dispose);
    },
    logger: { info: (m) => logLines.push(m), warn: (m) => logLines.push(m) },
    get _tools() {
      return tools;
    },
    get _sections() {
      return sections;
    },
    get _contexts() {
      return contexts;
    },
    get _handlers() {
      return handlers;
    },
    get _logs() {
      return logLines;
    },
    async _disposeAll() {
      for (const d of effects) if (typeof d === "function") await d();
    },
  };
}

const mod = await import(pathToFileURL(entry).href);
console.log("== plugin module loaded ==");
console.log("name =", mod.name);
console.log("inject =", JSON.stringify(mod.inject));
console.log("Config fields =", mod.Config ? Object.keys(mod.Config.dict ?? mod.Config) : "(none)");

const ctx = makeCtx();
// 用与 profile 配置一致的 config 调用 apply
mod.apply(ctx, {
  baseDir: "",
  participants: ["codex", "workbuddy"],
  defaultMode: "both",
  pollMs: 1500,
  recentWindowMs: 3600000,
  pushMs: 5000,
  watch: true,
});

// 给异步初始化一点时间（要建索引、连采集器）
await new Promise((r) => setTimeout(r, 8000));

console.log("\n== apply() 结果 ==");
console.log("注册工具:", ctx._tools.map((t) => t.name).join(", ") || "(无)");
console.log("注册 prompt section:", ctx._sections.map((s) => s.name).join(", ") || "(无)");
console.log("注册 runtime context:", ctx._contexts.map((c) => c.name).join(", ") || "(无)");
console.log("订阅事件:", [...ctx._handlers.keys()].join(", ") || "(无)");
console.log("日志:", ctx._logs.join(" | ") || "(无)");

// 校验工具的 output schema / render 是否成对存在（缺失会在真实 Host 报错）
let bad = 0;
for (const t of ctx._tools) {
  const problems = [];
  if (!t.description) problems.push("缺 description");
  if (!t.parameters) problems.push("缺 parameters");
  if (!t.output?.schema) problems.push("缺 output.schema");
  if (typeof t.output?.render !== "function") problems.push("缺 output.render");
  if (typeof t.execute !== "function") problems.push("缺 execute");
  if (problems.length) {
    bad += 1;
    console.log(`  ✖ ${t.name}: ${problems.join(", ")}`);
  } else {
    console.log(`  ✔ ${t.name}`);
  }
}

// 真实调用工具，确认执行路径不抛
const fakeExec = {
  agent: { session: { header: { id: "smoke-session", cwd: process.cwd() } } },
};
const expectTools = ["agent_chat", "agent_watch", "agent_target", "agent_handoff", "agent_write", "sync_mode"];
let missing = expectTools.filter((n) => !ctx._tools.some((t) => t.name === n));
if (missing.length) {
  bad += 1;
  console.log(`\n✖ 缺少工具: ${missing.join(", ")}`);
} else {
  console.log(`\n✔ 六个工具齐全: ${expectTools.join(", ")}`);
}

try {
  const out = await ctx._tools.find((t) => t.name === "agent_chat").execute({ listSessions: true, sinceMinutes: 60 }, fakeExec);
  console.log("agent_chat.execute() OK →", JSON.stringify(out).slice(0, 220));
} catch (err) {
  bad += 1;
  console.log("agent_chat.execute() 抛错:", err?.message ?? err);
}

// agent_target: 列出候选并绑定
try {
  const t = ctx._tools.find((t) => t.name === "agent_target");
  const list = await t.execute({ action: "list" }, fakeExec);
  console.log(`\nagent_target(list) OK → ${list.candidates.length} 个候选`);
  for (const c of list.candidates.slice(0, 3)) {
    console.log(`   ${c.participant}/${c.sessionId} 「${(c.title ?? "").slice(0, 40)}」 sameCwd=${c.sameCwd}`);
  }
  const bind = await t.execute({ action: "bind" }, fakeExec);
  console.log("agent_target(bind) →", JSON.stringify(bind.binding).slice(0, 200));
  const cur = await t.execute({ action: "current" }, fakeExec);
  console.log("agent_target(current) →", JSON.stringify(cur.binding).slice(0, 200));
} catch (err) {
  bad += 1;
  console.log("agent_target 抛错:", err?.message ?? err);
}

// agent_handoff: 生成交接简报
try {
  const h = await ctx._tools.find((t) => t.name === "agent_handoff").execute({ sinceMinutes: 1440 }, fakeExec);
  console.log(`\nagent_handoff → ok=${h.ok}`);
  if (h.ok) {
    console.log("---- 交接简报（前 25 行）----");
    console.log(h.markdown.split("\n").slice(0, 25).join("\n"));
  } else {
    console.log("   失败原因:", h.target?.error);
  }
} catch (err) {
  bad += 1;
  console.log("agent_handoff 抛错:", err?.message ?? err);
}

await ctx._disposeAll();
console.log(bad === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${bad} 处问题)`);
process.exit(bad === 0 ? 0 : 1);
