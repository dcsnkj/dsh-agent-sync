// dsh-agent-sync — DSH 自身操作的自记录（双向同步里“写”的那一半）。
//
// 订阅方式（关键）：
//   agent/created      —— 为每个新 agent 的**作用域上下文**注册 session/event 监听器。
//                         走 agent.ctx 是因为 session/event 是 scoped 事件，
//                         逐个 agent 订阅最可靠，且 agent 销毁时自动解绑。
//   全局 session/event —— 同时保留一个全局监听器作为兜底（scoped 派发会把
//                         untagged 监听器也送上），重复的由总线按 id 去重。
//   agent/pre-step     —— 兜底心跳：证明插件确实收到了本会话的流量（自诊断用）。
//
// 只记录“关键操作”粒度：改动的文件、执行的命令、结论、人给的指令、轮次边界。

import { makeEvent, classifyToolName, extractCallData, extractResultData } from "./contract.js";

/** 把 ContentBlock[] 拍平成纯文本，供模型阅读。 */
export function blocksToText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (typeof b.text === "string") out.push(b.text);
    else if (typeof b.content === "string") out.push(b.content);
    else if (Array.isArray(b.content)) out.push(blocksToText(b.content));
  }
  return out.join("\n").trim();
}

/** 从 tool/result 的 message 里取出工具名与文本。 */
function toolResultInfo(message) {
  const name = message?.name ?? message?.content?.[0]?.name ?? undefined;
  const text = blocksToText(message?.content);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { name, text, parsed };
}

/** 该 kind 是否属于“关键操作”，只有关键操作才写入总线（省 token、保信噪比）。 */
const KEY_KINDS = new Set(["user", "assistant", "file_write", "command", "plan", "turn", "meta"]);
/** 但为了让对方知道“哪些文件已经被读过、不用重复读”，file_read 也记，只是不进注入摘要。 */
const REMEMBER_KINDS = new Set([...KEY_KINDS, "file_read", "tool"]);

/**
 * @param {object} deps
 * @param {import('./bus.js').EventBus} deps.bus
 * @param {import('./sessions.js').SessionSyncStore} deps.store
 * @param {(msg: string) => void} [deps.log]
 */
export function createSelfLog({ bus, store, log = () => {} }) {
  /** 待处理的结果：`sessionId:callId` -> {name, kind, data} */
  const pendingCalls = new Map();
  /** 会话元信息缓存：sessionId -> {cwd, title} */
  const sessionMeta = new Map();
  /** DSH 侧心跳节流：sessionId -> 上次落盘 ts（不依赖任何过滤条件，既作诊断也作真实心跳） */
  const lastDshHeartbeat = new Map();
  const DSH_HEARTBEAT_MS = 5 * 60 * 1000;
  /** 自诊断：本插件到底看到了什么。工具 agent_diag 会读它。 */
  const diag = {
    sessionEventsSeen: 0,
    eventsRecorded: 0,
    filteredByMode: 0,
    filteredByKind: 0,
    lastEventAt: null,
    lastEventType: null,
    lastRecorded: null,
    errors: [],
    perSession: {},
    attachedAgents: [],
    globalListenerActive: false,
  };
  /** 心跳节流：sessionId -> 上次心跳 ts */
  const lastHeartbeat = new Map();
  const HEARTBEAT_MS = 5 * 60 * 1000;

  function note(sessionId, patch) {
    const cur = diag.perSession[sessionId] ?? { seen: 0, recorded: 0, lastType: null, cwd: undefined };
    diag.perSession[sessionId] = { ...cur, ...patch, seen: (patch.seen ?? cur.seen), recorded: (patch.recorded ?? cur.recorded) };
  }

  function record(session, kind, fields) {
    const sessionId = session?.header?.id ?? "unknown";
    const settings = store.settingsFor(sessionId);
    if (settings.writeParticipants.length === 0) {
      diag.filteredByMode += 1;
      return 0;
    }
    if (!REMEMBER_KINDS.has(kind)) {
      diag.filteredByKind += 1;
      return 0;
    }
    const cwd = session?.header?.cwd;
    const meta = sessionMeta.get(sessionId) ?? {};
    const ev = makeEvent({
      participant: "dsh",
      sessionId,
      sessionTitle: fields.title ?? meta.title,
      cwd: fields.cwd ?? cwd ?? meta.cwd,
      kind,
      role: fields.role,
      text: fields.text,
      data: fields.data,
      ts: fields.ts,
      // sourceId 必须稳定：它是去重键的基础。
      // 两条订阅路径（全局 + 逐 agent）会各投递一次同一事件，
      // 没有稳定 sourceId 就会退化成按 ts 区分 → 必然重复。
      sourceId: fields.sourceId ?? `seq:${fields.seq ?? "na"}:${kind}`,
    });
    const n = bus.append(ev);
    if (n > 0) {
      diag.eventsRecorded += n;
      diag.lastRecorded = { kind, text: String(fields.text ?? "").slice(0, 160), ts: Date.now() };
      note(sessionId, { recorded: (diag.perSession[sessionId]?.recorded ?? 0) + n });
    }
    return n;
  }

  function renderCallText(kind, name, data) {
    if (kind === "file_write") {
      const paths = data?.wrotePaths ?? data?.paths ?? [];
      return paths.length ? `修改文件: ${paths.join(", ")}` : `${name} (写操作)`;
    }
    return `${name}: ${JSON.stringify(data ?? {}).slice(0, 300)}`;
  }

  function onToolCall(payload, session, event) {
    const sessionId = session?.header?.id ?? "unknown";
    const rawArgs = payload.arguments;
    let args;
    try {
      args = JSON.parse(rawArgs);
    } catch {
      args = rawArgs;
    }
    const name = payload.name;
    const callId = payload.callId ?? event?.callId ?? "";
    const kind = classifyToolName(name);
    const data = extractCallData(name, args);
    pendingCalls.set(`${sessionId}:${callId}`, { name, kind, data, ts: Date.now() });
    if (kind === "file_write" || kind === "plan") {
      record(session, kind, {
        text: renderCallText(kind, name, data),
        data,
        sourceId: `${callId || event?.seq || ""}:call`,
        role: "tool",
      });
    }
  }

  function onToolResult(payload, session, event) {
    const sessionId = session?.header?.id ?? "unknown";
    const message = payload.message ?? payload;
    const callId = message?.callId ?? payload.callId ?? event?.callId ?? "";
    const key = `${sessionId}:${callId}`;
    const pend = pendingCalls.get(key);
    pendingCalls.delete(key);
    const info = toolResultInfo(message);
    const name = pend?.name ?? info.name ?? "tool";
    const kind = pend?.kind ?? classifyToolName(name);
    const resData = extractResultData(info.parsed ?? info.text);
    const data = { ...(pend?.data ?? {}), ...resData };
    if (kind === "command") {
      record(session, "command", {
        text: `$ ${data.command ?? name}${data.exitCode != null ? `  → exit ${data.exitCode}` : ""}`,
        data,
        sourceId: `${callId || event?.seq || "cmd"}:result`,
        role: "tool",
      });
    } else if (kind === "file_read") {
      const paths = data.paths ?? [];
      if (paths.length) {
        record(session, "file_read", { text: `read ${paths.join(", ")}`, data: { paths }, sourceId: `${callId || event?.seq || ""}:read`, role: "tool" });
      }
    } else if (data.isError || (data.exitCode != null && data.exitCode !== 0)) {
      record(session, "tool", {
        text: `${name} failed${data.exitCode != null ? ` (exit ${data.exitCode})` : ""}: ${String(info.text ?? "").slice(0, 200)}`,
        data,
        sourceId: `${callId || event?.seq || ""}:fail`,
        role: "tool",
      });
    }
  }

  /** 处理一条 session 事件；全局与 scoped 两条路径共用，靠总线去重。 */
  function handle(session, event, via) {
    diag.sessionEventsSeen += 1;
    diag.lastEventAt = Date.now();
    diag.lastEventType = `${event?.type}${via ? `@${via}` : ""}`;
    const sessionId = session?.header?.id ?? "unknown";
    note(sessionId, { seen: (diag.perSession[sessionId]?.seen ?? 0) + 1, lastType: event?.type, cwd: session?.header?.cwd });
    // session/event 派发的是完整日志条目 {type, seq, time, data}，
    // 业务负载全在 .data 里（turn/end 的 data = {turn, reason}）。
    // 兜底：若某天宿主改成扁平派发，data 缺失时退回读 event 本身。
    const payload = event?.data ?? event ?? {};
    try {
      switch (event?.type) {
        case "tool/call":
          onToolCall(payload, session, event);
          break;
        case "tool/result":
          onToolResult(payload, session, event);
          break;
        case "user/message": {
          const text = blocksToText(payload.content);
          // 只记真实的人类输入；插件注入的 runtime context 不进总线（否则会回环）
          if (payload.source?.kind === "user" && text) {
            record(session, "user", { text, role: "user", sourceId: `${payload.id ?? event.seq ?? ""}:user`, seq: event.seq });
          }
          break;
        }
        case "assistant/message": {
          const text = blocksToText(payload.message?.content);
          if (text) {
            record(session, "assistant", {
              text: text.slice(0, 2000),
              role: "assistant",
              sourceId: `${payload.message?.id ?? event.seq ?? ""}:msg`,
              seq: event.seq,
            });
          }
          break;
        }
        case "turn/start":
          record(session, "turn", {
            text: `turn ${payload.turn} 开始`,
            role: "system",
            // 用日志 seq 做去重键：scoped + 全局两条订阅路径会各发一次同一事件
            sourceId: `turn:${event.seq ?? ""}:start`,
            seq: event.seq,
          });
          break;
        case "turn/end": {
          const reason = payload.reason?.kind ?? payload.reason ?? "unknown";
          record(session, "turn", {
            text: `turn ${payload.turn} 结束 (${reason})`,
            role: "system",
            sourceId: `turn:${event.seq ?? ""}:end`,
            seq: event.seq,
          });
          break;
        }
        default:
          break;
      }
      // 心跳：证明“这个会话的流量确实被看到了”，否则无法从外部判断订阅是否生效
      const last = lastHeartbeat.get(sessionId) ?? 0;
      if (Date.now() - last > HEARTBEAT_MS) {
        lastHeartbeat.set(sessionId, Date.now());
        record(session, "meta", {
          text: `DSH 会话已接入同步（本会话累计可见 ${diag.perSession[sessionId]?.seen ?? 0} 条事件）`,
          data: { via: via ?? "global", sessionId },
          sourceId: `heartbeat:${Math.floor(Date.now() / HEARTBEAT_MS)}`,
          role: "system",
        });
      }
    } catch (err) {
      const msg = `${event?.type}: ${err?.message ?? err}`;
      diag.errors.push(msg);
      if (diag.errors.length > 20) diag.errors.shift();
      log(`self-log 处理失败 ${msg}`);
    }
  }

  return {
    diag,
    /**
     * DSH 侧心跳：不经过 mode/kind 过滤，直接把“本会话正在被同步”写进总线。
     * 两个作用：
     *   1. 真实功能——让 Codex/WorkBuddy 知道 DSH 这边有活动；
     *   2. 诊断——如果连心跳都不出现，说明 session/event 订阅没生效，
     *      而不是“没有操作可记”。
     */
    heartbeat(session) {
      const sessionId = session?.header?.id;
      if (!sessionId) return 0;
      const last = lastDshHeartbeat.get(sessionId) ?? 0;
      if (Date.now() - last < DSH_HEARTBEAT_MS) return 0;
      lastDshHeartbeat.set(sessionId, Date.now());
      const meta = sessionMeta.get(sessionId) ?? {};
      const n = bus.append(
        makeEvent({
          participant: "dsh",
          sessionId,
          sessionTitle: session?.header?.title ?? meta.title,
          cwd: session?.header?.cwd ?? meta.cwd,
          kind: "meta",
          role: "system",
          text: `DSH 会话在线（同步中）；本进程已看到该会话 ${diag.sessionEventsSeen} 条事件`,
          data: { heartbeat: true, attachedAgents: diag.attachedAgents.length },
          sourceId: `dsh-heartbeat:${Math.floor(Date.now() / DSH_HEARTBEAT_MS)}`,
        }),
      );
      if (n > 0) diag.eventsRecorded += n;
      return n;
    },
    /** 注册到 Host 事件总线。 */
    attach(ctx) {
      // 1) 逐个 agent 的作用域订阅（主路径）
      ctx.on("agent/created", (payload) => {
        const { agent } = payload;
        const sessionId = agent?.session?.header?.id;
        sessionMeta.set(sessionId, { cwd: agent?.session?.header?.cwd, title: agent?.session?.header?.title });
        if (!diag.attachedAgents.includes(sessionId)) diag.attachedAgents.push(sessionId);
        try {
          // agent.ctx 是该 agent 的作用域上下文：注册在这里的监听器随 agent 销毁而解绑
          agent.ctx.on("session/event", (session, event) => handle(session, event, "agent"));
        } catch (err) {
          diag.errors.push(`agent/created 订阅失败: ${err?.message ?? err}`);
        }
      });

      // 2) 全局兜底订阅（scoped 派发对 untagged 监听器同样可见）
      ctx.on("session/event", (session, event) => {
        diag.globalListenerActive = true;
        handle(session, event, "global");
      });

      ctx.on("agent/session-start", (payload) => {
        const { agent } = payload;
        sessionMeta.set(agent.session.header.id, {
          cwd: agent.session.header.cwd,
          title: agent.session.header.title,
        });
      });
    },
  };
}
