// dsh-agent-sync — Codex 会话来源适配器（SourceAdapter 实现）
//
// 源：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl（每行一个 JSON 对象）
// 实测存在的记录（2026-10 的 390 个会话文件统计）：
//   session_meta              会话元信息（session_id / cwd / cli_version / base_instructions …）
//   response_item             payload.type = message | function_call | function_call_output |
//                             custom_tool_call | custom_tool_call_output | reasoning |
//                             agent_message | web_search_call | tool_search_call | tool_search_output
//   event_msg                 payload.type = task_started | task_complete | turn_aborted |
//                             item_completed | token_count | thread_settings_applied | thread_goal_updated
//   token_usage_record        payload.usage 里是 token 数字
//   turn_context / world_state / compacted / inter_agent_communication_metadata
//
// 设计约束（见 lib/parsers/contract.js 与 lib/contract.js）：
//   1. 只产出 makeEvent() 信封；
//   2. 增量：sourceOffset = 该行在文件中的起始字节偏移，重复解析同一偏移不产生新事件（由调用方
//      传 sinceOffset，或由总线按 id 去重）；
//   3. 绝不读/写令牌：base_instructions、encrypted_content、auth*.json 一律不进 text/data；
//   4. 单个损坏文件、半行 JSON、非 JSON 垃圾一律静默跳过，execute 不抛。
//
// 噪声策略（实测）：
//   - response_item/message 中 role=developer（<app-context>，极长）与 role=system 直接丢弃；
//   - event_msg/item_completed 与 response_item/message 内容重复，整类丢弃，避免双份事件；
//   - world_state（最大的一条，含 filesystem 全量清单）与 turn_context 只用于更新 cwd，不产出事件；
//   - reasoning 只留 summary/content 里的可见文字，encrypted_content 永不外泄；没有可见文字就整条丢弃。
//
// zstd 压缩会话（借鉴 codex-trace / codex-history-viewer 的做法）：
//   Codex 上游有个后台压缩 worker，会把冷下来的 rollout-*.jsonl 换成
//   同名的 rollout-*.jsonl.zst 并删掉原文件。若只按 ".jsonl" 匹配文件，
//   届时会话会从列表里凭空消失、正在跟随的文件会静默停更——而且不报错。
//   所以这里做三件事：① 发现时同时认 .jsonl 与 .jsonl.zst；
//   ② 读取前按 zstd 帧头自动分流；③ 路径失效时回退到 .zst 兄弟文件。

import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { classifyToolName, extractCallData, extractResultData, makeEvent } from "../contract.js";

/** @type {'codex'} */
export const PARTICIPANT = "codex";

/** ~/.codex/sessions（可用 CODEX_HOME 覆盖，与 Codex 官方约定一致）。 */
export function defaultSessionsDir() {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return join(home, "sessions");
}

const HEAD_BYTES = 96 * 1024; // 摘要扫描只读文件头，避免为索引把 694MB 全量读进内存
const MAX_TEXT = 4000; // 与总线 maxEventChars 对齐
const MAX_REASONING = 1200; // 思考只留节选
const MAX_DESC = 200; // 工具调用一行描述
const MAX_SCAN_DETAIL = 40; // 摘要里最多收集多少个文件/命令
// 结尾必须容忍 .zst：上游压缩 worker 会生成 rollout-<ts>-<uuid>.jsonl.zst，
// 若只认 ".jsonl$"，压缩会话就匹配不到 UUID，只能退化用文件名当 id，
// 导致同一个会话在明文/压缩两种形态下被当成两个不同会话。
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;
const NL = 0x0a;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 截断到 n 个字符（超出加省略号）。 */
function cut(s, n) {
  const t = typeof s === "string" ? s : s == null ? "" : String(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 只保留有值的字段，避免把 undefined 写进 data。 */
function pick(src, keys) {
  const out = {};
  if (!src || typeof src !== "object") return out;
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/** 只保留数字字段（用于 token 统计：只要数字，不要正文）。 */
function numbersOnly(src) {
  const out = {};
  if (!src || typeof src !== "object") return out;
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** 记录时间戳：顶层 ISO / epoch，退化到 payload 内的 started_at(_ms)。 */
function tsOf(rec, fallback) {
  const t = rec?.timestamp;
  if (typeof t === "string") {
    const n = Date.parse(t);
    if (Number.isFinite(n)) return n;
  }
  if (typeof t === "number" && Number.isFinite(t)) return t < 1e12 ? Math.round(t * 1000) : t;
  const p = rec?.payload;
  if (p && typeof p === "object") {
    for (const k of ["started_at_ms", "completed_at_ms"]) {
      if (Number.isFinite(p[k])) return p[k];
    }
    for (const k of ["started_at", "completed_at"]) {
      if (Number.isFinite(p[k])) return Math.round(p[k] * 1000);
    }
  }
  return fallback;
}

/** 把 message/output 的 content 数组拼成纯文本（忽略 image_blob_ref 之类非文本部件）。 */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const it of content) {
    if (typeof it === "string") {
      if (it) parts.push(it);
      continue;
    }
    if (it && typeof it.text === "string" && it.text) parts.push(it.text);
  }
  return parts.join("\n");
}

/** 解析一行；区分「空行 / 非对象或坏 JSON / 正常对象」。 */
function parseRecordBuffer(raw) {
  let s = raw.toString("utf8");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.trim();
  if (!s) return { blank: true };
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    return { invalid: true };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { invalid: true };
  return { value: obj };
}

/** 文件名里的会话 UUID（rollout-<时间>-<uuid>.jsonl[.zst]）。 */
function sessionIdFromFile(file) {
  const b = basename(String(file || ""));
  const m = UUID_RE.exec(b);
  //回退也要剥掉 .zst，否则会把压缩后缀算进 id 里
  return m ? m[1] : b.replace(/\.jsonl(?:\.zst)?$/i, "").slice(0, 80) || "unknown";
}

/** 去掉成对的上下文块（<environment_context>…</environment_context>、<user_info>…</user_info> 等）。 */
function stripContextBlocks(s) {
  let t = String(s || "");
  let prev;
  do {
    prev = t;
    t = t.replace(/<([a-zA-Z][\w:-]*)[^>]*>[\s\S]*?<\/\1>/g, " ");
  } while (t !== prev);
  return t.replace(/<[^>]*>/g, " ");
}

/** Codex 自动注入的用户上下文块（不是人说的话）。 */
const AUTO_CONTEXT_RE = /^\s*<(environment_context|user_info|system-reminder|app-context|apps_instructions|skills_instructions)\b/i;

/** 把第一句人话当标题（去掉上下文块与裸标签）。 */
function cleanTitle(s) {
  const t = stripContextBlocks(s).replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > 80 ? t.slice(0, 80) : t;
}

/** 从 exec 脚本里抽出真正要跑的命令（tools.exec_command({"cmd": ...})）。 */
function extractExecCommand(script) {
  if (typeof script !== "string" || !script) return undefined;
  for (const key of ["cmd", "command"]) {
    const m = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(script);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        /* 转义不合法就放弃，不影响主流程 */
      }
    }
  }
  return undefined;
}

/** 工具调用一行描述：优先命令，其次文件，再次原始参数。 */
function describeCall(name, data) {
  if (data?.command) return `${name}: ${cut(data.command, MAX_DESC)}`;
  if (data?.paths?.length) return `${name}: ${cut(data.paths.join(", "), MAX_DESC)}`;
  if (data?.raw) return `${name}: ${cut(data.raw, MAX_DESC)}`;
  return String(name || "tool");
}

/**
 * Codex 实测名字 → kind 的修正表（classifyToolName 的通用正则会误判）：
 *   write_stdin  1398 次：给正在运行的程序写 stdin，不含文件路径，不是改文件；
 *   exec / js    脚本沙箱，脚本里通常就在跑 exec_command，算命令；
 *   apply_patch  通用规则已判定为 file_write，无需在这里重复。
 */
const CODEX_KIND_OVERRIDE = {
  write_stdin: "command",
  exec: "command",
  js: "command",
};

function codexKind(name) {
  return CODEX_KIND_OVERRIDE[String(name || "").toLowerCase()] ?? classifyToolName(name);
}

/**
 * 把结果记录（kind=tool，带 callId + exitCode）回填到发起记录（kind=command）。
 *
 * 背景：Codex 一次 shell 调用在 JSONL 里是两条独立记录——发起与结果。
 * 我们分别映射成 kind=command 和 kind=tool，总线里没有任何字段能把它们串起来，
 * 于是 agent_handoff / buildLedger 看到的是"命令 148 条，退出码全空"，
 * 既统计不出成功数，也发现不了失败命令。
 *
 * 做法：以 callId 建索引，扫一遍把 exitCode/isError 写到对应 command 事件上。
 * 幂等且O(n)；输出侧事件若先于发起侧出现也没关系——我们扫两遍（先建表，再回填）。
 * 注意：只回填 exitCode/isError，不改 kind、不删事件——tool 侧那条仍有价值
 * （它承载失败时的错误文本）。
 */
function pairCommandResults(events) {
  /** callId -> 持有 exitCode 的结果事件 */
  const results = new Map();
  /** callId -> 待回填的发起事件 */
  const calls = new Map();
  for (const ev of events) {
    const cid = ev?.data?.callId;
    if (!cid) continue;
    if (ev.kind === "command" || ev.kind === "file_write") {
      calls.set(cid, ev);
    } else if (ev.data.exitCode != null || ev.data.isError) {
      results.set(cid, ev);
    }
  }
  if (!results.size || !calls.size) return events;
  for (const [cid, res] of results) {
    const call = calls.get(cid);
    if (!call) continue;
    // 原地回填（事件对象由我们刚创建，可安全修改）
    call.data.exitCode = res.data.exitCode;
    if (res.data.isError) call.data.isError = true;
    // 把结果侧的摘要挂上去，便于简报直接展示失败原因
    if (!call.data.resultSummary && res.text) call.data.resultSummary = cut(res.text, 300);
    // 标出这是配对来的，便于诊断"为什么有的有退出码有的没有"
    call.data.paired = true;
  }
  return events;
}

// ---------------------------------------------------------------------------
// 增量读文件（字节偏移精确、半行不消费）
// ---------------------------------------------------------------------------

async function nextLineStart(fh, from, size) {
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let pos = from;
  while (pos < size) {
    const r = await fh.read(chunk, 0, Math.min(chunk.length, size - pos), pos);
    if (!r.bytesRead) return size;
    const idx = chunk.subarray(0, r.bytesRead).indexOf(NL);
    if (idx !== -1) return pos + idx + 1;
    pos += r.bytesRead;
  }
  return size;
}

/**
 * 读取整个会话文件的内容，**统一返回明文 Buffer**。
 * 明文文件直接读原样；.zst 则多帧解压后返回等价明文。
 * 供 probeHead / countRecords 这类"要通读整个文件"的探测逻辑使用。
 */
async function readPlainBuffer(file) {
  if (!(await isZstdFile(file))) {
    const fh = await open(file, "r");
    try {
      const st = await fh.stat();
      const buf = Buffer.allocUnsafe(st.size);
      let got = 0;
      while (got < st.size) {
        const r = await fh.read(buf, got, st.size - got, got);
        if (!r.bytesRead) break;
        got += r.bytesRead;
      }
      return buf.subarray(0, got);
    } finally {
      await fh.close();
    }
  }
  const fh = await open(file, "r");
  try {
    const st = await fh.stat();
    const raw = Buffer.allocUnsafe(st.size);
    let got = 0;
    while (got < st.size) {
      const r = await fh.read(raw, got, st.size - got, got);
      if (!r.bytesRead) break;
      got += r.bytesRead;
    }
    return Buffer.from(decodeZstdFrames(raw.subarray(0, got)).text, "utf8");
  } finally {
    await fh.close();
  }
}

/**
 * 读取 [sinceOffset, EOF) 的字节窗口。
 * sinceOffset 落在半行中间时（例如 watcher 取文件尾部增量）自动对齐到下一行行首；
 * 文件被截断/替换（sinceOffset > size）时从头再读。
 */
async function readWindow(file, sinceOffset) {
  // 压缩会话：zstd 的字节偏移与明文偏移无法对应，所以不做增量续读，
  // 每次从头多帧解压，重复事件由 EventBus 按 eventKey 去重兜底。
  if (await isZstdFile(file)) {
    const fh = await open(file, "r");
    try {
      const st = await fh.stat();
      const size = st.size;
      const raw = Buffer.allocUnsafe(size);
      let got = 0;
      while (got < size) {
        const r = await fh.read(raw, got, size - got, got);
        if (!r.bytesRead) break;
        got += r.bytesRead;
      }
      const { text, bytes } = decodeZstdFrames(raw.subarray(0, got));
      return {
        buf: Buffer.from(text, "utf8"),
        base: 0,
        size: st.size,
        mtime: st.mtimeMs,
        compressed: true,
        compressedBytes: bytes,
      };
    } finally {
      await fh.close();
    }
  }
  const fh = await open(file, "r");
  try {
    const st = await fh.stat();
    const size = st.size;
    let start = Number.isFinite(sinceOffset) ? Math.floor(sinceOffset) : 0;
    if (!(start >= 0) || start > size) start = 0;
    if (start > 0 && start < size) {
      const probe = Buffer.allocUnsafe(1);
      await fh.read(probe, 0, 1, start - 1);
      if (probe[0] !== NL) start = await nextLineStart(fh, start, size);
    }
    const len = size - start;
    const buf = Buffer.allocUnsafe(Math.max(0, len));
    let got = 0;
    while (got < len) {
      const r = await fh.read(buf, got, len - got, start + got);
      if (!r.bytesRead) break;
      got += r.bytesRead;
    }
    return { buf: buf.subarray(0, got), base: start, size, mtime: st.mtimeMs };
  } finally {
    await fh.close();
  }
}

/**
 * 按行扫描窗口：完整行必须能解析成对象；空行与非 JSON 垃圾静默跳过；
 * 末尾没有换行的残行只有在能解析成对象时才消费，否则 offset 停在它的起始位置等下次。
 */
function scanRecords(win) {
  const records = [];
  let truncated = 0;
  let offset = win.base;
  const buf = win.buf;
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(NL, i);
    const complete = nl !== -1;
    const end = complete ? nl : buf.length;
    const parsed = parseRecordBuffer(buf.subarray(i, end));
    const start = win.base + i;
    const nextOffset = win.base + (complete ? end + 1 : end);
    if (parsed.blank) {
      if (!complete) break; // 末尾空白残行：留着
      offset = nextOffset;
      i = end + 1;
      continue;
    }
    if (parsed.value) {
      records.push({ obj: parsed.value, start });
      offset = nextOffset;
      i = end + 1;
      continue;
    }
    truncated += 1;
    if (!complete) break; // 末尾半行 JSON：不消费，等文件长齐
    offset = nextOffset;
    i = end + 1;
  }
  return { records, offset, size: win.size, mtime: win.mtime, truncated };
}

// ---------------------------------------------------------------------------
// 记录 → envelope
// ---------------------------------------------------------------------------

/**
 * 把一条 Codex 记录映射成事件（或 null = 丢弃）。
 * ctx 是随文件推进的可变上下文（sessionId / cwd / title）。
 */
function mapRecord(rec, ctx) {
  const type = rec?.type;
  const p = rec?.payload;
  const off = ctx.offset;
  const srcId = (id) => (id != null && id !== "" ? String(id) : `off:${off}`);
  const ts = tsOf(rec, ctx.ts);

  if (type === "session_meta") {
    if (!p) return null;
    if (p.session_id) ctx.sessionId = String(p.session_id);
    else if (p.id) ctx.sessionId = String(p.id);
    if (p.cwd) ctx.cwd = p.cwd;
    const data = pick(p, ["cwd", "originator", "cli_version", "source", "thread_source", "model_provider"]);
    if (p.git && typeof p.git === "object") {
      const git = pick(p.git, ["branch", "commit_hash", "repository_url", "origin_url"]);
      if (Object.keys(git).length) data.git = git;
    }
    // 注意：p.base_instructions 是几万字的系统提示，绝不进 data/text。
    return {
      kind: "meta",
      role: "system",
      text: `Codex session started${p.cwd ? ` @ ${p.cwd}` : ""}`,
      data,
      ts,
      sourceId: srcId(`session_meta:${p.session_id ?? p.id ?? "unknown"}`),
    };
  }

  if (type === "turn_context") {
    if (p?.cwd) ctx.cwd = p.cwd;
    return null;
  }
  if (type === "world_state" || type === "inter_agent_communication_metadata") return null;

  if (type === "compacted") {
    const msg = typeof p?.message === "string" ? p.message : "";
    return {
      kind: "meta",
      role: "system",
      text: `context compacted: ${cut(msg, 300)}`,
      data: { compactedChars: msg.length },
      ts,
      sourceId: srcId(p?.id ?? `compacted:${off}`),
    };
  }

  if (type === "token_usage_record") {
    const usage = numbersOnly(p?.usage);
    const turnUsage = numbersOnly(p?.turn_token_usage);
    if (p?.session_id) ctx.sessionId = String(p.session_id);
    const text =
      `tokens in=${usage.input_tokens ?? "-"} out=${usage.output_tokens ?? "-"} ` +
      `reasoning=${usage.reasoning_output_tokens ?? 0} total=${usage.total_tokens ?? "-"}`;
    return {
      kind: "meta",
      role: "system",
      text, // 只有 token 数字，没有任何会话正文
      data: { usage, turnUsage },
      ts,
      sourceId: srcId(p?.response_id ?? p?.id ?? `usage:${off}`),
    };
  }

  if (type === "response_item" && p) {
    const pt = p.type;

    if (pt === "message") {
      const role = String(p.role || "");
      // developer = <app-context> / base instructions，system = 系统提示，都是噪声。
      if (role !== "user" && role !== "assistant") return null;
      const text = contentText(p.content).trim();
      if (!text) return null;
      // 纯上下文块的 user 消息（实测每个会话第一条就是 <environment_context>…）不是人的指令，丢弃。
      if (role === "user" && AUTO_CONTEXT_RE.test(text) && !cleanTitle(text)) return null;
      return {
        kind: role,
        role,
        text: cut(text, MAX_TEXT),
        data: { role, chars: text.length },
        ts,
        sourceId: srcId(p.id),
      };
    }

    if (pt === "function_call") {
      const name = String(p.name || "tool");
      const data = { name, ...(extractCallData(name, p.arguments) ?? {}) };
      if (p.namespace) data.namespace = p.namespace;
      if (p.call_id) data.callId = p.call_id;
      return {
        kind: codexKind(name),
        role: "tool",
        text: describeCall(name, data),
        data,
        ts,
        sourceId: srcId(p.call_id ?? p.id),
      };
    }

    if (pt === "custom_tool_call") {
      const name = String(p.name || "tool");
      const input = typeof p.input === "string" ? p.input : "";
      // 用 {input} 包一层，让 extractCallData 走 apply_patch 的 "*** Update File:" 抽取。
      const data = { name, ...(extractCallData(name, { input }) ?? {}) };
      if (p.call_id) data.callId = p.call_id;
      const cmd = extractExecCommand(input);
      if (cmd) data.command = cmd;
      else if (input) data.script = cut(input, 400);
      return {
        kind: codexKind(name), // apply_patch→file_write；exec/js→command
        role: "tool",
        text: describeCall(name, data),
        data,
        ts,
        sourceId: srcId(p.call_id ?? p.id),
      };
    }

    if (pt === "function_call_output" || pt === "custom_tool_call_output") {
      const raw = contentText(p.output) || (typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? ""));
      const res = extractResultData(raw);
      const text = res.summary ? cut(res.summary, 400) : "";
      return {
        kind: "tool",
        role: "tool",
        text,
        data: pick({ callId: p.call_id, exitCode: res.exitCode, isError: res.isError }, ["callId", "exitCode", "isError"]),
        ts,
        sourceId: srcId(p.call_id ? `${p.call_id}:out` : p.id),
      };
    }

    if (pt === "reasoning") {
      const parts = [];
      for (const arr of [p.summary, p.content]) {
        if (!Array.isArray(arr)) continue;
        for (const it of arr) if (it && typeof it.text === "string" && it.text) parts.push(it.text);
      }
      const text = parts.join("\n").trim();
      if (!text) return null; // 只有 encrypted_content 的思考（实测常见）直接丢弃
      return {
        kind: "reasoning",
        role: "assistant",
        text: cut(text, MAX_REASONING),
        data: { chars: text.length },
        ts,
        sourceId: srcId(p.id),
      };
    }

    if (pt === "agent_message") {
      const text = contentText(p.content).trim();
      if (!text) return null;
      return {
        kind: "assistant",
        role: "assistant",
        text: cut(text, MAX_TEXT),
        data: pick({ author: p.author, recipient: p.recipient }, ["author", "recipient"]),
        ts,
        sourceId: srcId(p.id),
      };
    }

    if (pt === "web_search_call") {
      const queries = Array.isArray(p.action?.queries) ? p.action.queries : [];
      const text = queries.length ? `web_search: ${cut(queries.join(" | "), MAX_DESC)}` : "web_search";
      return { kind: "tool", role: "tool", text, data: { queries }, ts, sourceId: srcId(p.id) };
    }

    if (pt === "tool_search_call") {
      const q = p.arguments?.query;
      return {
        kind: "tool",
        role: "tool",
        text: q ? `tool_search: ${cut(String(q), MAX_DESC)}` : "tool_search",
        data: pick({ query: q }, ["query"]),
        ts,
        sourceId: srcId(p.call_id ?? p.id),
      };
    }

    if (pt === "tool_search_output") {
      const res = extractResultData(typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? ""));
      return {
        kind: "tool",
        role: "tool",
        text: cut(res.summary ?? "", 400),
        ts,
        sourceId: srcId(p.call_id ? `${p.call_id}:out` : p.id),
      };
    }

    return null;
  }

  if (type === "event_msg" && p) {
    const et = p.type;
    if (et === "task_started") {
      return {
        kind: "turn",
        role: "system",
        text: "turn started",
        data: pick({ turnId: p.turn_id, modelContextWindow: p.model_context_window }, ["turnId", "modelContextWindow"]),
        ts,
        sourceId: srcId(`turn_start:${p.turn_id ?? off}`),
      };
    }
    if (et === "task_complete") {
      const last = typeof p.last_agent_message === "string" ? p.last_agent_message : "";
      const data = pick({ turnId: p.turn_id, durationMs: p.duration_ms }, ["turnId", "durationMs"]);
      if (last) {
        data.lastMessageChars = last.length;
        data.preview = cut(last.trim(), 200); // 只留 200 字预览，正文由 assistant 事件承载
      }
      return {
        kind: "turn",
        role: "system",
        text: "turn complete",
        data,
        ts,
        sourceId: srcId(`turn_end:${p.turn_id ?? off}`),
      };
    }
    if (et === "turn_aborted") {
      return {
        kind: "turn",
        role: "system",
        text: `turn aborted${p.reason ? `: ${p.reason}` : ""}`,
        data: pick({ turnId: p.turn_id, reason: p.reason, durationMs: p.duration_ms }, ["turnId", "reason", "durationMs"]),
        ts,
        sourceId: srcId(`turn_abort:${p.turn_id ?? off}`),
      };
    }
    return null; // item_completed / token_count / … 与上面的记录重复
  }

  return null;
}

// ---------------------------------------------------------------------------
// zstd 支持（对照 codex-trace 的 compression.rs，Node 版）
// ---------------------------------------------------------------------------

/** zstd 帧魔数，小端 0xFD2FB528。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 解压一个 .zst 会话文件，**必须支持多帧**。
 *
 * 实测坑：Node 内置的 zlib.zstdDecompressSync 只解出第一帧就停
 * （用两帧拼接的输入验证过：只得到第一帧的内容）。而 Codex 的 .zst 是
 * 追加式多帧日志，直接用它会丢掉绝大部分历史。
 *
 * 这里自己走 zstd 帧结构（见 zstd 格式规范）：
 *   魔数(4B) | 帧头(1-14B) | 数据块序列 | [4B 校验]
 *   数据块头(3B)：bit0=是否最后一块，bit2-1=类型(0=裸,1=RLE,2=压缩)，bit3-23=大小
 * 逐帧推进，因此每帧独立失败也不影响后续帧；行为与 Python zstandard 的
 * read_across_frames=True 一致。
 *
 * @param {Buffer} raw 压缩内容
 * @returns {{text: string, frames: number, bytes: number}}
 */
function decodeZstdFrames(raw) {
  let frames = 0;
  let bytes = 0;
  const parts = [];
  let pos = 0;
  while (pos + 4 <= raw.length) {
    if (raw.readUInt32LE(pos) !== 0xfd2fb528) break; // 不是 zstd，或已到尾部
    const start = pos;
    let p = pos + 4;
    const fhd = raw[p++];
    const fcsFlag = fhd >> 6;
    const singleSegment = (fhd >> 5) & 1;
    const contentChecksum = (fhd >> 2) & 1;
    const dictIdFlag = fhd & 3;
    if (!singleSegment) p += 1; // window descriptor
    p += [0, 1, 2, 4][dictIdFlag]; // dictionary id
    // Frame Content Size：字段宽度随 FCS_Field_Size 而定；缺省时为单段1B。
    const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : 1 << fcsFlag;
    p += fcsSize === 2 ? 2 : fcsSize;
    if (p > raw.length) break;
    // 数据块序列
    let last = false;
    while (!last && p + 3 <= raw.length) {
      const bh = raw[p] | (raw[p + 1] << 8) | (raw[p + 2] << 16);
      p += 3;
      last = (bh & 1) === 1;
      const type = (bh >> 1) & 3;
      const size = bh >>> 3;
      if (type === 1) p += 1; // RLE：1 字节
      else if (type === 3) break; // 保留块（reserved）：无法继续，放弃本帧
      else p += size; // type 0=裸 / 2=压缩
      if (p > raw.length) {
        p = raw.length;
        break;
      }
    }
    if (contentChecksum) p += 4;
    const frameEnd = Math.min(p, raw.length);
    try {
      parts.push(zstdDecompressSync(raw.subarray(start, frameEnd)));
    } catch {
      // 单帧损坏：跳过，继续尝试下一帧
    }
    frames += 1;
    bytes += frameEnd - start;
    pos = frameEnd;
  }
  return { text: Buffer.concat(parts).toString("utf8"), frames, bytes };
}

/** 判断某文件是否是 zstd 压缩的（读前 4 字节比魔数）。 */
async function isZstdFile(file) {
  try {
    const fh = await open(file, "r");
    try {
      const buf = Buffer.alloc(4);
      const { bytesRead } = await fh.read(buf, 0, 4, 0);
      return bytesRead === 4 && buf.equals(ZSTD_MAGIC);
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/**
 * 解析会话文件的真实路径：上游压缩 worker 可能把 rollout-*.jsonl 换成
 * 同名 .jsonl.zst 并删掉原文件。持有旧路径的 watcher 会发现文件消失而
 * 静默停更，所以这里在路径失效时回退到 .zst 兄弟文件。
 * （同 codex-trace 的 resolve_rollout_path）
 * @param {string} path
 * @returns {Promise<string|null>} 实际存在的路径；都不存在则 null
 */
export async function resolveRolloutPath(path) {
  try {
    await stat(path);
    return path;
  } catch {
    /* 继续尝试 .zst 兄弟 */
  }
  const lower = path.toLowerCase();
  if (lower.endsWith(".zst")) {
    const plain = path.slice(0, -4);
    try {
      await stat(plain);
      return plain;
    } catch {
      return null;
    }
  }
  const compressed = `${path}.zst`;
  try {
    await stat(compressed);
    return compressed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 会话发现与摘要
// ---------------------------------------------------------------------------

/** 会话文件的两种形态：明文与 zstd 压缩。 */
function isSessionFileName(name) {
  const n = name.toLowerCase();
  return n.endsWith(".jsonl") || n.endsWith(".jsonl.zst");
}

async function listJsonlFiles(dir) {
  const out = [];
  const walk = async (d) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && isSessionFileName(e.name)) out.push(p);
    }
  };
  await walk(dir);
  // 同名 .jsonl 与 .jsonl.zst 同时存在时只保留明文那份，避免重复计数
  const seen = new Set();
  const uniq = [];
  for (const p of out.sort()) {
    const key = p.toLowerCase().endsWith(".zst") ? p.slice(0, -4) : p;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(p);
  }
  return uniq;
}

async function readHead(file, want) {
  const fh = await open(file, "r");
  try {
    const st = await fh.stat();
    const len = Math.min(want, st.size);
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const r = await fh.read(buf, got, len - got, got);
      if (!r.bytesRead) break;
      got += r.bytesRead;
    }
    return buf.subarray(0, got);
  } catch {
    return Buffer.alloc(0);
  } finally {
    await fh.close();
  }
}

// 行数缓存：文件只增不减时只数新增部分，watcher 每轮索引不会退化成全量重读。
const lineCountCache = new Map();
const summaryCache = new Map();

async function countRecords(file, size) {
  const cached = lineCountCache.get(file);
  if (cached && cached.size === size) return cached.count;
  // 压缩会话：解压后按明文行数统计（压缩态的行数没有意义）。
  // 增量缓存对压缩文件不适用——压缩字节数与明文行数不同源，故每次重算。
  if (await isZstdFile(file)) {
    let count = 0;
    try {
      const buf = await readPlainBuffer(file);
      let pos = 0;
      while (pos < buf.length) {
        const idx = buf.indexOf(NL, pos);
        if (idx === -1) {
          if (pos < buf.length) count += 1; // 末尾无换行也算一条
          break;
        }
        count += 1;
        pos = idx + 1;
      }
    } catch {
      /* 读不动就按 0 */
    }
    lineCountCache.set(file, { size, count });
    return count;
  }
  let from = 0;
  let count = 0;
  if (cached && cached.size < size) {
    from = cached.size;
    count = cached.count;
  }
  const fh = await open(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(256 * 1024);
    let pos = from;
    while (pos < size) {
      const r = await fh.read(chunk, 0, Math.min(chunk.length, size - pos), pos);
      if (!r.bytesRead) break;
      const view = chunk.subarray(0, r.bytesRead);
      let idx = view.indexOf(NL);
      while (idx !== -1) {
        count += 1;
        idx = view.indexOf(NL, idx + 1);
      }
      pos += r.bytesRead;
    }
    if (size > 0) {
      const tail = Buffer.allocUnsafe(1);
      await fh.read(tail, 0, 1, size - 1);
      if (tail[0] !== NL) count += 1; // 末尾没有换行也算一条记录
    }
  } catch {
    /* 读不动就按已知值 */
  } finally {
    await fh.close();
  }
  lineCountCache.set(file, { size, count });
  return count;
}

/** 文件头扫描：会话 id / cwd / 标题 / 关键操作，避免为索引读全文。 */
async function probeHead(file, st) {
  const info = { sessionId: undefined, cwd: undefined, title: undefined, filesTouched: [], commands: [] };
  // 压缩会话必须整体解压后才能拿到 session_meta（明文路径才走 readHead 的头部窗口）
  const buf = (await isZstdFile(file))
    ? await readPlainBuffer(file)
    : await readHead(file, HEAD_BYTES);
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(NL, i);
    const complete = nl !== -1;
    const end = complete ? nl : buf.length;
    const parsed = parseRecordBuffer(buf.subarray(i, end));
    i = end + 1;
    if (!parsed.value) {
      if (!complete) break;
      continue;
    }
    const rec = parsed.value;
    const p = rec.payload || {};
    if (rec.type === "session_meta") {
      info.sessionId = info.sessionId ?? (p.session_id ? String(p.session_id) : p.id ? String(p.id) : undefined);
      info.cwd = info.cwd ?? p.cwd;
    } else if (rec.type === "turn_context" && !info.cwd) {
      info.cwd = p.cwd;
    } else if (rec.type === "response_item" && p.type === "message" && p.role === "user" && !info.title) {
      info.title = cleanTitle(contentText(p.content));
    } else if (rec.type === "response_item" && p.type === "function_call") {
      const d = extractCallData(p.name, p.arguments) ?? {};
      if (d.paths && info.filesTouched.length < MAX_SCAN_DETAIL) info.filesTouched.push(...d.paths);
      if (d.command && info.commands.length < MAX_SCAN_DETAIL) info.commands.push(d.command);
    } else if (rec.type === "response_item" && p.type === "custom_tool_call") {
      const d = extractCallData(p.name, { input: p.input }) ?? {};
      if (d.paths && info.filesTouched.length < MAX_SCAN_DETAIL) info.filesTouched.push(...d.paths);
      const cmd = extractExecCommand(typeof p.input === "string" ? p.input : "");
      if (cmd && info.commands.length < MAX_SCAN_DETAIL) info.commands.push(cmd);
    }
  }
  if (!info.sessionId) info.sessionId = sessionIdFromFile(file);
  if (!info.cwd && st && typeof st.cwd === "string") info.cwd = st.cwd;
  info.filesTouched = [...new Set(info.filesTouched)].slice(0, MAX_SCAN_DETAIL);
  info.commands = [...new Set(info.commands)].slice(0, MAX_SCAN_DETAIL);
  return info;
}

/** 摘要（含缓存：mtime + size 未变就直接复用）。 */
async function summarize(file, st) {
  const cached = summaryCache.get(file);
  if (cached && cached.size === st.size && cached.mtime === st.mtimeMs) return cached.summary;
  const info = await probeHead(file, st);
  const events = await countRecords(file, st.size);
  const summary = {
    participant: PARTICIPANT,
    sessionId: info.sessionId ?? sessionIdFromFile(file),
    title: info.title,
    cwd: info.cwd,
    file,
    mtime: st.mtimeMs,
    bytes: st.size,
    events,
    filesTouched: info.filesTouched,
    commands: info.commands,
  };
  summaryCache.set(file, { size: st.size, mtime: st.mtimeMs, summary });
  return summary;
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

/**
 * 创建 Codex 适配器。
 * @param {{sessionsDir?: string, activeWindowMs?: number, pollMs?: number}} [opts]
 * @returns {import('./contract.js').SourceAdapter}
 */
export function createCodexAdapter(opts = {}) {
  const sessionsDir = opts.sessionsDir ?? defaultSessionsDir();
  const activeWindowMs = Number.isFinite(opts.activeWindowMs) ? opts.activeWindowMs : 60 * 60 * 1000;
  const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : 1500;

  /** 列出所有会话摘要，按最近活动倒序。 */
  async function listSessions() {
    const files = await listJsonlFiles(sessionsDir);
    const out = [];
    for (const file of files) {
      let st;
      try {
        st = await stat(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      try {
        out.push(await summarize(file, st));
      } catch {
        // 单个文件读不了不能影响整张索引
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  /** 最近被写入的会话（默认 1 小时内），用于实时跟随。 */
  async function findActive() {
    const files = await listJsonlFiles(sessionsDir);
    let best = null;
    for (const file of files) {
      let st;
      try {
        st = await stat(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.st.mtimeMs) best = { file, st };
    }
    if (!best) return null;
    if (activeWindowMs > 0 && Date.now() - best.st.mtimeMs > activeWindowMs) return null;
    try {
      return await summarize(best.file, best.st);
    } catch {
      return null;
    }
  }

  /**
   * 解析一个会话文件。
   * @param {import('./contract.js').SessionSummary} session
   * @param {{sinceOffset?: number}} [o]
   */
  async function readSession(session, o = {}) {
    const file = session?.file;
    const since = Number.isFinite(o.sinceOffset) ? o.sinceOffset : 0;
    if (!file) return { events: [], offset: since };
    let win;
    try {
      win = await readWindow(file, since);
    } catch {
      return { events: [], offset: since }; // 文件被删/锁住：静默跳过
    }
    const scanned = scanRecords(win);
    const ctx = {
      sessionId: session?.sessionId ?? sessionIdFromFile(file),
      cwd: session?.cwd,
      title: session?.title,
      ts: Number.isFinite(scanned.mtime) ? scanned.mtime : Date.now(),
      offset: 0,
    };
    const events = [];
    for (const r of scanned.records) {
      ctx.offset = r.start;
      let mapped = null;
      try {
        mapped = mapRecord(r.obj, ctx);
      } catch {
        mapped = null; // 任何单条记录的问题都不向外抛
      }
      if (!mapped) continue;
      try {
        events.push(
          makeEvent({
            participant: PARTICIPANT,
            sessionId: mapped.sessionId ?? ctx.sessionId,
            sessionTitle: ctx.title,
            cwd: mapped.cwd ?? ctx.cwd,
            kind: mapped.kind,
            role: mapped.role,
            text: mapped.text,
            data: mapped.data,
            ts: mapped.ts ?? ctx.ts,
            sourceFile: file,
            sourceOffset: r.start,
            sourceId: mapped.sourceId,
          }),
        );
      } catch {
        /* makeEvent 的参数问题（理论上不会）也不外抛 */
      }
    }
    // ── 结果回填：把 *_output 里的 exitCode 挂回对应的发起事件 ──────────────
    // Codex 把一次 shell 调用拆成两条记录：function_call/custom_tool_call（发起）
    // 与 *_call_output（结果，带 exit_code）。但我们把发起映射成 kind=command、
    // 把结果映射成 kind=tool，两者不关联，于是 command 事件的 exitCode 永远是
    // undefined —— 表现为交接简报里"命令 148 条，成功 0，失败 0"，失败也看不出。
    // 这里按 callId 建索引回填。只改内存中的对象，不重新走makeEvent
    // （事件已按sourceOffset 定序，重建会破坏顺序与去重语义）。
    pairCommandResults(events);
    // 摘要缓存里的标题 / 事件数顺手更新，便于 watcher 只调 readSession 也能拿到索引信息
    const summary = summaryCache.get(file);
    if (summary) summary.summary.mtime = scanned.mtime;
    return { events, offset: scanned.offset, bytes: scanned.size, mtime: scanned.mtime, records: scanned.records.length, skippedLines: scanned.truncated };
  }

  /**
   * 实时跟随：轮询文件增长，增量解析后回调。
   * 契约签名 follow(session, onEvents, signal)；第 4 个 opts 是可选扩展
   * （sinceOffset / pollMs / onOffset），watcher 用它对齐自己的 offset 账本。
   */
  async function follow(session, onEvents, signal, o = {}) {
    const file = session?.file;
    if (!file) return;
    const interval = Number.isFinite(o.pollMs) ? o.pollMs : pollMs;
    let offset = Number.isFinite(o.sinceOffset) ? o.sinceOffset : 0;
    let cursor = { ...session };
    while (!signal?.aborted) {
      let res = null;
      try {
        res = await readSession(cursor, { sinceOffset: offset });
      } catch {
        res = null;
      }
      if (res) {
        offset = res.offset;
        if (typeof o.onOffset === "function") {
          try {
            o.onOffset(offset, file);
          } catch {
            /* 回调问题不影响跟随 */
          }
        }
        if (res.events.length) {
          try {
            await onEvents(res.events);
          } catch {
            /* 消费方异常不能让跟随循环退出 */
          }
        }
        // 标题等信息可能在会话推进中出现
        cursor = { ...cursor, mtime: res.mtime, bytes: res.bytes };
      }
      if (signal?.aborted) break;
      await new Promise((resolve) => {
        const t = setTimeout(resolve, interval);
        if (signal) {
          const onAbort = () => {
            clearTimeout(t);
            resolve();
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
  }

  return { participant: PARTICIPANT, listSessions, findActive, readSession, follow, sessionsDir };
}

/** 默认实例（~/.codex/sessions）。 */
export const codexAdapter = createCodexAdapter();

export default codexAdapter;
