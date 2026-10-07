// dsh-agent-sync — 追加式事件总线。
//
// 一条 append-only 的 NDJSON 是三方同步的唯一真相：Codex / WorkBuddy 的解析器
// 往里追加自己读到的事件，DSH 侧把工具调用与结论也追加进去，读方按 cursor 增量消费。
// 同一时间可能有多个 Host 进程/外部脚本写这个文件，所以写入走串行队列 + 单次 append。

import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, appendFile, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * 事件的稳定去重键。导出以便测试直接断言。
 *
 * 关键教训：这里**绝不能包含 ts**。
 * `session/event` 会被两条订阅路径（全局兜底 + 逐 agent 作用域）各投递一次，
 * 两次处理的时刻相差几毫秒；若键里带 ts，同一条逻辑事件就会被记两遍。
 * 优先用信封里已生成的稳定 id（由 participant+sessionId+sourceId 派生），
 * 没有 sourceId 时退回“内容指纹”，同样不含时间。
 */
export function eventKey(ev) {
  if (ev.sourceId != null && ev.id) return `id:${ev.id}`;
  if (ev.sourceId != null) {
    return `src:${ev.participant}\u0000${ev.sessionId}\u0000${ev.sourceId}`;
  }
  const h = createHash("sha1");
  h.update([ev.participant, ev.sessionId, ev.kind, ev.text].join("\u0000"));
  return `fp:${h.digest("hex")}`;
}

export class EventBus extends EventEmitter {
  /** @param {{busFile: string, cursorFile?: string, maxEventChars?: number}} opts */
  constructor(opts) {
    super();
    this.setMaxListeners(0);
    this.busFile = opts.busFile;
    this.cursorFile = opts.cursorFile ?? join(dirname(opts.busFile), "cursors.json");
    this.maxEventChars = opts.maxEventChars ?? 4000;

    /** @type {object[]} 内存中的事件（只保留尾部，防止无限增长） */
    this.events = [];
    this.maxInMemory = 20000;
    /** @type {Map<string, number>} key -> index，用于 O(1) 去重 */
    this.keys = new Map();
    /** @type {number} 已落盘的字节偏移，也是 NDJSON 行号的近似 */
    this.offset = 0;
    /** @type {number} 单调递增序号，写入每行；cursor 以它为准 */
    this.seq = 0;
    /** @type {Map<string, number>} 每个 reader 的 cursor（NDJSON 行号） */
    this.readers = new Map();
    this._writeChain = Promise.resolve();
    /** 统计：供工具层汇报健康度 */
    this.stats = { appended: 0, deduped: 0, byParticipant: {}, byKind: {} };
  }

  /** 读取已有总线文件，恢复内存索引与 reader cursor。 */
  async load() {
    await mkdir(dirname(this.busFile), { recursive: true });
    let raw = "";
    try {
      raw = await readFile(this.busFile, "utf8");
    } catch {
      return this;
    }
    this.offset = Buffer.byteLength(raw, "utf8");
    let duplicates = 0;
    let total = 0;
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      total += 1;
      let ev;
      try {
        ev = JSON.parse(s);
      } catch {
        continue; // 容忍半行/损坏行
      }
      const key = eventKey(ev);
      if (this.keys.has(key)) {
        duplicates += 1;
        continue;
      }
      ev.seq = ++this.seq; // 补齐/校正单调序号
      this.keys.set(key, this.events.length);
      this.events.push(ev);
      this.stats.byParticipant[ev.participant] = (this.stats.byParticipant[ev.participant] ?? 0) + 1;
      this.stats.byKind[ev.kind] = (this.stats.byKind[ev.kind] ?? 0) + 1;
      this.stats.appended += 1;
    }
    // 磁盘压实：历史上曾因去重键含 ts 而落下重复行；读取时顺手把文件重写干净，
    // 这样文件不会随每次双订阅持续膨胀。（每次启动最多一次写。）
    if (duplicates > 0) {
      try {
        await rename(this.busFile, `${this.busFile}.bak-dedupe`);
        await writeFile(this.busFile, this.events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
        this.offset = 0;
        this.stats.compacted = `${total} → ${this.events.length}`;
      } catch {
        /* 压实是尽力而为：失败也不影响内存里的正确性 */
      }
    }
    if (this.events.length > this.maxInMemory) {
      const drop = this.events.length - this.maxInMemory;
      this.events.splice(0, drop);
      this.keys.clear();
      this.events.forEach((ev, i) => this.keys.set(eventKey(ev), i));
    }
    try {
      const cursors = JSON.parse(await readFile(this.cursorFile, "utf8"));
      for (const [k, v] of Object.entries(cursors)) this.readers.set(k, Number(v) || 0);
    } catch {
      /* 首次运行没有 cursor */
    }
    return this;
  }

  /**
   * 追加一条或多条 envelope。返回真正新增的条数。
   * @param {object|object[]} input
   */
  append(input) {
    const list = Array.isArray(input) ? input : [input];
    const accepted = [];
    for (const raw of list) {
      if (!raw || raw.v !== 1) continue;
      const key = eventKey(raw);
      if (this.keys.has(key)) {
        this.stats.deduped += 1;
        continue;
      }
      // 注意：下面两处会对 ev 重新赋值（截断正文、补 seq），所以必须是 let
      let ev = raw;
      if (typeof ev.text === "string" && ev.text.length > this.maxEventChars) {
        ev = { ...ev, text: `${ev.text.slice(0, this.maxEventChars)}\n…[truncated ${ev.text.length - this.maxEventChars} chars]` };
      }
      ev = { ...ev, seq: ++this.seq };
      this.keys.set(key, this.events.length);
      this.events.push(ev);
      accepted.push(ev);
      this.stats.byParticipant[ev.participant] = (this.stats.byParticipant[ev.participant] ?? 0) + 1;
      this.stats.byKind[ev.kind] = (this.stats.byKind[ev.kind] ?? 0) + 1;
    }
    if (!accepted.length) return 0;

    const lines = `${accepted.map((e) => JSON.stringify(e)).join("\n")}\n`;
    this._writeChain = this._writeChain
      .then(() => appendFile(this.busFile, lines, "utf8"))
      .then(() => {
        this.offset += Buffer.byteLength(lines, "utf8");
        this.stats.appended += accepted.length;
        this.emit("append", accepted);
      })
      .catch((err) => {
        this.emit("error", err);
      });

    if (this.events.length > this.maxInMemory) {
      const drop = this.events.length - this.maxInMemory;
      this.events.splice(0, drop);
      this.keys.clear();
      this.events.forEach((ev, i) => this.keys.set(eventKey(ev), i));
    }
    return accepted.length;
  }

  /** 确保挂起的写入落盘（工具返回前调用，保证跨进程可见）。 */
  async flush() {
    await this._writeChain;
  }

  /** 全部事件（尾部截断后的内存视图）。 */
  all() {
    return this.events;
  }

  /**
   * 就一个事件数组做过滤（query/queryFull 共用）。
   * @param {object[]} source
   */
  _filter(source, q) {
    const since = q.since ?? 0;
    const until = q.until ?? Number.POSITIVE_INFINITY;
    const needle = q.text ? q.text.toLowerCase() : undefined;
    const parts = q.participants?.length ? new Set(q.participants) : undefined;
    let kinds = q.kinds?.length ? new Set(q.kinds) : undefined;
    if (q.keyOnly) kinds = new Set(["user", "assistant", "file_write", "command", "plan", "turn"]);
    let out = source.filter((ev) => {
      if (ev.ts < since || ev.ts > until) return false;
      if (parts && !parts.has(ev.participant)) return false;
      if (kinds && !kinds.has(ev.kind)) return false;
      if (q.sessionId && ev.sessionId !== q.sessionId) return false;
      if (q.cwdKey && !(ev.cwd ?? "").toLowerCase().replace(/\\/g, "/").includes(q.cwdKey)) return false;
      return true;
    });
    if (needle) {
      out = out.filter((ev) => {
        const hay = `${ev.text}\n${ev.sessionTitle ?? ""}\n${ev.data ? JSON.stringify(ev.data) : ""}`.toLowerCase();
        return hay.includes(needle);
      });
    }
    out.sort((a, b) => a.ts - b.ts);
    const limit = q.limit ?? 200;
    return q.tail === false ? out.slice(0, limit) : out.slice(-limit);
  }

  /**
   * 查询事件（内存视图）。
   * @param {{participants?: string[], kinds?: string[], since?: number, until?: number,
   *          cwd?: string, cwdKey?: string, sessionId?: string, text?: string,
   *          limit?: number, tail?: boolean, keyOnly?: boolean}} q
   */
  query(q = {}) {
    return this._filter(this.events, q);
  }

  /** 直接扫盘读取日志（内存被裁剪或需要完整历史时用）。 */
  async readAllFromFile() {
    let raw = "";
    try {
      raw = await readFile(this.busFile, "utf8");
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const ev = JSON.parse(s);
        if (ev && ev.v === 1) out.push(ev);
      } catch {
        /* 半行/损坏行跳过 */
      }
    }
    return out;
  }

  /**
   * 查询事件，必要时回落到读文件，保证“内存裁剪后仍能拿到完整历史”。
   * 判定依据是“内存是否覆盖了请求范围”，不是“有没有传 since”：
   *  - 内存被裁剪过（长度达到上限）→ 读盘
   *  - 请求的 since 早于内存最早一条 → 读盘
   *  - 什么都没传（要全量）→ 读盘
   * 读盘结果与内存结果按 seq 合并去重，避免竞态下漏掉尚未落盘的新事件。
   */
  async queryFull(q = {}) {
    const trimmed = this.events.length >= this.maxInMemory;
    const earliest = this.events.length ? this.events[0].ts : Number.POSITIVE_INFINITY;
    const wantsEverything = q.since === undefined;
    const needsFile = this.events.length === 0 || trimmed || wantsEverything || (q.since ?? 0) < earliest;
    if (!needsFile) return this.query(q);

    const fromFile = await this.readAllFromFile();
    const seen = new Set();
    const merged = [];
    for (const ev of [...fromFile, ...this.events]) {
      const k = `${ev.seq ?? ""}|${ev.id ?? ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(ev);
    }
    return this._filter(merged, q);
  }

  /** 某个 reviewer 视角的未读事件（seq 大于它的 cursor）。跨裁剪也正确。 */
  async unread(readerId, q = {}) {
    const cursor = this.readers.get(readerId) ?? 0;
    const all = await this.queryFull({ ...q, limit: Number.MAX_SAFE_INTEGER, tail: false });
    return all.filter((ev) => ev.seq > cursor);
  }

  /** 记录 reader 已消费到的最新 seq。 */
  async ack(readerId, uptoSeq) {
    const next = Math.max(this.readers.get(readerId) ?? 0, Number(uptoSeq) || 0);
    this.readers.set(readerId, next);
    const obj = Object.fromEntries(this.readers);
    const tmp = `${this.cursorFile}.tmp`;
    await mkdir(dirname(this.cursorFile), { recursive: true });
    await writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
    await rename(tmp, this.cursorFile);
  }

  /** reader 自上次消费以来的新增事件条数（用于“有没有新动静”）。 */
  async pendingCount(readerId, q = {}) {
    return (await this.unread(readerId, q)).length;
  }

  /** 当前最大 seq。 */
  head() {
    return this.seq;
  }
}
