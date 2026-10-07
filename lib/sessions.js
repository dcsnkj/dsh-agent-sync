// dsh-agent-sync — 会话级同步开关 + 协同台账（shared state）。
//
// 两件事：
//  1) 每个 DSH 会话可以独立选择“这个聊天是否与 Codex / WorkBuddy 同步”，以及方向
//     （off / read / write / both）—— 这就是用户要的「可切换模式」。
//  2) 协同台账：从总线里折叠出「谁改过哪个文件 / 谁跑过哪条命令」，用于回答
//     “这一步是不是别人已经做过了”，避免重复操作造成误差。

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { pathKey, modeReads, modeWrites, SYNC_MODES } from "./contract.js";

const DEFAULT_STORE = {
  settings: {}, // sessionId -> { mode, readParticipants[], writeParticipants[], updatedAt }
  bindings: {}, // sessionId -> { participant, sessionId 目标, title, boundAt, bind: 'explicit'|'auto' }
  notes: [], // 每个 agent 的“结论/决定”显式登记，供对方读取
};

/** 临时文件名计数器：同进程内多次保存也不会撞名。 */
let counter = 0;

export class SessionSyncStore {
  /** @param {{file: string, defaultMode?: string, enabledParticipants?: string[]}} opts */
  constructor(opts) {
    this.file = opts.file;
    this.defaultMode = opts.defaultMode ?? "both";
    this.enabledParticipants = opts.enabledParticipants ?? ["codex", "workbuddy"];
    this.data = structuredClone(DEFAULT_STORE);
    this._chain = Promise.resolve();
    /** 最近一次持久化失败的原因（成功时为 null）；供诊断而非静默。 */
    this.lastSaveError = null;
  }

  async load() {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      this.data = { ...structuredClone(DEFAULT_STORE), ...parsed };
    } catch {
      /* 首次运行 */
    }
    return this;
  }

  async _save() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this._chain = this._chain.then(() => this.#writeAtomic(snapshot));
    try {
      await this._chain;
    } catch (err) {
      // 队列已断：必须重新起链，否则一次磁盘错误会让状态永久停写（静默丢设置）。
      this._chain = Promise.resolve();
      this.lastSaveError = String(err?.message ?? err);
      throw err;
    }
    this.lastSaveError = null;
  }

  /**
   * 原子写：写临时文件 → 改名覆盖。
   * 两个细节对Windows 至关重要：
   *  1) 临时名必须唯一。用固定的 `${file}.tmp` 时，进程内多个未 await 的
   *     保存（如 addNote 与 setMode 并发）会互相抢占同一个临时文件，
   *     表现为偶发 EPERM。
   *  2) rename 在 Windows 上会因目标被占用而失败（EPERM/EBUSY），
   *     抗干扰能力比 POSIX 差，需要短暂重试。
   */
  async #writeAtomic(snapshot) {
    const tmp = `${this.file}.${process.pid}.${counter++}.tmp`;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(tmp, snapshot, "utf8");
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rename(tmp, this.file);
        return;
      } catch (err) {
        lastErr = err;
        // 仅对文件占用类错误重试；ENOENT 这类真实失败立即抛出。
        if (!["EPERM", "EBUSY", "EACCES"].includes(err?.code)) break;
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  /** 去掉本方与未知值：参与方名单里出现 "dsh" 永远是配置错误。 */
  #peers(list) {
    const known = new Set(this.enabledParticipants);
    return [...new Set((Array.isArray(list) ? list : []).filter((p) => p !== "dsh" && known.has(p)))];
  }

  /** 某个会话的同步设置（含默认值展开）。 */
  settingsFor(sessionId) {
    const s = this.data.settings?.[sessionId];
    const mode = SYNC_MODES.includes(s?.mode) ? s.mode : this.defaultMode;
    const fallback = this.#peers(this.enabledParticipants);
    return {
      sessionId,
      mode,
      // off 时两个列表都空：既不读也不写
      readParticipants: modeReads(mode) ? this.#peers(s?.readParticipants ?? fallback) : [],
      writeParticipants: modeWrites(mode) ? this.#peers(s?.writeParticipants ?? fallback) : [],
      updatedAt: s?.updatedAt ?? 0,
      inherited: !s,
    };
  }

  /**
   * 切换某个会话的同步模式。
   * @param {string} sessionId
   * @param {string} mode off|read|write|both
   * @param {{readParticipants?: string[], writeParticipants?: string[]}} [patch]
   *        显式传 [] 表示"不跟任何人同步"，与"不传"（沿用默认）语义不同，故用 in 判断。
   */
  async setMode(sessionId, mode, patch = {}) {
    if (!SYNC_MODES.includes(mode)) {
      throw new TypeError(`setMode: 未知模式 "${mode}"（应为 ${SYNC_MODES.join("/")}）`);
    }
    const cur = this.data.settings?.[sessionId] ?? {};
    const next = { ...cur, mode, updatedAt: Date.now() };
    // 只在显式提供时覆盖；空数组是合法值，表示清空该方向。
    for (const key of ["readParticipants", "writeParticipants"]) {
      if (key in patch) next[key] = this.#peers(patch[key]);
    }
    this.data.settings[sessionId] = next;
    await this._save();
    return this.settingsFor(sessionId);
  }

  /** 给某个 participant 写一条协作备注（结论/决定/待办）。 */
  async addNote(note) {
    this.data.notes = this.data.notes ?? [];
    this.data.notes.push({ ...note, ts: note.ts ?? Date.now() });
    if (this.data.notes.length > 2000) this.data.notes.splice(0, this.data.notes.length - 2000);
    await this._save();
  }

  /**
   * 绑定：本 DSH 会话要“盯着”哪个外部会话。
   * 绑定后，提问/接管都默认针对它，不用每次重复指定。
   * @param {string} sessionId 本 DSH 会话
   * @param {{participant: string, targetSessionId: string, title?: string, bind?: string}} target
   */
  async bind(sessionId, target) {
    // 绑定错了比不绑定更糟：后续提问会静默读到另一个人的会话。
    if (!target?.participant || target.participant === "dsh") {
      throw new TypeError("bind: participant 必须是 codex 或 workbuddy");
    }
    if (!this.enabledParticipants.includes(target.participant)) {
      throw new TypeError(`bind: 未启用的参与方 "${target.participant}"`);
    }
    if (!target?.targetSessionId || typeof target.targetSessionId !== "string") {
      throw new TypeError("bind: targetSessionId 必须是非空字符串");
    }
    this.data.bindings = this.data.bindings ?? {};
    this.data.bindings[sessionId] = {
      participant: target.participant,
      targetSessionId: target.targetSessionId,
      title: target.title,
      bind: target.bind ?? "explicit",
      boundAt: Date.now(),
    };
    await this._save();
    return this.data.bindings[sessionId];
  }

  /** 解除绑定。 */
  async unbind(sessionId) {
    this.data.bindings = this.data.bindings ?? {};
    const had = this.data.bindings[sessionId];
    delete this.data.bindings[sessionId];
    await this._save();
    return had;
  }

  /** 读取绑定（若有）。 */
  bindingFor(sessionId) {
    return this.data.bindings?.[sessionId];
  }

  /** 全局设置快照，供诊断工具展示。 */
  snapshot() {
    return {
      defaultMode: this.defaultMode,
      enabledParticipants: this.enabledParticipants,
      sessions: this.data.settings ?? {},
      bindings: this.data.bindings ?? {},
      noteCount: (this.data.notes ?? []).length,
      lastSaveError: this.lastSaveError,
    };
  }
}

/**
 * 两个 participant 是否在同一个实验里（同一个 cwd 前缀）。
 * 同步的意义建立在“同一个工作目录”上，否则只是噪声。
 * @param {string|undefined} a
 * @param {string|undefined} b
 */
export function sameScope(a, b) {
  if (!a || !b) return true; // 信息缺失时不过度过滤
  const ka = pathKey(a);
  const kb = pathKey(b);
  return ka === kb || ka.startsWith(`${kb}/`) || kb.startsWith(`${ka}/`);
}

/**
 * 从总线事件折叠出协同台账：文件维度 + 命令维度。
 * @param {object[]} events
 * @param {{excludeParticipant?: string, withinMs?: number, now?: number}} opts
 */
export function buildLedger(events, opts = {}) {
  const now = opts.now ?? Date.now();
  const withinMs = opts.withinMs ?? 24 * 3600 * 1000;
  const files = new Map(); // pathKey -> {path, writers:Set, readers:Set, lastTs, events}
  const commands = [];
  /** 取或建一条文件记录（路径写法不同也能归并到同一条）。 */
  const fileRec = (p) => {
    const k = pathKey(p);
    let rec = files.get(k);
    if (!rec) {
      rec = { key: k, path: p, writers: new Set(), readers: new Set(), lastTs: 0, events: [] };
      files.set(k, rec);
    }
    return rec;
  };
  for (const ev of events) {
    if (opts.excludeParticipant && ev.participant === opts.excludeParticipant) continue;
    if (now - ev.ts > withinMs) continue;
    const paths = ev.data?.wrotePaths ?? ev.data?.paths ?? [];
    if (ev.kind === "file_write") {
      for (const p of paths) {
        const rec = fileRec(p);
        rec.writers.add(ev.participant);
        rec.lastTs = Math.max(rec.lastTs, ev.ts);
        rec.events.push({ seq: ev.seq, participant: ev.participant, ts: ev.ts, kind: ev.kind });
      }
    } else if (ev.kind === "file_read") {
      for (const p of paths) {
        const rec = fileRec(p);
        rec.readers.add(ev.participant);
        rec.lastTs = Math.max(rec.lastTs, ev.ts);
      }
    } else if (ev.kind === "command" && ev.data?.command) {
      commands.push({
        seq: ev.seq,
        participant: ev.participant,
        ts: ev.ts,
        command: ev.data.command,
        exitCode: ev.data.exitCode,
        cwd: ev.cwd,
      });
    }
  }
  return { files, commands };
}

/**
 * 检查某个文件最近有没有被别的 participant 改过 —— 防重复操作的第一道闸。
 * 比较用归一化路径，且允许“绝对路径 vs 相对路径”互相命中（后缀匹配），
 * 因为三方记录里的路径写法不统一（Codex 常给绝对路径，WorkBuddy 常给相对路径）。
 * @param {Map} files buildLedger 的 files
 * @param {string} path
 * @param {string} selfParticipant
 * @param {{withinMs?: number, now?: number}} [opts]
 */
export function fileConflict(files, path, selfParticipant, opts = {}) {
  const now = opts.now ?? Date.now();
  const withinMs = opts.withinMs ?? 30 * 60 * 1000;
  const target = pathKey(path);
  /** 两条路径是否指向同一文件（相等，或一条是另一条的后缀路径）。 */
  const samePath = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
  const hits = [];
  for (const rec of files.values()) {
    if (!samePath(rec.key, target)) continue;
    const others = [...rec.writers].filter((p) => p !== selfParticipant);
    if (!others.length) continue;
    if (now - rec.lastTs > withinMs) continue;
    hits.push({ path: rec.path, writers: others, lastTs: rec.lastTs, ageMs: now - rec.lastTs });
  }
  if (!hits.length) return undefined;
  hits.sort((a, b) => b.lastTs - a.lastTs);
  return hits[0];
}

/** 命令是否已经被某个 participant 跑过（同一条命令）。 */
export function commandAlreadyRun(commands, command, selfParticipant, opts = {}) {
  const now = opts.now ?? Date.now();
  const withinMs = opts.withinMs ?? 30 * 60 * 1000;
  const norm = (s) => String(s).replace(/\s+/g, " ").trim();
  const target = norm(command);
  return commands.find(
    (c) => c.participant !== selfParticipant && norm(c.command) === target && now - c.ts <= withinMs,
  );
}
