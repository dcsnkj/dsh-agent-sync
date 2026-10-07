// dsh-agent-sync — WorkBuddy 会话来源适配器（SourceAdapter 实现）
//
// 源：~/.workbuddy/projects/<project-slug>/<uuid>.jsonl（每行一个 JSON 对象）
// 实测记录（32 个会话文件统计）：
//   session-meta            {id, sessionId, timestamp, meta}                （只有 4/32 个文件有）
//   message                 {id, parentId, timestamp(epoch ms), role, content:[{type:'input_text'|'output_text',text}]}
//   reasoning               {id, timestamp, content:[], rawContent:[{type:'reasoning_text',text}]}
//   function_call           {id, timestamp, name, arguments(JSON 字符串), callId, providerData.reasoning, cwd}
//   function_call_result    {id, timestamp, name, callId, status, output:{type:'text',text}}
//   file-history-snapshot    {id, timestamp, snapshot:{messageId, trackedFileBackups:{<路径>:{...}}}, cwd}
//   ai-title                {timestamp, aiTitle, sessionId, cwd}
//   resend-fork-notice      改字重发通知（无内容，丢弃）
//
// 与 Codex 的差别：
//   - timestamp 是 epoch 毫秒；
//   - 工具名是 Claude-Code 方言（Bash / Edit / Write / Read / Glob / Grep / PowerShell / Task* …）；
//   - function_call_result 的 callId 字段名可能是 callId / call_id / id，都要兼容；
//   - file-history-snapshot 是「真的改了哪些文件」的权威来源，但会与 Edit/Write 调用重复，
//     所以同一批次里已经由 function_call 报过的文件不再重复产出 file_write；
//   - sessionId 多数文件没有 session-meta，退化到文件名 UUID；cwd 优先取记录里的 cwd 字段，
//     其次从用户消息的 "Workspace Folder:" 行抽，最后才用 project-slug 反解。

import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { classifyToolName, extractCallData, extractResultData, makeEvent, pathKey } from "../contract.js";

/** @type {'workbuddy'} */
export const PARTICIPANT = "workbuddy";

/** ~/.workbuddy/projects（可用 WORKBUDDY_HOME 覆盖）。 */
export function defaultProjectsDir() {
  const home = process.env.WORKBUDDY_HOME?.trim() || join(homedir(), ".workbuddy");
  return join(home, "projects");
}

const HEAD_BYTES = 96 * 1024;
const MAX_TEXT = 4000;
const MAX_REASONING = 1200;
const MAX_DESC = 200;
const MAX_SCAN_DETAIL = 40;
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const NL = 0x0a;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function cut(s, n) {
  const t = typeof s === "string" ? s : s == null ? "" : String(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function pick(src, keys) {
  const out = {};
  if (!src || typeof src !== "object") return out;
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function tsOf(rec, fallback) {
  const t = rec?.timestamp;
  if (typeof t === "number" && Number.isFinite(t)) return t < 1e12 ? Math.round(t * 1000) : t;
  if (typeof t === "string") {
    const n = Date.parse(t);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** content 数组 → 文本（image_blob_ref 之类非文本部件忽略）。 */
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

/** reasoning 记录取可见推理：rawContent(reasoning_text) 优先，其次 content。 */
function reasoningText(rec) {
  const parts = [];
  for (const arr of [rec.rawContent, rec.content]) {
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      if (it && typeof it.text === "string" && it.text) parts.push(it.text);
    }
  }
  return parts.join("\n").trim();
}

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

function sessionIdFromFile(file) {
  const b = basename(String(file || ""));
  const m = UUID_RE.exec(b);
  return m ? m[1] : b.replace(/\.jsonl$/i, "").slice(0, 80) || "unknown";
}

/** 去掉成对的上下文块（<system-reminder …>…</system-reminder> 等）。 */
function stripContextBlocks(s) {
  let t = String(s || "");
  let prev;
  do {
    prev = t;
    t = t.replace(/<([a-zA-Z][\w:-]*)[^>]*>[\s\S]*?<\/\1>/g, " ");
  } while (t !== prev);
  return t.replace(/<[^>]*>/g, " ");
}

/** WorkBuddy 自动注入的用户上下文块（不是人说的话）。 */
const AUTO_CONTEXT_RE = /^\s*<(system-reminder|user_info|environment_context|app-context|identity_context)\b/i;

function cleanTitle(s) {
  const t = stripContextBlocks(s).replace(/\s+/g, " ").trim();
  if (!t || /^Workspace Folder:/i.test(t)) return undefined;
  return t.length > 80 ? t.slice(0, 80) : t;
}

/** 从用户消息里抽 "Workspace Folder: xxx"（WorkBuddy 会把工作目录写在 system-reminder 里）。 */
function workspaceFolderFromText(text) {
  const m = /Workspace Folder:\s*(.+)/.exec(String(text || ""));
  if (!m) return undefined;
  const v = m[1].split(/[\r\n]/)[0].trim();
  return v || undefined;
}

/**
 * project-slug 反解：c-Users-<user>-WorkBuddy-2026-10-06-23-21-43
 * → C:\Users\<user>\WorkBuddy\2026-10-06-23-21-43
 * slug 里的 '-' 有歧义（目录名也可能带 '-'），只是没有 cwd 字段时的兜底。
 */
function cwdFromSlug(slug) {
  const m = /^([a-zA-Z])-(.+?)-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})$/.exec(String(slug || ""));
  if (!m) return undefined;
  const drive = m[1].toUpperCase();
  const middle = m[2].replace(/-/g, "\\");
  return `${drive}:\\${middle}\\${m[3]}`;
}

/** 相对路径按会话 cwd 补全；已经是绝对路径就原样返回。 */
function resolvePath(p, cwd) {
  const s = String(p || "");
  if (!s) return s;
  if (isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("\\\\")) return s;
  if (!cwd) return s;
  return join(cwd, s);
}

function describeCall(name, data) {
  if (data?.command) return `${name}: ${cut(data.command, MAX_DESC)}`;
  if (data?.paths?.length) return `${name}: ${cut(data.paths.join(", "), MAX_DESC)}`;
  if (data?.raw) return `${name}: ${cut(data.raw, MAX_DESC)}`;
  return String(name || "tool");
}

/**
 * WorkBuddy 实测名字 → kind 的修正表（classifyToolName 的通用正则会误判）：
 *   write_stdin  给正在运行的程序写 stdin，不是改文件；
 *   TaskCreate / TaskUpdate / TaskList 是 WorkBuddy 的待办/计划通道 → plan（KEY_KIND）。
 */
const WORKBUDDY_KIND_OVERRIDE = {
  write_stdin: "command",
  taskcreate: "plan",
  taskupdate: "plan",
  tasklist: "plan",
};

function wbKind(name) {
  return WORKBUDDY_KIND_OVERRIDE[String(name || "").toLowerCase()] ?? classifyToolName(name);
}

/** 结果里抽退出码 / 错误 / 摘要；output 可能是 string，也可能是 {type:'text',text}。 */
function resultInfo(output) {
  let raw = "";
  if (typeof output === "string") raw = output;
  else if (output && typeof output === "object") raw = typeof output.text === "string" ? output.text : JSON.stringify(output);
  const res = extractResultData(raw || "");
  return { raw, ...res };
}

// ---------------------------------------------------------------------------
// 增量读文件（与 codex 同一套语义：字节偏移精确、半行不消费）
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

async function readWindow(file, sinceOffset) {
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
      if (!complete) break;
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
    if (!complete) break;
    offset = nextOffset;
    i = end + 1;
  }
  return { records, offset, size: win.size, mtime: win.mtime, truncated };
}

// ---------------------------------------------------------------------------
// 记录 → envelope
// ---------------------------------------------------------------------------

/** 记录里可能带 cwd / sessionId，先同步到上下文，事件才有一致的归属。 */
function syncContext(rec, ctx) {
  if (typeof rec.cwd === "string" && rec.cwd) ctx.cwd = rec.cwd;
  if (typeof rec.sessionId === "string" && rec.sessionId) ctx.sessionId = rec.sessionId;
}

function mapRecord(rec, ctx) {
  const type = rec?.type;
  const off = ctx.offset;
  const srcId = (id) => (id != null && id !== "" ? String(id) : `off:${off}`);
  const ts = tsOf(rec, ctx.ts);

  if (type === "session-meta") {
    if (rec.sessionId) ctx.sessionId = String(rec.sessionId);
    const hostKind = rec.meta && typeof rec.meta === "object" ? rec.meta["codebuddy.ai/hostKind"] : undefined;
    return {
      kind: "meta",
      role: "system",
      text: `WorkBuddy session started${ctx.cwd ? ` @ ${ctx.cwd}` : ""}`,
      data: pick({ sessionId: rec.sessionId, hostKind }, ["sessionId", "hostKind"]),
      ts,
      sourceId: srcId(rec.id ?? "session_meta"),
    };
  }

  if (type === "ai-title") {
    const title = cleanTitle(rec.aiTitle);
    if (title) ctx.title = title;
    if (rec.cwd) ctx.cwd = rec.cwd;
    return {
      kind: "meta",
      role: "system",
      text: title ? `title: ${title}` : "title updated",
      data: pick({ aiTitle: rec.aiTitle }, ["aiTitle"]),
      ts,
      sourceId: srcId(`ai_title:${rec.timestamp ?? off}`),
    };
  }

  if (type === "message") {
    const role = String(rec.role || "");
    if (role !== "user" && role !== "assistant") return null;
    const text = contentText(rec.content).trim();
    if (!text) return null;
    if (!ctx.cwd) ctx.cwd = workspaceFolderFromText(text);
    // 纯上下文块的 user 消息（只剩 <system-reminder> 元信息）不是人的指令，丢弃。
    if (role === "user" && AUTO_CONTEXT_RE.test(text) && !cleanTitle(text)) return null;
    return {
      kind: role,
      role,
      text: cut(text, MAX_TEXT),
      data: { role, chars: text.length },
      ts,
      sourceId: srcId(rec.id),
    };
  }

  if (type === "reasoning") {
    const text = reasoningText(rec);
    if (!text) return null;
    return {
      kind: "reasoning",
      role: "assistant",
      text: cut(text, MAX_REASONING),
      data: { chars: text.length },
      ts,
      sourceId: srcId(rec.id),
    };
  }

  if (type === "function_call") {
    const name = String(rec.name || "tool");
    const data = { name, ...(extractCallData(name, rec.arguments) ?? {}) };
    const callId = rec.callId ?? rec.call_id ?? rec.id;
    if (callId) data.callId = callId;
    const kind = wbKind(name);
    const mapped = { kind, role: "tool", text: describeCall(name, data), data, ts, sourceId: srcId(callId) };
    if (kind === "file_write" && Array.isArray(data.paths)) {
      for (const p of data.paths) ctx.seenWritePaths.add(pathKey(resolvePath(p, ctx.cwd)));
    }
    return mapped;
  }

  if (type === "function_call_result") {
    const callId = rec.callId ?? rec.call_id ?? rec.id;
    const info = resultInfo(rec.output);
    const data = pick({ callId, status: rec.status, exitCode: info.exitCode, isError: info.isError }, [
      "callId",
      "status",
      "exitCode",
      "isError",
    ]);
    return {
      kind: "tool",
      role: "tool",
      text: info.summary ? cut(info.summary, 400) : "",
      data,
      ts,
      sourceId: srcId(callId ? `${callId}:out` : rec.id),
    };
  }

  if (type === "file-history-snapshot") {
    const snap = rec.snapshot && typeof rec.snapshot === "object" ? rec.snapshot : {};
    const tracked = snap.trackedFileBackups && typeof snap.trackedFileBackups === "object" ? snap.trackedFileBackups : {};
    const all = Object.keys(tracked);
    if (!all.length) return null;
    // 同一批次里 function_call 已经报过的文件不再重复；跨批次重复由总线按 id 去重兜底。
    const fresh = [];
    for (const raw of all) {
      const abs = resolvePath(raw, rec.cwd ?? ctx.cwd);
      const key = pathKey(abs);
      if (ctx.seenWritePaths.has(key)) continue;
      ctx.seenWritePaths.add(key);
      fresh.push(abs);
    }
    if (!fresh.length) return null;
    return {
      kind: "file_write",
      role: "tool",
      text: `file snapshot: ${cut(fresh.join(", "), MAX_DESC)}`,
      data: { paths: fresh, wrotePaths: fresh, isSnapshotUpdate: !!rec.isSnapshotUpdate, messageId: snap.messageId },
      ts,
      // 去重键必须唯一到「这一条快照记录」：多个 file-history-snapshot 会共享同一个
      // snap.messageId（各自 list 不同文件），只用 messageId 会让不同快照撞成同一个 id。
      // 因此带上记录自身的 timestamp 与字节偏移。
      sourceId: srcId(`snapshot:${snap.messageId ?? rec.id ?? "na"}:${rec.timestamp ?? "na"}:${off}`),
    };
  }

  // resend-fork-notice 等：有元信息但没有同步价值
  return null;
}

// ---------------------------------------------------------------------------
// 会话发现与摘要
// ---------------------------------------------------------------------------

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
      else if (e.isFile() && e.name.toLowerCase().endsWith(".jsonl")) out.push(p);
    }
  };
  await walk(dir);
  return out;
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

const lineCountCache = new Map();
const summaryCache = new Map();

async function countRecords(file, size) {
  const cached = lineCountCache.get(file);
  if (cached && cached.size === size) return cached.count;
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
      if (tail[0] !== NL) count += 1;
    }
  } catch {
    /* ignore */
  } finally {
    await fh.close();
  }
  lineCountCache.set(file, { size, count });
  return count;
}

/** 文件头扫描：sessionId / cwd / 标题 / 关键操作。 */
async function probeHead(file, st) {
  const info = { sessionId: undefined, cwd: undefined, title: undefined, filesTouched: [], commands: [] };
  const buf = await readHead(file, HEAD_BYTES);
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
    if (typeof rec.cwd === "string" && rec.cwd) info.cwd = info.cwd ?? rec.cwd;
    if (rec.type === "session-meta" && rec.sessionId) info.sessionId = info.sessionId ?? String(rec.sessionId);
    else if (rec.type === "ai-title") info.title = cleanTitle(rec.aiTitle) ?? info.title; // ai-title 最权威
    else if (rec.type === "message" && rec.role === "user") {
      const text = contentText(rec.content);
      if (!info.title) info.title = cleanTitle(text);
      if (!info.cwd) info.cwd = workspaceFolderFromText(text);
    } else if (rec.type === "function_call") {
      const d = extractCallData(rec.name, rec.arguments) ?? {};
      if (d.paths && info.filesTouched.length < MAX_SCAN_DETAIL) info.filesTouched.push(...d.paths.map((p) => resolvePath(p, rec.cwd ?? info.cwd)));
      if (d.command && info.commands.length < MAX_SCAN_DETAIL) info.commands.push(d.command);
    }
  }
  if (!info.sessionId) info.sessionId = sessionIdFromFile(file);
  if (!info.cwd) info.cwd = cwdFromSlug(basename(join(file, "..")));
  if (!info.cwd && st && typeof st.cwd === "string") info.cwd = st.cwd;
  info.filesTouched = [...new Set(info.filesTouched)].slice(0, MAX_SCAN_DETAIL);
  info.commands = [...new Set(info.commands)].slice(0, MAX_SCAN_DETAIL);
  return info;
}

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
 * 创建 WorkBuddy 适配器。
 * @param {{projectsDir?: string, activeWindowMs?: number, pollMs?: number, log?: Function}} [opts]
 * @returns {import('./contract.js').SourceAdapter}
 */
export function createWorkBuddyAdapter(opts = {}) {
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  const activeWindowMs = Number.isFinite(opts.activeWindowMs) ? opts.activeWindowMs : 60 * 60 * 1000;
  const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : 1500;

  async function listSessions() {
    const files = await listJsonlFiles(projectsDir);
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
        /* 单文件失败不影响索引 */
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  async function findActive() {
    const files = await listJsonlFiles(projectsDir);
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

  async function readSession(session, o = {}) {
    const file = session?.file;
    const since = Number.isFinite(o.sinceOffset) ? o.sinceOffset : 0;
    if (!file) return { events: [], offset: since };
    let win;
    try {
      win = await readWindow(file, since);
    } catch {
      return { events: [], offset: since };
    }
    const scanned = scanRecords(win);
    // cwd 优先级：记录里的 cwd 字段 > 用户消息里的 "Workspace Folder:" 行 > project-slug 反解。
    // session.cwd（来自摘要）先当作已知值；slug 只作为最后兜底，不抢 Workspace Folder。
    const slugCwd = cwdFromSlug(basename(join(file, "..")));
    const ctx = {
      sessionId: session?.sessionId ?? sessionIdFromFile(file),
      cwd: session?.cwd,
      fallbackCwd: session?.cwd ?? slugCwd,
      title: session?.title,
      ts: Number.isFinite(scanned.mtime) ? scanned.mtime : Date.now(),
      offset: 0,
      seenWritePaths: new Set(),
    };
    const events = [];
    for (const r of scanned.records) {
      ctx.offset = r.start;
      syncContext(r.obj, ctx);
      let mapped = null;
      try {
        mapped = mapRecord(r.obj, ctx);
      } catch {
        mapped = null;
      }
      if (!mapped) continue;
      try {
        events.push(
          makeEvent({
            participant: PARTICIPANT,
            sessionId: mapped.sessionId ?? ctx.sessionId,
            sessionTitle: ctx.title,
            cwd: mapped.cwd ?? ctx.cwd ?? ctx.fallbackCwd,
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
        /* makeEvent 参数异常不外抛 */
      }
    }
    return { events, offset: scanned.offset, bytes: scanned.size, mtime: scanned.mtime, records: scanned.records.length, skippedLines: scanned.truncated };
  }

  /** 契约签名 follow(session, onEvents, signal)；第 4 个 opts 是可选扩展。 */
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
            /* ignore */
          }
        }
        if (res.events.length) {
          try {
            await onEvents(res.events);
          } catch {
            /* ignore */
          }
        }
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

  return { participant: PARTICIPANT, listSessions, findActive, readSession, follow, projectsDir };
}

/** 默认实例（~/.workbuddy/projects）。 */
export const workbuddyAdapter = createWorkBuddyAdapter();

export default workbuddyAdapter;
