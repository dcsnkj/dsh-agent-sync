// dsh-agent-sync — 通用增量跟随（watcher）
//
// 职责：把若干 SourceAdapter（Codex / WorkBuddy…）的会话文件变化，增量地变成总线事件。
// 三条硬要求：
//   1. 只做增量：每个 (文件 → 已读字节偏移) 记在 offsets 里，绝不每轮全量重读大文件；
//   2. 历史只做索引：listSessions() 仅用于发现会话与拿摘要，不把全量历史正文推进总线；
//      只有「活跃会话」与「本次启动后新出现的会话」会被 readSession 读入（默认只回放尾部
//      initialTailBytes，可用 replayFull: true 改成整段回放）；
//   3. 干净停止：stop() 幂等，清掉 setInterval、abort 所有 follow、不留悬挂 timer；
//      offsets 在 stop() 后保留，因此 stop() → start() 不会重复投递同一段内容
//      （跨进程重启的重复由 EventBus 按 participant+sessionId+sourceId+ts+kind 去重兜底）。
//
// Windows 上 fs.watch 的递归监听不可靠，所以这里只用 setInterval 轮询 + 适配器自带的 follow()。

const DEFAULT_POLL_MS = 1500;
const DEFAULT_INDEX_EVERY_MS = 5000;
const DEFAULT_INITIAL_TAIL_BYTES = 512 * 1024;

/**
 * @param {object} opts
 * @param {import('./parsers/contract.js').SourceAdapter[]} opts.adapters
 * @param {{append: (evs: object|object[]) => number}} opts.bus
 * @param {number} [opts.pollMs]                 轮询间隔，默认 1500ms
 * @param {(level: string, msg: string, extra?: object) => void} [opts.log]
 * @param {AbortSignal} [opts.signal]            abort 时自动 stop()
 * @param {number} [opts.indexEveryMs]           全量索引（listSessions）节流，默认 5000ms
 * @param {number} [opts.initialTailBytes]       首次读入活跃/新会话时只回放尾部多少字节
 * @param {boolean} [opts.replayFull]            true = 首次就把整段会话读进总线（默认 false）
 * @param {Record<string, number>} [opts.offsets] 初始 offset 账本（可跨进程持久化后传回）
 */
export function createWatcher(opts = {}) {
  const adapters = Array.isArray(opts.adapters) ? opts.adapters.filter(Boolean) : [];
  const bus = opts.bus ?? null;
  const pollMs = Number.isFinite(opts.pollMs) ? Math.max(100, opts.pollMs) : DEFAULT_POLL_MS;
  const indexEveryMs = Number.isFinite(opts.indexEveryMs) ? Math.max(0, opts.indexEveryMs) : DEFAULT_INDEX_EVERY_MS;
  const initialTailBytes = Number.isFinite(opts.initialTailBytes) ? Math.max(0, opts.initialTailBytes) : DEFAULT_INITIAL_TAIL_BYTES;
  const replayFull = !!opts.replayFull;
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const externalSignal = opts.signal ?? null;

  /** @type {Map<string, number>} 文件绝对路径 → 已消费到的字节偏移 */
  const offsets = new Map();
  if (opts.offsets instanceof Map) {
    for (const [k, v] of opts.offsets) if (Number.isFinite(Number(v))) offsets.set(k, Number(v));
  }
  for (const [k, v] of Object.entries(opts.offsets ?? {})) {
    if (Number.isFinite(Number(v))) offsets.set(k, Number(v));
  }
  /** @type {Map<string, object>} 文件 → 最近一次拿到的 SessionSummary */
  const known = new Map();
  /** @type {Map<string, {file: string, controller: AbortController, promise: Promise<void>}>} participant → follow 句柄 */
  const followed = new Map();

  let activeSources = [];
  let lastPollAt = 0;
  let lastIndexAt = 0;
  let startedAtMs = 0;
  let started = false;
  let timer = null;
  let runController = null;
  let onExternalAbort = null;
  let chain = Promise.resolve();
  const stats = { polls: 0, indexes: 0, appended: 0, adaptersFailed: 0 };

  function warn(msg, extra) {
    try {
      log("warn", `[watch] ${msg}`, extra);
    } catch {
      /* log 不能反过来炸掉 watcher */
    }
  }

  /** 串行化所有读文件/投递动作，避免 interval 与 follow 同时改 offsets。 */
  function queue(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** 投递事件；bus.append 已内置去重，这里不再自己维护去重表。 */
  function appendEvents(evs) {
    if (!evs || !evs.length || !bus) return 0;
    try {
      const n = bus.append(evs);
      if (n && typeof n.then === "function") {
        n.then(
          (m) => {
            stats.appended += Number(m) || 0;
          },
          (err) => warn(`bus.append rejected: ${err?.message ?? err}`),
        );
        return 0;
      }
      stats.appended += Number(n) || 0;
      return Number(n) || 0;
    } catch (err) {
      warn(`bus.append failed: ${err?.message ?? err}`);
      return 0;
    }
  }

  /** 决定一个首次见到的文件从哪里开始读：历史只跳过、新会话/活跃会话回放尾部。 */
  function baselineOffset(session, active) {
    const from = offsets.get(session.file);
    if (Number.isFinite(from)) return from;
    const isActive = active && active.file === session.file;
    const isLegacy = !isActive && session.mtime < startedAtMs - 1000;
    if (isLegacy && !replayFull) return session.bytes; // 启动前就存在的历史会话：只索引，不灌总线
    if (replayFull || session.bytes <= initialTailBytes) return 0;
    return session.bytes - initialTailBytes; // 只回放尾部，避免把整段历史推进总线
  }

  function isFollowed(participant, file) {
    return followed.get(participant)?.file === file;
  }

  /** 把一个文件从 from 开始的增量读出来并投递。 */
  async function readInto(adapter, session, from) {
    let res;
    try {
      res = await adapter.readSession(session, { sinceOffset: from });
    } catch (err) {
      warn(`${adapter.participant} readSession ${session.file} failed: ${err?.message ?? err}`);
      return 0;
    }
    if (!res) return 0;
    if (Number.isFinite(res.offset)) offsets.set(session.file, res.offset);
    if (Number.isFinite(res.bytes)) session.bytes = res.bytes;
    if (Number.isFinite(res.mtime)) session.mtime = res.mtime;
    return appendEvents(res.events ?? []);
  }

  /** 给当前活跃会话挂上 follow（活跃会话变化时切过去）。 */
  function maybeFollow(adapter, participant, active) {
    const current = followed.get(participant);
    if (!active) {
      if (current) {
        current.controller.abort();
        followed.delete(participant);
      }
      return;
    }
    if (current && current.file === active.file) return;
    if (current) {
      current.controller.abort();
      followed.delete(participant);
    }
    if (typeof adapter.follow !== "function" || !runController || runController.signal.aborted) return;
    const controller = new AbortController();
    const file = active.file;
    const from = offsets.get(file) ?? 0;
    const promise = (async () => {
      try {
        await adapter.follow(
          active,
          (evs) => {
            appendEvents(evs);
          },
          controller.signal,
          {
            sinceOffset: from,
            pollMs,
            onOffset: (off) => {
              if (Number.isFinite(off)) offsets.set(file, off);
            },
          },
        );
      } catch (err) {
        if (!controller.signal.aborted) warn(`${participant} follow ${file} failed: ${err?.message ?? err}`);
      } finally {
        if (followed.get(participant)?.controller === controller) followed.delete(participant);
      }
    })();
    followed.set(participant, { file, controller, promise });
  }

  /**
   * 一轮同步：发现会话 → 增量读 → 维护 follow。
   * @param {boolean} force true = 全量索引，并且「所有 adapter 都失败」时抛错
   */
  async function reconcile(force = false) {
    if (!started) return;
    lastPollAt = Date.now();
    stats.polls += 1;
    const now = Date.now();
    const doIndex = force || now - lastIndexAt >= indexEveryMs;
    const nextActive = [];
    const failures = [];

    for (const adapter of adapters) {
      const participant = adapter?.participant ?? "unknown";
      let sessions = null;
      if (doIndex) {
        try {
          sessions = (await adapter.listSessions()) ?? [];
        } catch (err) {
          failures.push(err);
          stats.adaptersFailed += 1;
          warn(`${participant} listSessions failed: ${err?.message ?? err}`);
        }
      }
      let active = null;
      try {
        active = await adapter.findActive();
      } catch (err) {
        warn(`${participant} findActive failed: ${err?.message ?? err}`);
      }
      if (active) {
        known.set(active.file, active);
        nextActive.push({
          participant,
          sessionId: active.sessionId,
          title: active.title,
          cwd: active.cwd,
          file: active.file,
          bytes: active.bytes,
          mtime: active.mtime,
        });
      }

      const candidates = new Map();
      if (sessions) {
        for (const s of sessions) {
          known.set(s.file, s);
          candidates.set(s.file, s);
        }
      } else {
        // 非索引轮：只跟踪已知会话 + 当前活跃会话，避免每轮全量 listSessions
        for (const s of known.values()) if (s.participant === participant) candidates.set(s.file, s);
        if (active) candidates.set(active.file, active);
      }

      for (const s of candidates.values()) {
        if (!offsets.has(s.file)) offsets.set(s.file, baselineOffset(s, active));
      }
      for (const s of candidates.values()) {
        if (isFollowed(participant, s.file)) continue; // follow 独占这个文件
        const from = offsets.get(s.file) ?? 0;
        if (!(s.bytes > from)) continue;
        await readInto(adapter, s, from);
      }

      maybeFollow(adapter, participant, active);
    }

    activeSources = nextActive;
    if (doIndex) {
      lastIndexAt = now;
      stats.indexes += 1;
    }
    if (force && adapters.length && failures.length === adapters.length && known.size === 0) {
      throw failures[0]; // 一个来源都没起来：交给调用方降级
    }
  }

  /** 启动：首次全量索引 + 增量读 + 挂 follow，然后开轮询兜底。 */
  async function start() {
    if (started) return status();
    if (!bus || typeof bus.append !== "function") {
      throw new TypeError("createWatcher: opts.bus 必须提供 append() 方法");
    }
    startedAtMs = Date.now();
    runController = new AbortController();
    started = true;
    try {
      await queue(() => reconcile(true));
    } catch (err) {
      started = false;
      runController.abort();
      runController = null;
      throw err; // 首次索引彻底失败：调用方可以 catch 后降级
    }
    if (externalSignal) {
      onExternalAbort = () => {
        void stop();
      };
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    if (!timer) {
      timer = setInterval(() => {
        void queue(() => reconcile(false));
      }, pollMs);
      if (typeof timer.unref === "function") timer.unref(); // 不要因为跟随器而拖住进程退出
    }
    return status();
  }

  /** 停止：幂等、可重复调用；offsets 保留，便于不留重复地再次 start()。 */
  async function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    const wasStarted = started;
    started = false;
    if (externalSignal && onExternalAbort) {
      try {
        externalSignal.removeEventListener("abort", onExternalAbort);
      } catch {
        /* ignore */
      }
      onExternalAbort = null;
    }
    const pending = [...followed.values()].map((f) => f.promise);
    for (const f of followed.values()) f.controller.abort();
    followed.clear();
    if (runController) runController.abort();
    await Promise.allSettled(pending);
    await chain; // 等在队列里的这一轮 reconcile 收尾
    runController = null;
    if (wasStarted) log("info", "[watch] stopped", { offsets: offsets.size });
    return status();
  }

  /** 运行状态：{ activeSources, lastPollAt, offsets }（另附少量便于排障的字段）。 */
  function status() {
    return {
      activeSources: activeSources.map((s) => ({ ...s })),
      lastPollAt,
      offsets: Object.fromEntries([...offsets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))),
      started,
      startedAt: startedAtMs,
      followed: [...followed.entries()].map(([participant, f]) => ({ participant, file: f.file })),
      stats: { ...stats },
      adapters: adapters.map((a) => a?.participant ?? "unknown"),
      pollMs,
    };
  }

  return { start, stop, status, offsets };
}

export default createWatcher;
