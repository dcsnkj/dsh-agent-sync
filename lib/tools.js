// dsh-agent-sync — 面向模型的工具集。
//
// 四个工具：
//   agent_chat    跨 agent 检索对话/操作（回答“Codex 那一步到底怎么做的”）
//   agent_watch   看对方最新动静 + 有没有新事件（实时跟随）
//   agent_write   双向同步里“写”的显式通道：登记结论/决定，并做防重复检查
//   sync_mode     切换本会话的同步模式（off / read / write / both）与参与方
//
// 关键纪律：agent_write 在你能证明“别人已经做过同一件事”时，会把冲突直接摆在结果里，
// 让模型自己决定是否跳过——这是防止重复操作造成误差的核心闸门。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { PARTICIPANTS, PARTICIPANT_LABEL, SYNC_MODES, pathKey } from "./contract.js";
import { buildLedger, fileConflict, commandAlreadyRun, sameScope } from "./sessions.js";
import { buildHandoff, renderHandoff } from "./handoff.js";

const text = (t) => [{ type: "text", text: t }];
const oneLine = (s, n = 300) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const fmtTime = (ts) => new Date(ts).toLocaleString("zh-CN", { hour12: false });

/** 把整数参数夹到 [min, max]；非有限值/非数字一律退回 fallback。 */
function clampInt(v, { fallback, min, max, name }) {
  if (v == null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new TypeError(`${name} 必须是有限数字，收到 ${JSON.stringify(v)}`);
  }
  const i = Math.trunc(n);
  if (i < min || i > max) {
    throw new TypeError(`${name} 必须在 ${min} 与 ${max} 之间，收到 ${i}`);
  }
  return i;
}

/** 清理字符串数组：去空白、丢弃空串、去重。 */
function cleanStrings(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean))];
}

/**
 * 宽容布尔参数：模型经常把 true 传成字符串 "true"。
 *
 * 为什么必须在这里解决：宿主的参数校验（validateJsonSchemaValue）在
 * `execute` **之前**执行，一旦类型不符就抛 ToolArgsError，
 * 我们在 execute 内部的容错代码根本没机会跑。而模型拿到
 * `"deep" must be a boolean` 这种错误往往不知道该怎么改，会原地重试多次
 * （实测同一轮里连续 4 次同样的调用，白烧 2 分 48 秒）。
 *
 * 做法：用 oneOf 同时接受 布尔 和 "true"/"false" 字符串。
 * oneOf 要求**恰好命中一个分支**，所以 "yes"、1、null 依然被拒——
 * 宽容不等于纵容错误类型。
 * @param {string} desc 原始描述
 */
function boolParam(desc) {
  return {
    oneOf: [{ type: "boolean" }, { type: "string", enum: ["true", "false"] }],
    description: `${desc}（可传 true/false，也可传字符串 "true"/"false"）`,
  };
}

/** 把宽容布尔值归一化回真正的布尔。 */
function asBool(v, fallback = false) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim().toLowerCase() === "true";
  return fallback;
}

/**
 * 宽容整数参数：模型可能传 "60" 这类字符串数字。
 * 与 boolParam 同理，必须在校验前就接受，否则 execute 走不到。
 *
 * 注意不能用 pattern —— DSH 的 schema DSL 不支持它（会抛 JsonSchemaError），
 * 所以退而用 enum 枚举常见写法。这是精确而非宽容：enum之外的字符串仍被拒。
 */
function intParam(desc) {
  // 不能用 pattern（DSL 不支持，会抛 JsonSchemaError），也不宜用 enum 白名单：
  // 白名单必然漏掉合法值（实测 1440 这种最常用的分钟数反而被拒），
  // 而"是不是合法数字"这件事交给 execute 里的 clampInt 判定更合适。
  // oneOf 的"恰好命中一支"在这里不构成风险：整数字符串只会命中 string 分支。
  return {
    oneOf: [{ type: "integer" }, { type: "string" }],
    description: `${desc}（可传整数，也可传字符串数字；越界会被夹到合法范围）`,
  };
}

/** 解析 `participant:sessionId` 形式的 fileTarget。格式错误必须显式报错，不能静默回落。 */
function parseFileTarget(raw) {
  const s = String(raw ?? "").trim();
  const idx = s.indexOf(":");
  if (idx <= 0 || idx === s.length - 1) {
    throw new TypeError(`fileTarget 格式应为 "participant:sessionId"，收到 ${JSON.stringify(raw)}`);
  }
  const participant = s.slice(0, idx).trim();
  const sessionId = s.slice(idx + 1).trim();
  if (participant === "dsh") throw new TypeError("fileTarget 不能指向本方 dsh");
  if (!PARTICIPANTS.includes(participant)) {
    throw new TypeError(`fileTarget 的 participant 必须是 ${PARTICIPANTS.join("/")}，收到 "${participant}"`);
  }
  return { participant, sessionId };
}

/** 把一条事件渲染成一行给模型看的摘要。 */
function renderLine(ev) {
  const who = PARTICIPANT_LABEL[ev.participant] ?? ev.participant;
  const d = ev.data ?? {};
  switch (ev.kind) {
    case "file_write":
      return `${fmtTime(ev.ts)} [${who}] 改文件 ${(d.wrotePaths ?? d.paths ?? []).join(", ") || "?"}`;
    case "command":
      return `${fmtTime(ev.ts)} [${who}] 命令 ${oneLine(d.command, 200)}${d.exitCode != null ? ` → exit ${d.exitCode}` : ""}`;
    case "file_read":
      return `${fmtTime(ev.ts)} [${who}] 读 ${(d.paths ?? []).join(", ")}`;
    case "user":
      return `${fmtTime(ev.ts)} [用户→${who}] ${oneLine(ev.text, 400)}`;
    case "assistant":
      return `${fmtTime(ev.ts)} [${who}] ${oneLine(ev.text, 600)}`;
    case "plan":
      return `${fmtTime(ev.ts)} [${who}] 计划 ${oneLine(ev.text, 300)}`;
    default:
      return `${fmtTime(ev.ts)} [${who}] ${ev.kind} ${oneLine(ev.text, 300)}`;
  }
}

/** 会话摘要：从事件里折叠出每个会话一行。 */
function sessionSummaries(events) {
  const map = new Map();
  for (const ev of events) {
    const key = `${ev.participant}:${ev.sessionId}`;
    const rec =
      map.get(key) ??
      {
        participant: ev.participant,
        sessionId: ev.sessionId,
        title: ev.sessionTitle,
        cwd: ev.cwd,
        firstTs: ev.ts,
        lastTs: ev.ts,
        events: 0,
        files: new Set(),
        commands: 0,
      };
    rec.events += 1;
    rec.lastTs = Math.max(rec.lastTs, ev.ts);
    rec.firstTs = Math.min(rec.firstTs, ev.ts);
    if (ev.kind === "file_write") for (const p of ev.data?.wrotePaths ?? ev.data?.paths ?? []) rec.files.add(p);
    if (ev.kind === "command") rec.commands += 1;
    map.set(key, rec);
  }
  return [...map.values()].sort((a, b) => b.lastTs - a.lastTs);
}

/**
 * @param {object} deps
 * @param {import('./bus.js').EventBus} deps.bus
 * @param {import('./sessions.js').SessionSyncStore} deps.store
 * @param {() => object} deps.sourceStatus  watcher 诊断信息
 * @param {Map<string, object>} [deps.adapters] participant -> SourceAdapter（深读真实历史用）
 * @param {(msg: string) => void} [deps.log]
 */
export function buildTools({ bus, store, sourceStatus, adapters, log = () => {}, onModeChanged = null }) {
  const selfOf = (exec) => exec?.agent?.session?.header?.id ?? "unknown";
  const cwdOf = (exec) => exec?.agent?.session?.header?.cwd;

  /** 深读缓存：file -> { mtime, events }，避免重复解析几 MB 的会话文件。 */
  const deepCache = new Map();
  const DEEP_CACHE_MS = 30 * 1000;

  /**
   * 候选排序：同工作目录优先，其次按最近活动倒序（最新的排前面）。
   * 注意方向：降序是 (b.mtime - a.mtime)，别写反。
   */
  function rankCandidates(list) {
    return [...list].sort((a, b) => Number(b.sameCwd) - Number(a.sameCwd) || (b.mtime ?? 0) - (a.mtime ?? 0));
  }

  /**
   * 解析“这次问的是哪个外部会话”：
   *   显式参数 > 本会话的绑定 > 同工作目录里最近活跃的那个。
   * 这样用户绑定过一次之后，后续提问就不用重复指定。
   */
  async function resolveTarget(exec, explicit) {
    const cwd = cwdOf(exec);
    const settings = store.settingsFor(selfOf(exec));
    const binding = store.bindingFor(selfOf(exec));
    const adapterList = adapters ? [...adapters.values()] : [];
    /** mode=off / 未授权时，连"有哪些会话存在"都不该泄露。 */
    const denied = () => ({ error: `同步模式「${settings.mode}」不允许读取其它 agent 的会话` });

    if (explicit?.participant || explicit?.sessionId) {
      if (!settings.readParticipants.includes(explicit.participant)) {
        return { error: `参与方白名单不含 ${explicit.participant ?? "(未指定)"}` };
      }
      const a = adapters?.get(explicit.participant);
      if (!a) return { error: `没有 ${explicit.participant} 的采集器` };
      const sessions = await a.listSessions().catch(() => []);
      const hit = sessions.find((s) => s.sessionId === explicit.sessionId);
      if (!hit) return { error: `${explicit.participant} 里找不到会话 ${explicit.sessionId}` };
      return {
        binding: {
          participant: explicit.participant,
          targetSessionId: explicit.sessionId,
          sessionId: explicit.sessionId,
          title: hit.title,
        },
        session: hit,
        adapter: a,
      };
    }
    if (binding) {
      // 绑定目标已不在白名单（例如用户把 codex 移出了参与方）时不要继续用它。
      if (!settings.readParticipants.includes(binding.participant)) {
        return denied();
      }
      const a = adapters?.get(binding.participant);
      if (a) {
        const sessions = await a.listSessions().catch(() => []);
        const hit = sessions.find((s) => s.sessionId === binding.targetSessionId);
        if (hit) {
          return {
            binding: { ...binding, sessionId: binding.targetSessionId, title: hit.title ?? binding.title },
            session: hit,
            adapter: a,
          };
        }
        // 绑定还在，但会话已过期/被删：退回自动选择并说明
        log(`绑定 ${binding.participant}/${binding.targetSessionId} 已失效，退回自动选择`);
      }
    }
    if (!settings.readParticipants.length) return denied();
    // 自动：同 cwd 优先，其中取最近活跃
    let best = null;
    for (const a of adapterList) {
      if (!settings.readParticipants.includes(a.participant)) continue;
      const sessions = await a.listSessions().catch(() => []);
      for (const s of sessions) {
        const sameCwd = !!(cwd && s.cwd && sameScope(s.cwd, cwd));
        const cand = { adapter: a, session: s, sameCwd };
        if (!best) {
          best = cand;
          continue;
        }
        const better = Number(sameCwd) > Number(best.sameCwd) || (Number(sameCwd) === Number(best.sameCwd) && (s.mtime ?? 0) > (best.session.mtime ?? 0));
        if (better) best = cand;
      }
    }
    if (!best) return { error: cwd ? `在 ${cwd} 下没找到任何外部会话` : "没有可用的外部会话" };
    return {
      binding: {
        participant: best.adapter.participant,
        targetSessionId: best.session.sessionId,
        sessionId: best.session.sessionId,
        title: best.session.title,
        bind: "auto",
      },
      session: best.session,
      adapter: best.adapter,
    };
  }

  /** 深读某个会话的完整历史（真实文件，非总线尾部）。 */
  async function deepRead(adapter, session) {
    const file = session.file;
    const cached = deepCache.get(file);
    if (cached && Date.now() - cached.at < DEEP_CACHE_MS && cached.mtime === session.mtime) return cached.events;
    try {
      const r = await adapter.readSession(session, { sinceOffset: 0 });
      deepCache.set(file, { at: Date.now(), mtime: session.mtime, events: r.events ?? [] });
      return r.events ?? [];
    } catch (err) {
      log(`深读失败 ${file}: ${err?.message ?? err}`);
      return [];
    }
  }

  /**
   * 本会话可见的事件范围（遵守模式里的"参与方"）。
   *
   * 安全要点：调用方传入的 participants 只是**收窄**请求，永远不能**放宽**权限。
   * 因此先与 settings.readParticipants 求交集，并强制剔除 dsh——否则
   * agent_chat(participants=["dsh"]) 就能在 mode=off 下读到本方记录，模式开关形同虚设。
   *
   * 交集为空时的语义要明确：调用方点名了却一个都不允许，说明它想要的东西被策略
   * 拒绝了。此时直接denied，而不是悄悄回落到全量白名单（那等于无视了调用方的意图，
   * 让"我只想看 codex"变成"我看到了 workbuddy"）。
   */
  function visibleEvents(exec, extra = {}) {
    const settings = store.settingsFor(selfOf(exec));
    const allowed = settings.readParticipants.filter((p) => p !== "dsh");
    if (!allowed.length) return { settings, events: [], denied: true };
    const requested = cleanStrings(extra.participants).filter((p) => p !== "dsh");
    // 点名的全是自己 → 等价于"没点名"，沿用默认白名单
    const participants = requested.length ? requested.filter((p) => allowed.includes(p)) : allowed;
    if (!participants.length) return { settings, events: [], denied: true };
    const events = bus.query({ ...extra, participants, limit: extra.limit ?? 300, tail: extra.tail ?? true });
    const cwd = cwdOf(exec);
    return { settings, events: cwd ? events.filter((ev) => ev.participant !== "dsh" && (!ev.cwd || sameScope(ev.cwd, cwd))) : events };
  }

  // ── agent_chat ────────────────────────────────────────────────────────────
  const agentChat = defineTool({
    name: "agent_chat",
    description:
      "检索其它 AI agent（Codex / WorkBuddy）与本 agent 的同步聊天与操作记录。用户问“Codex 刚才做到哪了”“那个实验的参数是怎么改的”“它跑了什么命令”，都应该用这个工具取真实记录，再据此回答，不要凭记忆猜。可选择按参与方、时间窗、关键词、类别过滤，也能只列出会话清单。",
    parameters: {
      participants: {
        type: "array",
        items: { type: "string", enum: PARTICIPANTS },
        description: "只看这些 agent。默认按本会话的同步设置。",
      },
      sessionId: { type: "string", description: "限定某个会话/线程 id。" },
      query: { type: "string", description: "关键词（中文/英文均可），在正文、标题、结构化数据里匹配。" },
      kinds: {
        type: "array",
        items: {
          type: "string",
          enum: ["user", "assistant", "reasoning", "file_read", "file_write", "command", "tool", "plan", "turn", "meta"],
        },
        description: "只看这些类别。",
      },
      keyOnly: boolParam("只保留关键操作（指令/结论/改文件/命令/计划）。"),
      sinceMinutes: intParam("只看最近 N 分钟。默认 1440（一天）。deep=true 时可给更大值。"),
      limit: intParam("最多返回多少条，默认 120，上限 500。"),
      listSessions: boolParam("true 时只返回会话清单（标题、时间、改过的文件数），适合先摸底再细看。"),
      deep: boolParam(
        "true 时直接深读目标会话的**完整历史文件**（不只是总线尾部），用于回答细节问题。会自动带上被绑定的会话，用 fileTarget 可换别的。",
      ),
      fileTarget: {
        type: "string",
        description: "deep=true 时指定目标，格式 `participant:sessionId`，例如 `codex:01a1140c-...`。缺省用绑定或自动选择。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          denied: { type: "boolean" },
          mode: { type: "string" },
          sessions: { type: "array", items: { type: "object", additionalProperties: true } },
          lines: { type: "array", items: { type: "string" } },
          total: { type: "integer" },
          target: { type: "object", additionalProperties: true },
        },
      },
      render: (_args, v) => {
        if (v.denied) {
          return text(
            `本会话的同步模式是「${v.mode}」，不允许读取其它 agent 的记录。\n如果用户确实想同步，调用 sync_mode 改成 read 或 both。`,
          );
        }
        const tgt = v.target
          ? `目标会话：${v.target.participant}/${v.target.sessionId}「${v.target.title ?? ""}」${v.target.bind === "auto" ? "（自动选择）" : "（已绑定）"}\n`
          : "";
        const head = `${tgt}同步记录：模式=${v.mode}，命中 ${v.total} 条`;
        if (!v.total) return text(`${head}\n（这个时间窗/过滤条件下没有记录。可以放宽 sinceMinutes 或去掉 query。）`);
        const body = v.lines.length ? `\n\n${v.lines.join("\n")}` : "";
        const sess = v.sessions.length
          ? `\n\n会话清单：\n${v.sessions
              .map((s) => `- ${s.participant}/${s.sessionId} 「${s.title ?? "(无标题)"}」 最后活动 ${fmtTime(s.lastTs)}，${s.events} 条事件，改动文件 ${s.files?.length ?? 0} 个`)
              .join("\n")}`
          : "";
        return text(`${head}${sess}${body}`);
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    async execute(rawArgs, exec) {
      // 先把宽容类型（"true" / "60"）归一化，再走原本的逻辑
      const args = { ...rawArgs, deep: asBool(rawArgs.deep), keyOnly: asBool(rawArgs.keyOnly), listSessions: asBool(rawArgs.listSessions) };
      const limit = clampInt(args.limit, { fallback: 120, min: 1, max: 500, name: "limit" });
      const sinceMinutes = clampInt(args.sinceMinutes, { fallback: 1440, min: 1, max: 60 * 24 * 30, name: "sinceMinutes" });
      const settings = store.settingsFor(selfOf(exec));
      const sinceTs = Date.now() - sinceMinutes * 60000;

      // ── 深读模式：直接读目标会话的完整文件 ────────────────────────────────
      if (args.deep) {
        if (settings.readParticipants.filter((p) => p !== "dsh").length === 0) {
          return { denied: true, mode: settings.mode, sessions: [], lines: [], total: 0 };
        }
        let explicit;
        if (args.fileTarget) {
          // 格式错误必须显式失败：静默回落到绑定/自动选择会让模型拿着
          // 另一个会话的内容去回答，错误极难察觉。
          // 这里返回结构化错误而不是抛异常——工具是模型调用的，
          // 抛出去只会变成一次"本轮运行失败"，模型看不到原因。
          try {
            explicit = parseFileTarget(args.fileTarget);
          } catch (err) {
            return {
              denied: false,
              mode: settings.mode,
              sessions: [],
              lines: [`深读失败：${err?.message ?? err}`],
              total: 0,
            };
          }
        }
        const resolved = await resolveTarget(exec, explicit);
        if (resolved.error) {
          return { denied: false, mode: settings.mode, sessions: [], lines: [`深读失败：${resolved.error}`], total: 0 };
        }
        // 遵守参与方白名单
        if (!settings.readParticipants.includes(resolved.binding.participant)) {
          return {
            denied: true,
            mode: settings.mode,
            sessions: [],
            lines: [],
            total: 0,
            target: resolved.binding,
          };
        }
        let events = await deepRead(resolved.adapter, resolved.session);
        if (args.kinds?.length) {
          const set = new Set(args.kinds);
          events = events.filter((e) => set.has(e.kind));
        }
        if (args.keyOnly) {
          const set = new Set(["user", "assistant", "file_write", "command", "plan", "turn"]);
          events = events.filter((e) => set.has(e.kind));
        }
        if (args.sinceMinutes != null) events = events.filter((e) => e.ts >= sinceTs);
        if (args.query) {
          const needle = args.query.toLowerCase();
          events = events.filter((e) =>
            `${e.text}\n${e.sessionTitle ?? ""}\n${e.data ? JSON.stringify(e.data) : ""}`.toLowerCase().includes(needle),
          );
        }
        return {
          denied: false,
          mode: settings.mode,
          sessions: [],
          lines: events.slice(-limit).map(renderLine),
          total: events.length,
          target: { ...resolved.binding, file: resolved.session.file, bytes: resolved.session.bytes },
        };
      }

      const { events, denied } = visibleEvents(exec, {
        participants: args.participants,
        sessionId: args.sessionId,
        text: args.query,
        kinds: args.kinds,
        keyOnly: args.keyOnly,
        since: sinceTs,
        limit: args.listSessions ? 5000 : limit,
        tail: true,
      });
      if (denied) {
        return { denied: true, mode: settings.mode, sessions: [], lines: [], total: 0 };
      }
      const sessions = sessionSummaries(events).slice(0, 30).map((s) => ({ ...s, files: [...s.files] }));
      if (args.listSessions) {
        return { denied: false, mode: settings.mode, sessions, lines: [], total: events.length };
      }
      return {
        denied: false,
        mode: settings.mode,
        sessions,
        lines: events.slice(-limit).map(renderLine),
        total: events.length,
      };
    },
  });

  // ── agent_watch ───────────────────────────────────────────────────────────
  const agentWatch = defineTool({
    name: "agent_watch",
    description:
      "查看其它 agent 的实时状态：最近 N 分钟内它们做了什么、有没有你还没看过的新动作、各自的活跃会话与改动文件。用于“它还在跑吗”“有没有新进展”“我是不是漏看了什么”。",
    parameters: {
      sinceMinutes: intParam("回看多少分钟，默认 30。"),
      participants: { type: "array", items: { type: "string", enum: PARTICIPANTS }, description: "限定 agent。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string" },
          active: { type: "array", items: { type: "object", additionalProperties: true } },
          recent: { type: "array", items: { type: "string" } },
          unread: { type: "integer" },
          sources: { type: "object", additionalProperties: true },
        },
      },
      render: (_a, v) =>
        text(
          [
            `同步模式=${v.mode}；本次未读新动作 ${v.unread} 条（已确认到当前进度）。`,
            v.active.length
              ? `活跃会话：\n${v.active.map((s) => `- ${s.participant}/${s.sessionId} 「${s.title ?? "(无标题)"}」 最后活动 ${fmtTime(s.lastTs)}，${s.events} 条`).join("\n")}`
              : "暂无其它 agent 的活动记录。",
            v.recent.length ? `\n最近动作：\n${v.recent.join("\n")}` : "",
            `\n采集器状态：${JSON.stringify(v.sources)}`,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
    },
    isConcurrencySafe: () => true,
    timeoutMs: 20000,
    async execute(args, exec) {
      const sessionId = selfOf(exec);
      const settings = store.settingsFor(sessionId);
      const sinceMinutes = clampInt(args.sinceMinutes, { fallback: 30, min: 1, max: 60 * 24 * 7, name: "sinceMinutes" });
      const { events, denied } = visibleEvents(exec, {
        participants: args.participants,
        since: Date.now() - sinceMinutes * 60000,
        limit: 4000,
        tail: true,
      });
      if (denied) {
        return {
          mode: settings.mode,
          active: [],
          recent: [],
          unread: 0,
          sources: { state: sourceStatus().state, adapters: sourceStatus().adapters, error: sourceStatus().error, selflog: null },
        };
      }
      const sessions = sessionSummaries(events);
      const cursor = bus.readers.get(sessionId) ?? 0;
      const fresh = events.filter((ev) => ev.seq > cursor);
      const src = sourceStatus();
      // 看过即确认：把游标推进到本次实际展示的最大 seq，
      // 否则 unread 只增不减，"我是不是漏看了什么"永远得到一个虚高数字。
      const shown = events.slice(-25);
      const maxShown = shown.length ? Math.max(...shown.map((e) => e.seq)) : 0;
      if (maxShown > cursor) await bus.ack(sessionId, maxShown);
      return {
        mode: settings.mode,
        active: sessions.slice(0, 10).map((s) => ({ ...s, files: [...s.files] })),
        recent: shown.map(renderLine),
        unread: fresh.length,
        sources: {
          state: src.state,
          adapters: src.adapters,
          error: src.error,
          // 自诊断：本插件是否真的看到了本会话的事件（判断“写回为什么没生效”用）
          selflog: src.selflog
            ? {
                sessionEventsSeen: src.selflog.sessionEventsSeen,
                eventsRecorded: src.selflog.eventsRecorded,
                filteredByMode: src.selflog.filteredByMode,
                lastEventType: src.selflog.lastEventType,
                lastEventAt: src.selflog.lastEventAt ? fmtTime(src.selflog.lastEventAt) : null,
                attachedAgents: src.selflog.attachedAgents?.length ?? 0,
                errors: src.selflog.errors?.slice(-3) ?? [],
              }
            : null,
        },
      };
    },
  });

  // ── agent_target ──────────────────────────────────────────────────────────
  const agentTarget = defineTool({
    name: "agent_target",
    description:
      "把本聊天“绑定”到某个外部会话（Codex / WorkBuddy 的一条具体对话），之后 agent_chat(deep) 与 agent_handoff 都默认针对它，不用每次重复指定。action=list 列出候选（默认按同一工作目录优先），action=bind 绑定（targetSessionId 省略则自动选同目录最近活跃的），action=unbind 解除，action=current 查看当前绑定。用户说“盯着 Codex 那个对话”“同步那个会话”时用这个。",
    parameters: {
      action: { type: "string", enum: ["list", "bind", "unbind", "current"], required: true },
      targetSessionId: { type: "string", description: "要绑定的目标会话 id（bind 时用；省略=自动选同目录最近活跃）。" },
      participant: { type: "string", enum: PARTICIPANTS, description: "目标 agent（bind 时配合 targetSessionId 使用）。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string" },
          binding: { type: "object", additionalProperties: true },
          candidates: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      },
      render: (_a, v) => {
        if (v.binding?.error) return text(`操作未完成：${v.binding.error}`);
        if (v.action === "list") {
          if (!v.candidates.length) return text("没有找到候选会话（检查同步模式是否允许读取）。");
          return text(
            `候选外部会话（同工作目录优先）：\n${v.candidates
              .map((c, i) => `${i + 1}. ${c.participant}/${c.sessionId} 「${c.title ?? "(无标题)"}」 最后活动 ${fmtTime(c.mtime)}，改动文件 ${c.filesTouched?.length ?? 0} 个${c.sameCwd ? " ← 同目录" : ""}`)
              .join("\n")}\n\n用 agent_target(action="bind", participant=..., targetSessionId=...) 绑定。`,
          );
        }
        if (v.action === "unbind") return text("已解除绑定，之后将按同工作目录自动选择目标。");
        if (!v.binding) return text("当前没有绑定。");
        return text(
          `当前绑定：${v.binding.participant}/${v.binding.targetSessionId}「${v.binding.title ?? ""}」\n方式：${v.binding.bind === "explicit" ? "显式绑定" : "自动选择"}`,
        );
      },
    },
    timeoutMs: 30000,
    async execute(args, exec) {
      const sessionId = selfOf(exec);
      const settings = store.settingsFor(sessionId);
      const allowed = settings.readParticipants.filter((p) => p !== "dsh");
      const denied = {
        action: args.action,
        binding: { error: `同步模式「${settings.mode}」不允许读取其它 agent 的会话` },
        candidates: [],
      };
      // current 只读自己的绑定，不需要外部权限；其余动作都要能看到外部会话。
      if (args.action === "current") {
        return { action: "current", binding: store.bindingFor(sessionId), candidates: [] };
      }
      if (args.action === "unbind") {
        await store.unbind(sessionId);
        return { action: "unbind", candidates: [] };
      }
      if (!allowed.length) return denied;
      if (args.action === "list") {
        const cwd = cwdOf(exec);
        const out = [];
        for (const a of adapters?.values() ?? []) {
          if (!allowed.includes(a.participant)) continue;
          const sessions = await a.listSessions().catch(() => []);
          for (const s of sessions.slice(0, 30)) {
            out.push({
              participant: a.participant,
              sessionId: s.sessionId,
              title: s.title,
              mtime: s.mtime,
              filesTouched: s.filesTouched ?? [],
              sameCwd: !!(cwd && s.cwd && sameScope(s.cwd, cwd)),
            });
          }
        }
        out.sort((x, y) => Number(y.sameCwd) - Number(x.sameCwd) || (y.mtime ?? 0) - (x.mtime ?? 0));
        return { action: "list", candidates: rankCandidates(out).slice(0, 25) };
      }
      // bind：给了 participant 就必须同时给 targetSessionId，避免"绑到别处"或空绑定
      if (args.targetSessionId && !args.participant) {
        return { action: "bind", candidates: [], binding: { error: "指定 targetSessionId 时必须同时给 participant" } };
      }
      if (args.participant && !allowed.includes(args.participant)) {
        return { action: "bind", candidates: [], binding: { error: `参与方白名单不含 ${args.participant}` } };
      }
      const resolved = await resolveTarget(exec, args.targetSessionId ? { participant: args.participant, sessionId: args.targetSessionId } : undefined);
      if (resolved.error) return { action: "bind", candidates: [], binding: { error: resolved.error } };
      try {
        const b = await store.bind(sessionId, {
          participant: resolved.binding.participant,
          targetSessionId: resolved.binding.targetSessionId,
          title: resolved.binding.title,
          bind: "explicit",
        });
        return { action: "bind", binding: b, candidates: [] };
      } catch (err) {
        return { action: "bind", candidates: [], binding: { error: `绑定失败：${err?.message ?? err}` } };
      }
    },
  });

  // ── agent_handoff ─────────────────────────────────────────────────────────
  const agentHandoff = defineTool({
    name: "agent_handoff",
    description:
      "生成“接着别人往下干”的交接简报：目标（最近的人类指令）、已改动文件、跑过的命令与失败、最后一次结论、以及看起来还没做完的地方。用在用户说“Codex 太慢了，你接着把它剩下的活干完”或“它做到哪了、还剩什么”时。拿到简报后即可据此继续执行，或用 subagent 派一个分支去做而主窗口不受影响。",
    parameters: {
      targetSessionId: { type: "string", description: "目标会话 id（省略=用绑定或同目录最近活跃）。" },
      participant: { type: "string", enum: PARTICIPANTS, description: "目标 agent。" },
      sinceMinutes: intParam("只看最近 N 分钟的关键事件，默认 1440。"),
      checkDisk: boolParam("是否核对被改动文件当前是否真的存在于工作区，默认 true。"),
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          target: { type: "object", additionalProperties: true },
          brief: { type: "object", additionalProperties: true },
          markdown: { type: "string" },
        },
      },
      render: (_a, v) => text(v.ok ? v.markdown : `交接包生成失败：${v.target?.error ?? "未知原因"}`),
    },
    timeoutMs: 90000,
    async execute(rawArgs, exec) {
      // checkDisk 走宽容布尔；clampInt 本身已能处理字符串数字
      const args = { ...rawArgs, checkDisk: asBool(rawArgs.checkDisk, true) };
      const settings = store.settingsFor(selfOf(exec));
      if (settings.readParticipants.filter((p) => p !== "dsh").length === 0) {
        return { ok: false, target: { error: `同步模式「${settings.mode}」不允许读取` }, brief: {}, markdown: "" };
      }
      if (args.targetSessionId && !args.participant) {
        return { ok: false, target: { error: "指定 targetSessionId 时必须同时给 participant" }, brief: {}, markdown: "" };
      }
      const explicit =
        args.targetSessionId && args.participant ? { participant: args.participant, sessionId: args.targetSessionId } : undefined;
      const resolved = await resolveTarget(exec, explicit);
      if (resolved.error) return { ok: false, target: { error: resolved.error }, brief: {}, markdown: "" };
      if (!settings.readParticipants.includes(resolved.binding.participant)) {
        return { ok: false, target: { error: `参与方白名单不含 ${resolved.binding.participant}` }, brief: {}, markdown: "" };
      }
      const sinceMinutes = clampInt(args.sinceMinutes, { fallback: 1440, min: 1, max: 60 * 24 * 30, name: "sinceMinutes" });
      let events = await deepRead(resolved.adapter, resolved.session);
      events = events.filter((e) => e.ts >= Date.now() - sinceMinutes * 60000);
      // 现场核对：文件是否真的还在
      let filesOnDisk = null;
      if (args.checkDisk !== false) {
        const { existsSync } = await import("node:fs");
        const paths = new Set();
        for (const e of events) {
          if (e.kind !== "file_write") continue;
          for (const p of e.data?.wrotePaths ?? e.data?.paths ?? []) paths.add(p);
        }
        const base = resolved.session.cwd ?? cwdOf(exec) ?? "";
        filesOnDisk = [];
        for (const p of [...paths].slice(0, 60)) {
          const abs = /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") ? p : `${base}\\${p}`;
          try {
            if (existsSync(abs)) filesOnDisk.push(p);
          } catch {
            /* 忽略非法路径 */
          }
        }
      }
      const brief = buildHandoff(events, { binding: resolved.binding, sessionInfo: resolved.session, filesOnDisk });
      return {
        ok: true,
        target: { ...resolved.binding, file: resolved.session.file },
        brief: {
          goal: brief.goal,
          files: brief.files.length,
          commands: brief.commands,
          unresolved: brief.unresolved,
        },
        markdown: renderHandoff(brief),
      };
    },
  });

  // ── agent_write ───────────────────────────────────────────────────────────
  const agentWrite = defineTool({
    name: "agent_write",
    description:
      "把自己这一步的关键操作或结论登记到共享总线，让 Codex / WorkBuddy 也能看到，并顺手做防重复检查。两种用法：(1) 用 action=check 在动手改文件/跑命令前问“这件事别人是不是已经做过了”；(2) 用 action=note/claim 登记你的结论或即将执行的操作。结果里若出现 conflicts，说明别人最近动过同一目标——先核对再决定，不要盲目重复。",
    parameters: {
      action: { type: "string", enum: ["check", "note", "claim"], required: true, description: "check=只检查冲突；note=登记结论；claim=登记即将执行的操作（改文件/命令）。" },
      summary: { type: "string", description: "note/claim 的正文：结论、决定、或你要做的事。必填（check 可省）。" },
      paths: { type: "array", items: { type: "string" }, description: "涉及的文件路径（claim 改文件时必填）。" },
      command: { type: "string", description: "涉及的命令（claim 跑命令时填）。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          recorded: { type: "boolean" },
          mode: { type: "string" },
          conflictCount: { type: "integer" },
          conflicts: { type: "array", items: { type: "string" } },
          errors: { type: "array", items: { type: "string" } },
        },
      },
      render: (_a, v) => {
        const head = v.recorded
          ? `已登记到共享总线（模式=${v.mode}）。`
          : `未登记（模式=${v.mode}，当前不允许写出）。`;
        const errs = v.errors?.length ? `\n⚠ 参数问题：\n${v.errors.map((e) => `- ${e}`).join("\n")}\n` : "";
        if (!v.conflictCount) return text(`${errs}${head}\n未发现冲突：这条目标最近没有被其它 agent 动过。`);
        return text(
          `${errs}${head}\n⚠ 发现 ${v.conflictCount} 处可能重复/冲突，请先核对再动手：\n${v.conflicts.map((c) => `- ${c}`).join("\n")}`,
        );
      },
    },
    timeoutMs: 20000,
    async execute(args, exec) {
      const sessionId = selfOf(exec);
      const settings = store.settingsFor(sessionId);
      const cwd = cwdOf(exec);
      const now = Date.now();
      // 参数校验：claim 必须指明"要改什么或跑什么"，否则会记成一条没有目标的
      // plan 事件，污染对方的台账却起不到避让作用。
      const errors = [];
      const paths = cleanStrings(args.paths);
      const command = typeof args.command === "string" && args.command.trim() ? args.command.trim() : "";
      const summary = typeof args.summary === "string" ? args.summary.trim() : "";
      if (args.action === "check") {
        if (!paths.length && !command) errors.push("check 需要至少给一个 paths 或 command，否则无从检查");
      } else if (!summary) {
        errors.push(`${args.action} 必须给 summary（要登记的正文）`);
      }
      if (args.action === "claim" && summary && !paths.length && !command) {
        errors.push("claim 必须给 paths（要改的文件）或 command（要跑的命令）之一");
      }
      if (args.paths != null && !Array.isArray(args.paths)) errors.push("paths 必须是字符串数组");
      if (errors.length) {
        return { recorded: false, mode: settings.mode, conflictCount: 0, conflicts: [], errors };
      }

      const recent = bus.query({ since: now - 6 * 3600 * 1000, limit: 20000, tail: true });
      const scoped = cwd ? recent.filter((ev) => !ev.cwd || sameScope(ev.cwd, cwd)) : recent;
      const ledger = buildLedger(scoped, { excludeParticipant: "dsh", now });

      const conflicts = [];
      for (const p of paths) {
        const c = fileConflict(ledger.files, p, "dsh", { now });
        if (c) {
          conflicts.push(
            `${c.path} 最近被 ${c.writers.map((w) => PARTICIPANT_LABEL[w] ?? w).join("/")} 改过（${Math.round(c.ageMs / 60000)} 分钟前）`,
          );
        }
      }
      if (command) {
        const dup = commandAlreadyRun(ledger.commands, command, "dsh", { now });
        if (dup) {
          conflicts.push(
            `命令「${oneLine(dup.command, 160)}」已由 ${PARTICIPANT_LABEL[dup.participant] ?? dup.participant} 在 ${Math.round((now - dup.ts) / 60000)} 分钟前跑过${dup.exitCode != null ? `（exit ${dup.exitCode}）` : ""}`,
          );
        }
      }

      let recorded = false;
      if (args.action !== "check" && settings.writeParticipants.length) {
        const kind = args.action === "claim" ? (paths.length ? "file_write" : "command") : "assistant";
        const data =
          args.action === "claim"
            ? { ...(paths.length ? { paths, wrotePaths: paths } : {}), ...(command ? { command } : {}) }
            : undefined;
        // 显式登记的文本直接进总线（走 bus，不走 selflog，避免和自动记录重复）
        const { makeEvent } = await import("./contract.js");
        bus.append(
          makeEvent({
            participant: "dsh",
            sessionId,
            cwd,
            kind,
            role: "assistant",
            // 打上显式标记，读方一眼能看出这是“主动登记”而不是自动抓取
            text: `[${args.action}] ${summary}`.trim(),
            data,
            ts: now,
            // sourceId 必须稳定：用 now 会让同一 claim 重试产生两条记录
            sourceId: `explicit:${args.action}:${sessionId}:${now}`,
          }),
        );
        // 必须 await：addNote 内部会原子写 state.json，不等它就返回会让
        // 调用方以为登记完成，实际可能还在异步排队。
        await store.addNote({ participant: "dsh", sessionId, cwd, text: summary, kind: args.action });
        recorded = true;
      } else if (args.action !== "check" && !settings.writeParticipants.length) {
        errors.push(`同步模式「${settings.mode}」不允许写出，登记未生效`);
      }
      await bus.flush();
      return { recorded, mode: settings.mode, conflictCount: conflicts.length, conflicts, errors };
    },
  });

  // ── sync_mode ─────────────────────────────────────────────────────────────
  const syncMode = defineTool({
    name: "sync_mode",
    description:
      "切换【本聊天】的跨 agent 同步模式。可选 off（只留自己的记录，不读也不写）、read（只看 Codex/WorkBuddy 在做什么）、write（只把自己的操作推给它们）、both（双向，默认）。也可单独指定参与方——传空数组表示「不跟任何人同步」。用户在对话里说“这个聊天不要同步了”“只看 Codex”“把 WorkBuddy 也加进来”，就用这个工具改。",
    parameters: {
      mode: { type: "string", enum: SYNC_MODES, required: true, description: "目标模式。" },
      participants: {
        type: "array",
        items: { type: "string", enum: PARTICIPANTS },
        description: "参与同步的 agent（不含本 agent）。默认全部：codex + workbuddy；传 [] 表示不跟任何人同步。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionId: { type: "string" },
          mode: { type: "string" },
          readParticipants: { type: "array", items: { type: "string" } },
          writeParticipants: { type: "array", items: { type: "string" } },
        },
      },
      render: (_a, v) =>
        text(
          `本会话同步模式已设为「${v.mode}」。\n读取自：${v.readParticipants.join(", ") || "（无）"}\n写出到：${v.writeParticipants.join(", ") || "（无）"}`,
        ),
    },
    timeoutMs: 10000,
    async execute(args, exec) {
      const sessionId = selfOf(exec);
      // 显式传了就按给的来（含空数组 = 不跟任何人同步）；没传则**恢复默认名单**。
      // 注意不能沿用上一次的名单：用户先用 participants:[] 关掉同步后，
      // 再敲一次 sync_mode(mode) 应当回到默认，否则会永远关着且无从察觉。
      const peers = args.participants ? cleanStrings(args.participants).filter((p) => p !== "dsh") : undefined;
      const patch = {};
      patch.readParticipants = peers ?? [...store.enabledParticipants].filter((p) => p !== "dsh");
      patch.writeParticipants = [...patch.readParticipants];
      const s = await store.setMode(sessionId, args.mode, patch);
      // 可见范围刚变，立刻作废上下文缓存：否则 cacheKey 里的 head 没动，
      // 下一轮仍会拿到旧模式的文本，表现为"改了模式不生效"。
      onModeChanged?.(sessionId);
      await bus.flush();
      return {
        sessionId,
        mode: s.mode,
        readParticipants: s.readParticipants,
        writeParticipants: s.writeParticipants,
      };
    },
  });

  return [agentChat, agentWatch, agentTarget, agentHandoff, agentWrite, syncMode];
}
