// dsh-agent-sync — 交接包（handoff brief）与深读辅助。
//
// 用户的核心诉求是「Codex 做得太慢时，我在 DSH 这里接着把它剩下的活干完」。
// 要接得住，不能只给一堆原始事件，必须回答三个问题：
//   1. 目标是什么        —— 最近的人类指令
//   2. 已经做到哪了      —— 改过的文件、跑过的命令（带退出码）、失败的尝试
//   3. 还剩什么没做      —— 最后一次结论 / 待办 / 中断点
// 这里把这些从规范化事件 + 原始会话记录里折叠成一份可直接交给子代理的简报。

import { PARTICIPANT_LABEL } from "./contract.js";

const oneLine = (s, n = 400) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const fmt = (ts) => new Date(ts).toLocaleString("zh-CN", { hour12: false });

/** 纯续跑/确认类指令：信息量极低，不适合当“目标”。 */
const CONTINUATION_ONLY = /^(继续|继续吧|接着|go on|continue|ok|okay|好的?|行|嗯|可以|谢谢|thanks?|收到|yes|y)[\s。.!！~]*$/i;
/** 自动化心跳/系统注入：里面往往包着真正的目标描述。 */
const AUTOMATION_WRAP = /<heartbeat>|<automation_id>|<instructions>/i;

/** 去掉心跳包装与多余空白，抽出真正的人类句子。 */
function unwrapInstruction(text) {
  let t = String(text ?? "");
  const m = /<instructions>([\s\S]*?)(<\/instructions>|$)/i.exec(t);
  if (m) t = m[1];
  t = t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return t;
}

/**
 * 选“目标”：优先信息量最大的那条人类指令。
 * 实测坑：直接取最后一条会拿到心跳包装或一句「继续」，目标就丢了；
 * 而真正的任务描述常常长在心跳的 <instructions> 里。
 */
function pickGoal(userMsgs) {
  let best = null;
  for (const m of userMsgs.slice(-40)) {
    const raw = String(m.text ?? "");
    if (!raw.trim()) continue;
    const instr = unwrapInstruction(raw);
    if (!instr) continue;
    const isContinuation = CONTINUATION_ONLY.test(instr.trim());
    const isHeartbeat = AUTOMATION_WRAP.test(raw);
    // 评分：信息量为主，纯续跑/心跳包装降权
    let score = instr.length;
    if (isContinuation) score -= 5000;
    if (isHeartbeat) score -= Math.min(score, 200);
    if (!best || score > best.score) best = { score, text: instr, ts: m.ts, raw };
  }
  if (!best) return null;
  // 若最优仍是纯续跑语句，说明整段历史确实没有更具体的目标
  return { text: best.text, ts: best.ts, isContinuation: CONTINUATION_ONLY.test(best.text.trim()) };
}

/** 把一串事件折叠成交接简报的各段。 */
export function buildHandoff(events, { binding, sessionInfo, filesOnDisk } = {}) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const participants = [...new Set(sorted.map((e) => e.participant))];

  const userMsgs = sorted.filter((e) => e.kind === "user");
  const assistantMsgs = sorted.filter((e) => e.kind === "assistant");
  const fileWrites = sorted.filter((e) => e.kind === "file_write");
  const commands = sorted.filter((e) => e.kind === "command");
  const plans = sorted.filter((e) => e.kind === "plan");

  // 改动的文件：合并所有事件里的路径，保留最近一次时间
  const fileMap = new Map();
  for (const e of fileWrites) {
    for (const p of e.data?.wrotePaths ?? e.data?.paths ?? []) {
      const prev = fileMap.get(p);
      if (!prev || prev.ts < e.ts) fileMap.set(p, { path: p, ts: e.ts, participant: e.participant });
    }
  }

  // 命令：标注失败
  const failed = commands.filter((c) => c.data?.exitCode != null && c.data.exitCode !== 0);
  const succeeded = commands.filter((c) => c.data?.exitCode === 0);

  const lastUser = userMsgs[userMsgs.length - 1];
  const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
  const lastPlan = plans[plans.length - 1];
  const goal = pickGoal(userMsgs);

  return {
    title: sessionInfo?.title ?? binding?.title ?? "(未知会话)",
    participant: binding?.participant ?? participants[0] ?? "unknown",
    sessionId: binding?.targetSessionId ?? binding?.sessionId ?? sessionInfo?.sessionId,
    cwd: sessionInfo?.cwd ?? sorted.find((e) => e.cwd)?.cwd,
    span: sorted.length ? { from: sorted[0].ts, to: sorted[sorted.length - 1].ts, count: sorted.length } : null,
    goal: goal?.text ?? null,
    goalAt: goal?.ts ?? null,
    goalIsContinuation: goal?.isContinuation ?? false,
    lastUser: lastUser ? oneLine(lastUser.text, 300) : null,
    lastConclusion: lastAssistant ? oneLine(lastAssistant.text, 1200) : null,
    conclusionAt: lastAssistant?.ts ?? null,
    lastPlan: lastPlan ? oneLine(lastPlan.text, 600) : null,
    files: [...fileMap.values()].sort((a, b) => b.ts - a.ts),
    filesOnDisk: filesOnDisk ?? null,
    commands: { total: commands.length, failed: failed.length, succeeded: succeeded.length, recent: commands.slice(-12) },
    failures: failed.slice(-8),
    recentTimeline: sorted.slice(-24),
    unresolved: detectUnresolved(sorted),
  };
}

/** 找出“看起来没做完”的信号：失败命令未重跑成功、最后一次是 turn aborted、待办未完成、仍在进行中。 */
function detectUnresolved(events) {
  const out = [];
  const last = events[events.length - 1];
  if (last?.kind === "turn" && /aborted|中断/.test(last.text ?? "")) {
    out.push(`最后一次轮次是中断结束的（${oneLine(last.text, 120)}），任务可能停在半途`);
  }
  // 仍在进行中：最后一个 turn 事件是「开始」而不是「结束」
  const lastTurn = [...events].reverse().find((e) => e.kind === "turn");
  if (lastTurn && /开始|started/i.test(lastTurn.text ?? "")) {
    out.push(`对方的轮次仍在进行中（${fmt(lastTurn.ts)} 开始，尚未看到结束），接手前先确认它是否还在写文件`);
  }
  // 最近一次动作离现在多久：太久没动，可能卡住或已停
  if (last) {
    const idleMin = Math.round((Date.now() - last.ts) / 60000);
    if (idleMin >= 30 && idleMin < 24 * 60) out.push(`最近一次动作在 ${idleMin} 分钟前，可能已停滞，值得核对现场`);
  }
  // 失败的命令：如果之后没有再跑同一条并成功，就算未解决
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const failed = events.filter((e) => e.kind === "command" && e.data?.exitCode != null && e.data.exitCode !== 0);
  for (const f of failed.slice(-6)) {
    const cmd = norm(f.data?.command);
    if (!cmd) continue;
    const laterOk = events.some(
      (e) => e.kind === "command" && e.ts > f.ts && norm(e.data?.command) === cmd && e.data?.exitCode === 0,
    );
    if (!laterOk) out.push(`命令失败后未见成功重跑: ${oneLine(cmd, 180)}（exit ${f.data.exitCode}）`);
  }
  // 待办类事件里出现未完成标记
  for (const p of events.filter((e) => e.kind === "plan").slice(-4)) {
    const t = p.text ?? "";
    if (/pending|in_progress|未完成|待办|TODO/i.test(t)) out.push(`待办未清: ${oneLine(t, 300)}`);
  }
  return [...new Set(out)];
}

/** 把交接包渲染成一段可直接交给子代理/自己读的 markdown。 */
export function renderHandoff(h) {
  const L = [];
  L.push(`# 交接简报：${PARTICIPANT_LABEL[h.participant] ?? h.participant} 的会话`);
  if (h.sessionId) L.push(`- 会话: \`${h.sessionId}\``);
  if (h.cwd) L.push(`- 工作目录: \`${h.cwd}\``);
  if (h.span) L.push(`- 时间跨度: ${fmt(h.span.from)} → ${fmt(h.span.to)}（${h.span.count} 条关键事件）`);
  L.push("");
  L.push("## 1. 目标（信息量最大的人类指令）");
  L.push(h.goal ? `${oneLine(h.goal, 900)}${h.goalAt ? `\n\n_(${fmt(h.goalAt)})_` : ""}` : "（没抓到人类指令）");
  if (h.goalIsContinuation) {
    L.push("");
    L.push("> 注意：这段历史里最具体的一条也只是「继续」类指令，真正的目标可能需要回看更早的记录或用 agent_chat 检索。");
  }
  if (h.lastUser && h.lastUser !== h.goal) {
    L.push("");
    L.push(`（最后一条用户输入是：${oneLine(h.lastUser, 200)}）`);
  }
  L.push("");
  L.push("## 2. 已做到哪");
  if (h.files.length) {
    L.push(`改动过的文件（${h.files.length} 个）：`);
    for (const f of h.files.slice(0, 25)) L.push(`- \`${f.path}\`  ${fmt(f.ts)}`);
  } else {
    L.push("（没有记录到文件改动）");
  }
  L.push("");
  L.push(`命令：共 ${h.commands.total} 条，成功 ${h.commands.succeeded}，失败 ${h.commands.failed}`);
  for (const c of h.commands.recent) {
    const code = c.data?.exitCode != null ? ` → exit ${c.data.exitCode}` : "";
    L.push(`- ${fmt(c.ts)} \`${oneLine(c.data?.command, 200)}\`${code}`);
  }
  if (h.lastConclusion) {
    L.push("");
    L.push(`## 3. 最后一次结论`);
    L.push(h.lastConclusion);
  }
  if (h.lastPlan) {
    L.push("");
    L.push("## 4. 最后一次计划/待办");
    L.push(h.lastPlan);
  }
  L.push("");
  L.push("## 5. 看起来还没做完的");
  if (h.unresolved.length) {
    for (const u of h.unresolved) L.push(`- ${u}`);
  } else {
    L.push("（没有明显的未完成信号；仍建议核对最后一轮的实际产物）");
  }
  if (h.filesOnDisk?.length) {
    L.push("");
    L.push("## 6. 现场核对（这些文件当前确实存在于工作区）");
    for (const p of h.filesOnDisk.slice(0, 25)) L.push(`- \`${p}\``);
  }
  L.push("");
  L.push("## 7. 最近时间线");
  for (const e of h.recentTimeline) {
    const who = PARTICIPANT_LABEL[e.participant] ?? e.participant;
    L.push(`- ${fmt(e.ts)} [${who}] ${e.kind}: ${oneLine(e.text, 220)}`);
  }
  return L.join("\n");
}
