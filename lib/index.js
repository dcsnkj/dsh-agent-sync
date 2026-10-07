// dsh-agent-sync — 跨 agent 聊天记录与操作同步插件（DSH 侧）。
//
// 它做四件事：
//   1. 采集：实时跟随 Codex / WorkBuddy 的会话记录（lib/parsers + lib/watch.js）
//   2. 双向：把 DSH 自己的关键操作写进共享总线，并物化成对方的收件箱（lib/selflog + lib/push）
//   3. 注入：把对方的新动作实时送进本会话上下文（lib/injector）
//   4. 可控：每个聊天独立切换同步模式 off/read/write/both（lib/tools: sync_mode）
//
// 安装（在 profile 的 cordis.patch.yml 里加一段，HMR 会热加载）：
//   - insert:
//       - id: agent-sync
//         name: '@local/dsh-agent-sync'
//         config:
//           participants: [codex, workbuddy]

import z from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { EventBus } from "./bus.js";
import { SessionSyncStore } from "./sessions.js";
import { createSelfLog } from "./selflog.js";
import { createInjector } from "./injector.js";
import { createPush } from "./push.js";
import { buildTools } from "./tools.js";

export const name = "agent-sync";

/** 本插件消费的 Host 服务。全部是 web profile 里的 host-plane 服务。 */
export const inject = ["tools", "systemPrompt"];

/** 空适配器：解析器模块不可用时，插件仍能加载（工具会报告采集器不可用）。 */
const NULL_ADAPTER = {
  participant: "none",
  async listSessions() {
    return [];
  },
  async findActive() {
    return null;
  },
  async readSession() {
    return { events: [], offset: 0 };
  },
  async follow() {},
};

export const Config = z.object({
  /** 同步根目录；空串 = ~/.dsh/agent-sync */
  baseDir: z.string().default(""),
  /** 参与同步的其它 agent。 */
  participants: z.array(z.string()).default(["codex", "workbuddy"]),
  /** 新会话的默认同步模式：off | read | write | both */
  defaultMode: z.string().default("both"),
  /** 采集轮询间隔（ms）。 */
  pollMs: z.number().default(1500),
  /** 注入时回看多久内的对方动作（ms）。 */
  recentWindowMs: z.number().default(60 * 60 * 1000),
  /** 收件箱刷新间隔（ms）。 */
  pushMs: z.number().default(5000),
  /** 是否启用采集（关掉后只保留显式工具能力）。 */
  watch: z.boolean().default(true),
});

export function apply(ctx, config) {
  const cfg = {
    baseDir: config.baseDir?.trim() ? config.baseDir : join(homedir(), ".dsh", "agent-sync"),
    participants: (config.participants ?? ["codex", "workbuddy"]).filter((p) => p !== "dsh"),
    defaultMode: config.defaultMode ?? "both",
    pollMs: config.pollMs ?? 1500,
    recentWindowMs: config.recentWindowMs ?? 60 * 60 * 1000,
    pushMs: config.pushMs ?? 5000,
    watch: config.watch !== false,
  };
  const log = (msg) => ctx.logger?.info?.(`[agent-sync] ${msg}`);

  // ── 落地自诊断 ────────────────────────────────────────────────────────────
  // 桌面端看不到 Host 的 console 输出，所以把关键阶段写进同步目录：
  // 启动即写 boot.json（证明 apply 被调用、走到哪一步），异常写 last-error.json。
  // 这是排查 fiberPhase:"failed" 的唯一可靠手段。
  const bootFile = join(cfg.baseDir, "boot.json");
  const errFile = join(cfg.baseDir, "last-error.json");
  const stage = { plugin: "dsh-agent-sync", stages: [], startedAt: new Date().toISOString() };
  const mark = (name, extra) => {
    stage.stages.push({ name, at: new Date().toISOString(), ...(extra ?? {}) });
    try {
      mkdirSync(cfg.baseDir, { recursive: true });
      writeFileSync(bootFile, JSON.stringify(stage, null, 2), "utf8");
    } catch {
      /* 尽力而为 */
    }
  };
  const recordError = (where, err) => {
    const rec = {
      plugin: "dsh-agent-sync",
      where,
      at: new Date().toISOString(),
      message: String(err?.message ?? err),
      stack: String(err?.stack ?? "").split("\n").slice(0, 14).join("\n"),
      stages: stage.stages,
      node: process.version,
      execPath: process.execPath,
    };
    try {
      mkdirSync(cfg.baseDir, { recursive: true });
      writeFileSync(errFile, JSON.stringify(rec, null, 2), "utf8");
    } catch {
      /* 尽力而为 */
    }
    log(`失败于 ${where}: ${rec.message}`);
  };

  try {
    try {
      rmSync(errFile, { force: true });
    } catch {
      /* 忽略 */
    }
    mark("apply-enter", { execPath: process.execPath, baseDir: cfg.baseDir });
    return applyInner(ctx, cfg, { log, mark, recordError });
  } catch (err) {
    recordError("apply-sync", err);
    throw err;
  }
}

function applyInner(ctx, cfg, { log, mark, recordError }) {
  const bus = new EventBus({
    busFile: join(cfg.baseDir, "events.ndjson"),
    cursorFile: join(cfg.baseDir, "cursors.json"),
    maxEventChars: 4000,
  });
  mark("bus-created");
  const store = new SessionSyncStore({
    file: join(cfg.baseDir, "state.json"),
    defaultMode: cfg.defaultMode,
    enabledParticipants: cfg.participants,
  });
  mark("store-created");

  /** 采集器诊断信息：工具里会展示，便于判断“为什么没有同步到”。 */
  const sourceStatus = {
    state: "initializing",
    adapters: [],
    watcher: null,
    error: null,
    startedAt: null,
    lastPushAt: null,
    pushedTotal: 0,
    /** participant -> 适配器；深读真实历史时要用 */
    adapterMap: new Map(),
    /** 自诊断（selflog 填） */
    selflog: null,
  };

  const selfLog = createSelfLog({ bus, store, log });
  sourceStatus.selflog = selfLog.diag;
  const injector = createInjector({ bus, store, log, recentWindowMs: cfg.recentWindowMs, selfLog });
  const pushes = cfg.participants.map((p) => createPush({ bus, store, dir: cfg.baseDir, participant: p, log }));

  // ── 同步注册（不依赖异步初始化，避免工具出现竞态）────────────────────────
  for (const tool of buildTools({
    bus,
    store,
    sourceStatus,
    adapters: sourceStatus.adapterMap,
    log,
    // sync_mode / bind 改了可见范围后，让注入层立刻丢弃旧缓存
    onModeChanged: (sid) => injector.invalidate(sid),
  })) {
    ctx.tools.register(tool);
  }
  mark("tools-registered", { count: 6 });

  // 总线写盘失败（例如磁盘满/文件被占用）必须留下痕迹。
  // EventBus 只 emit("error") 而无人监听时，Node 会把它当未处理错误抛出来。
  bus.on("error", (err) => {
    sourceStatus.state = sourceStatus.state === "running" ? "degraded" : sourceStatus.state;
    sourceStatus.error = `总线写入失败: ${err?.message ?? err}`;
    log(`总线写入失败: ${err?.message ?? err}`);
  });

  // 运行时上下文：模型每一步都能看到对方在干什么。
  ctx.systemPrompt.context({
    name: "agent-sync:peers",
    order: 118,
    text: (assembleContext) => injector.contextProvider(assembleContext),
  });

  // 固定说明段：告诉模型这套机制存在、以及纪律。
  ctx.systemPrompt.section({
    name: "agent-sync:policy",
    order: 112,
    text: [
      "跨 agent 同步（dsh-agent-sync）已启用：Codex 与 WorkBuddy 在同一工作目录里的对话与操作会实时同步到这里。",
      "用法纪律：",
      "1. 用户问某个外部聊天的实验细节 / 进度 / 参数改动时，先 agent_target(action=\"bind\") 绑定那个会话（用户说\"盯着那个对话\"时必做），",
      "   再用 agent_chat(deep=true) 取真实记录后回答；不要凭记忆或猜测。",
      "2. 用户说\"它太慢了，你接着干完\"时，用 agent_handoff 生成交接简报（目标/已改动文件/命令与失败/未完成点），据此继续执行。",
      "3. 想让接手或调研不打断主窗口时，把 agent_handoff 的 markdown 作为指令交给 subagent 去跑，主线继续。",
      "4. 动手改文件或跑实验命令前，先用 agent_write(action=\"check\") 确认别人是否刚做过，避免重复操作造成误差。",
      "5. 用户要改变同步行为时用 sync_mode（off/read/write/both）；要换目标会话时用 agent_target。",
      "",
      "工具契约（失败时读 errors/target.error，不要重试同样的错参数）：",
      "- 一切读取都受本会话同步模式与参与方白名单约束：mode=off 时读不到外部记录，",
      "  此时应向用户确认是否要 sync_mode 放开，而不是反复重试。",
      "- agent_chat 的 participants 只能收窄范围；点名白名单外的参与方会被拒绝。",
      "- agent_chat(deep) 的 fileTarget 必须是 `codex:<sessionId>` 形式；",
      "  格式错误会直接报错，绝不会静默改读别的会话——看到报错就修正格式。",
      "- agent_write 的 note/claim 必须给 summary；claim 还必须给 paths 或 command 之一，",
      "  否则不会写入总线（避免产生没有目标的空记录）。",
      "- agent_watch 返回的 unread 是\"自上次查看以来\"的条数，看过即已确认；",
      "  它持续增长说明对方真的在动，不是重复计数。",
      "- sync_mode(participants=[]) 表示不跟任何人同步；再次调用 sync_mode(mode) 会恢复默认名单。",
    ].join("\n"),
  });

  selfLog.attach(ctx);
  injector.attach(ctx);
  mark("handlers-attached");

  // ── 异步启动采集与推送 ────────────────────────────────────────────────────
  let watcher = null;
  let pushTimer = null;

  ctx.effect(() => {
    let cancelled = false;

    (async () => {
      try {
        mark("async-init-enter");
        await bus.load();
        await store.load();
        mark("bus-store-loaded", { busEvents: bus.all().length });
        // 载入解析器与 watcher（缺文件时降级，不影响插件整体可用）
        const [{ createCodexAdapter }, { createWorkBuddyAdapter }, { createWatcher }] = await Promise.all([
          import("./parsers/codex.js"),
          import("./parsers/workbuddy.js"),
          import("./watch.js"),
        ]);
        mark("parsers-imported");
        if (cancelled) return;

        const adapters = [];
        if (cfg.participants.includes("codex")) {
          const a = createCodexAdapter({ log });
          adapters.push(a);
          sourceStatus.adapterMap.set("codex", a);
        }
        if (cfg.participants.includes("workbuddy")) {
          const a = createWorkBuddyAdapter({ log });
          adapters.push(a);
          sourceStatus.adapterMap.set("workbuddy", a);
        }
        sourceStatus.adapters = adapters.map((a) => a.participant);

        watcher = createWatcher({ adapters, bus, pollMs: cfg.pollMs, log });
        if (cfg.watch && adapters.length) {
          await watcher.start();
          sourceStatus.state = "running";
        } else {
          sourceStatus.state = "disabled";
        }
        sourceStatus.startedAt = Date.now();

        // 生成供 Codex / WorkBuddy 读取我方操作的收件箱与 hook 脚本
        try {
          for (const p of pushes) await p.ensureHooks();
        } catch (err) {
          log(`生成 hooks 失败: ${err?.message ?? err}`);
        }

        const tick = async () => {
          try {
            let pushed = 0;
            for (const p of pushes) {
              const r = await p.pushOnce();
              pushed += r.pushed ?? 0;
            }
            if (pushed) {
              sourceStatus.pushedTotal += pushed;
              sourceStatus.lastPushAt = Date.now();
            }
            sourceStatus.watcher = watcher?.status?.() ?? null;
          } catch (err) {
            log(`推送失败: ${err?.message ?? err}`);
          }
        };
        await tick();
        pushTimer = setInterval(tick, cfg.pushMs);
        mark("ready", { adapters: sourceStatus.adapters, state: sourceStatus.state });
      } catch (err) {
        sourceStatus.state = "error";
        sourceStatus.error = String(err?.message ?? err);
        recordError("async-init", err);
        log(`启动采集失败: ${sourceStatus.error}`);
      }
    })();

    return () => {
      cancelled = true;
      if (pushTimer) clearInterval(pushTimer);
      try {
        watcher?.stop?.();
      } catch {
        /* 停就停干净 */
      }
    };
  });

  log(`已加载；同步目录 ${cfg.baseDir}，参与方 ${cfg.participants.join(", ")}`);
}
