// dsh-agent-sync — 把外部 agent（Codex / WorkBuddy）的动作注入本会话上下文。
//
// 两条注入通道，互补：
//  1) systemPrompt.context()：每步重新求值，模型永远能看到「对方最近干了什么」，
//     不产生历史消息，最省 token，也不怕回环。
//  2) agent/pre-step：有真正的新事件时，用 agent.inject() 把一条 notice 放进本步，
//     让模型在历史里也留下一笔「我看到 Codex 改了 X」。
// 只有 settings.mode 允许 read 时才注入。

import { PARTICIPANT_LABEL, pathKey } from "./contract.js";

/** 工作目录的归一化键（与 selflog/contract 用同一套规则，避免大小写/分隔符差异）。 */
function pathKeyOf(cwd) {
  return cwd ? pathKey(cwd) : "";
}

/** 单条事件的渲染行。 */
function renderEvent(ev) {
  const who = PARTICIPANT_LABEL[ev.participant] ?? ev.participant;
  const t = new Date(ev.ts).toTimeString().slice(0, 8);
  const data = ev.data ?? {};
  switch (ev.kind) {
    case "file_write": {
      const paths = data.wrotePaths ?? data.paths ?? [];
      return `[${t}] ${who} 改了 ${paths.length ? paths.join(", ") : "(未知文件)"}`;
    }
    case "command": {
      const code = data.exitCode != null ? ` → exit ${data.exitCode}` : "";
      return `[${t}] ${who} 执行: ${oneLine(data.command ?? ev.text)}${code}`;
    }
    case "file_read":
      return `[${t}] ${who} 读过 ${(data.paths ?? []).join(", ")}`;
    case "plan":
      return `[${t}] ${who} 计划: ${oneLine(ev.text)}`;
    case "turn":
      return `[${t}] ${who} ${oneLine(ev.text)}`;
    case "user":
      return `[${t}] 用户对 ${who} 说: ${oneLine(ev.text)}`;
    case "assistant":
      return `[${t}] ${who} 结论: ${oneLine(ev.text)}`;
    case "meta":
      return `[${t}] ${who} ${oneLine(ev.text)}`;
    default:
      return `[${t}] ${who} ${ev.kind}: ${oneLine(ev.text)}`;
  }
}

function oneLine(s, max = 240) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * @param {object} deps
 * @param {import('./bus.js').EventBus} deps.bus
 * @param {import('./sessions.js').SessionSyncStore} deps.store
 * @param {(msg: string) => void} [deps.log]
 * @param {number} [deps.recentWindowMs] 只把这段时间内的动作当作“正在发生”
 */
export function createInjector({ bus, store, log = () => {}, recentWindowMs = 60 * 60 * 1000, selfLog }) {
  /** 每个会话上次注入到的 seq */
  const injectedUpto = new Map();
  /** 每个会话缓存的上下文文本 + 其对应的 head seq */
  const contextCache = new Map();

  /** 取本会话应当看到的外部事件。 */
  function visible(agent) {
    const sessionId = agent.session.header.id;
    const settings = store.settingsFor(sessionId);
    // 无论配置怎么写，都不把本方(dsh)当成"外部"来读：注入通道的意义是看到
    // 别人的动作，读自己既没有价值，也会让 mode=off 的语义出现漏洞。
    const peers = settings.readParticipants.filter((p) => p !== "dsh");
    if (!peers.length) return { settings, events: [] };
    const cwd = agent.session.header.cwd;
    const now = Date.now();
    const events = bus
      .query({
        participants: peers,
        since: now - recentWindowMs,
        limit: 400,
        tail: true,
      })
      // 只看同一个实验目录里的事，避免别的项目噪声
      .filter((ev) => ev.participant !== "dsh" && (!ev.cwd || !cwd || sameScopeLoose(ev.cwd, cwd)));
    return { settings, events };
  }

  function sameScopeLoose(a, b) {
    if (!a || !b) return true; // 信息缺失时不过度过滤
    const ka = pathKey(a);
    const kb = pathKey(b);
    return ka === kb || ka.startsWith(`${kb}/`) || kb.startsWith(`${ka}/`);
  }

  /** 生成给模型的运行时上下文文本（每步重算，只在有新事件时才变）。 */
  function contextText(agent, budgetChars = 2600) {
    const { events } = visible(agent);
    if (!events.length) return undefined;
    const lines = [];
    let used = 0;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const line = renderEvent(events[i]);
      if (used + line.length > budgetChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (!lines.length) return undefined;
    lines.reverse();
    const participants = [...new Set(events.map((e) => PARTICIPANT_LABEL[e.participant] ?? e.participant))];
    return [
      `<agent-sync 来源="${participants.join("/")}">`,
      "以下是其他 AI agent 在你这个工作目录里**刚刚**做的事（真实操作，非你的记忆）。",
      "遵守两条纪律：",
      "1. 动手前先看这里——如果某个文件已经被改过、某条命令已经跑过，不要重复做，避免引入误差。",
      "2. 需要更细的脉络（它为什么这么改、命令输出是什么）用 agent_chat 工具检索，不要凭空猜测。",
      "",
      ...lines,
      "</agent-sync>",
    ].join("\n");
  }

  /**
   * 缓存键：光看 bus.head() 是不够的。
   * 上下文内容同时取决于「同步模式 / 可见参与方 / 工作目录」——用户用 sync_mode
   * 切换模式时 bus.head() 不会变，若只拿它做键，缓存会继续返回旧模式的文本，
   * 表现为“改了模式却不生效，直到对方恰好产生新事件才刷新”。
   * 所以把这三项一并纳入键，任何一项变化都会立即重算。
   */
  function cacheKey(sessionId, settings, cwd, head) {
    return [head, settings.mode, settings.readParticipants.join(","), pathKeyOf(cwd)].join("|");
  }

  /** 有新事件时，往本步注入一条 notice（让历史里留下“我注意到了”）。 */
  function maybeInjectNotice(agent) {
    const sessionId = agent.session.header.id;
    const { settings, events } = visible(agent);
    if (!settings.readParticipants.length || !events.length) return;
    const lastSeq = injectedUpto.get(sessionId) ?? 0;
    const fresh = events.filter((ev) => ev.seq > lastSeq);
    if (!fresh.length) return;
    const head = fresh[fresh.length - 1].seq;
    const keyKinds = new Set(["user", "assistant", "file_write", "command", "plan"]);
    const key = fresh.filter((ev) => keyKinds.has(ev.kind));
    if (!key.length) {
      injectedUpto.set(sessionId, head);
      return;
    }
    const lines = key.slice(-12).map(renderEvent);
    const text = [
      `<agent-sync 来源="${[...new Set(key.map((e) => PARTICIPANT_LABEL[e.participant]))].join("/")}" 类型="实时同步">`,
      ...lines,
      "（这是对方的真实操作记录。若与本任务相关，先核对是否已做过，再决定是否重复。）",
      "</agent-sync>",
    ].join("\n");
    try {
      agent.inject({
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "dsh-agent-sync", form: "notice", summary: `来自 ${[...new Set(key.map((e) => e.participant))].join("/")} 的 ${key.length} 条新动作` },
      });
      injectedUpto.set(sessionId, head);
      bus.emit("injected", { sessionId, count: key.length });
    } catch (err) {
      log(`注入 notice 失败: ${err?.message ?? err}`);
    }
  }

  return {
    /**
     * 供 systemPrompt.context() 的 text provider 调用。
     * 组装上下文里带的是 `agent`（见 dsh-user-approval 的同款用法），不是 scope。
     */
    contextProvider(assembleContext) {
      const agent = assembleContext?.agent;
      // 必须回空串而不是 undefined：dsh-system-prompt 的 PromptContext.text
      // 契约是 string，interpolate() 会无条件调 text.indexOf("{{")，
      // 传undefined 会抛 "Cannot read properties of undefined (reading 'indexOf')"
      // 并让整个 turn 失败。空串会被 renderContextSections 的 length>0 过滤掉。
      if (!agent?.session?.header) return "";
      const sessionId = agent.session.header.id;
      const head = bus.head();
      const key = cacheKey(sessionId, store.settingsFor(sessionId), agent.session.header.cwd, head);
      const cached = contextCache.get(sessionId);
      if (cached && cached.key === key) return cached.text;
      let text;
      try {
        text = contextText(agent) ?? "";
      } catch (err) {
        log(`生成 agent-sync 上下文失败: ${err?.message ?? err}`);
        text = "";
      }
      contextCache.set(sessionId, { key, head, text });
      return text;
    },

    /**
     * 主动作废某会话的上下文缓存。
     * sync_mode / bind 改变可见范围后调用，保证下一步立刻按新设置渲染，
     * 而不必等对方产生新事件（bus.head() 不变时缓存本会一直命中旧值）。
     */
    invalidate(sessionId) {
      if (sessionId) contextCache.delete(sessionId);
      else contextCache.clear();
    },

    /** 挂到 agent/pre-step 上，做实时注入。 */
    attach(ctx) {
      ctx.on("agent/pre-step", async (payload) => {
        try {
          // DSH 侧心跳：这一步一定会跑，所以它同时也是“订阅是否生效”的探测器
          selfLog?.heartbeat?.(payload.agent?.session);
          maybeInjectNotice(payload.agent);
        } catch (err) {
          log(`pre-step 注入失败: ${err?.message ?? err}`);
        }
        return { kind: "enter", messages: payload.messages };
      });
    },

    /** 诊断用。 */
    stats() {
      return { injected: [...injectedUpto.entries()].map(([k, v]) => ({ sessionId: k, upToSeq: v })) };
    },
  };
}
