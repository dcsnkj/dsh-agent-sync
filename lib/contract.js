// dsh-agent-sync — 跨 agent 同步的共享契约（contract）
//
// 这是 DSH / Codex / WorkBuddy 三方共同遵守的唯一协议层。
// 任何一方新增适配器，都必须产出这里定义的 envelope；任何读者都只依赖这里。
// 保持本文件零依赖，便于被解析器、总线、工具层、以及外部脚本共同 import。

/** 已知 participant（同步参与者）。新增 agent 只需在此登记。 */
export const PARTICIPANTS = /** @type {const} */ (["dsh", "codex", "workbuddy"]);

/** participant 的中文显示名，用于给模型/人看的文本。 */
export const PARTICIPANT_LABEL = {
  dsh: "DeepSeek Harness",
  codex: "Codex",
  workbuddy: "WorkBuddy",
};

/**
 * 同步模式（每个会话/每个 participant 独立可切换）：
 * - `off`    不同步：本聊天只留自己的记录，不读别人、也不被别人读。
 * - `read`   只读：能看到对方在做什么，但不把自己的操作推出去。
 * - `write`  只写：把自己的操作推出去，但不读对方的。
 * - `both`   双向：默认。既读又写，用于彼此避让、防重复操作。
 */
export const SYNC_MODES = /** @type {const} */ (["off", "read", "write", "both"]);

/** 模式下是否读取其它 participant 的事件。 */
export function modeReads(mode) {
  return mode === "read" || mode === "both";
}

/** 模式下是否把自己的事件推送给其它 participant。 */
export function modeWrites(mode) {
  return mode === "write" || mode === "both";
}

/** 事件类别。决定它进入哪条渲染通道，以及是否算“关键操作”。 */
export const KINDS = /** @type {const} */ ([
  "user", // 人发给某个 agent 的指令
  "assistant", // agent 的对话/结论
  "reasoning", // 思考摘要（通常只留节选）
  "file_read", // 读文件
  "file_write", // 改文件（关键操作）
  "command", // 执行命令 / 测试（关键操作）
  "tool", // 其它工具调用
  "plan", // 计划 / 待办
  "turn", // 轮次边界（turn_started / turn_finished）
  "meta", // 会话元信息 / 状态
]);

/** 关键操作：用于“防重复、防冲突”的核心类别（用户选定的粒度）。 */
export const KEY_KINDS = new Set(["user", "assistant", "file_write", "command", "plan", "turn"]);

/**
 * 构造一条规范化 envelope。
 * @param {object} init
 * @param {string} init.participant  'dsh' | 'codex' | 'workbuddy'
 * @param {string} [init.sessionId]  该 participant 内部的会话/线程 id
 * @param {string} [init.sessionTitle]
 * @param {string} [init.cwd]        该会话的工作目录（用于判断是否同一实验）
 * @param {string} init.kind          见 KINDS
 * @param {string} [init.role]        'user' | 'assistant' | 'tool' | 'system'
 * @param {string} [init.text]        人类可读正文（已按 budget 截断）
 * @param {object} [init.data]        结构化补充（文件路径、命令、退出码…）
 * @param {number} [init.ts]          epoch ms；缺省为 now
 * @param {string} [init.sourceFile]  来源文件绝对路径（用于增量与去重）
 * @param {number} [init.sourceOffset]来源文件内的字节偏移
 * @param {string} [init.sourceId]    来源内稳定 id（如 call_id / uuid）
 * @returns {object} envelope
 */
export function makeEvent(init) {
  const participant = init.participant;
  if (!PARTICIPANTS.includes(participant)) {
    throw new Error(`unknown participant: ${participant}`);
  }
  const kind = init.kind;
  if (!KINDS.includes(kind)) {
    throw new Error(`unknown kind: ${kind}`);
  }
  // ts 归一化为 epoch ms：解析器可能给出 ISO 字符串，总线的时间过滤必须拿到数字。
  let ts;
  if (typeof init.ts === "number" && Number.isFinite(init.ts)) ts = init.ts;
  else if (typeof init.ts === "string") {
    const parsed = Date.parse(init.ts);
    ts = Number.isFinite(parsed) ? parsed : Date.now();
  } else ts = Date.now();
  const sessionId = init.sessionId ?? "unknown";
  // 去重键：同一 (来源文件, 会话, 来源内 id) 只应存在一条。
  const id =
    init.sourceId != null
      ? `${participant}:${sessionId}:${init.sourceId}`
      : `${participant}:${sessionId}:${ts}:${kind}:${(init.text ?? "").slice(0, 48)}`;
  return {
    v: 1,
    id,
    participant,
    sessionId,
    sessionTitle: init.sessionTitle ?? undefined,
    cwd: init.cwd ?? undefined,
    kind,
    role: init.role ?? undefined,
    text: init.text ?? "",
    data: init.data ?? undefined,
    ts,
    sourceFile: init.sourceFile ?? undefined,
    sourceOffset: init.sourceOffset ?? undefined,
    sourceId: init.sourceId ?? undefined,
  };
}

/**
 * 从工具调用（name + 原始 arguments JSON）推断类别。
 * DSH 与 Codex 的工具命名不同，这里统一映射到 KINDS。
 * @param {string} name 工具名
 * @returns {string} kind
 */
export function classifyToolName(name) {
  const n = String(name || "").toLowerCase();
  if (/(^|[^a-z])(write|edit|apply_patch|create_file|notebook_edit)/.test(n)) return "file_write";
  if (/(read_file|read_text|view_image|read_image|\bread\b|get_file)/.test(n)) return "file_read";
  if (/(bash|shell|exec_command|pwsh|powershell|run_command|cmd\b|terminal)/.test(n)) return "command";
  if (/(todo|plan|update_plan)/.test(n)) return "plan";
  return "tool";
}

/**
 * 从一条工具调用里抽出“关键操作”所需的结构化信息：
 * 改动的文件路径、执行的命令、退出码等。三方字段各异，这里做宽容抽取。
 * @param {string} name
 * @param {unknown} args 已解析的参数对象，或未解析的 JSON 字符串
 * @returns {object|undefined}
 */
export function extractCallData(name, args) {
  let a = args;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      return { raw: a.slice(0, 400) };
    }
  }
  if (!a || typeof a !== "object") return undefined;
  const out = {};
  const paths = [];
  for (const k of ["file_path", "path", "filePath", "target_file", "filename", "abs_path"]) {
    if (typeof a[k] === "string") paths.push(a[k]);
  }
  if (Array.isArray(a.paths)) paths.push(...a.paths.filter((p) => typeof p === "string"));
  if (paths.length) out.paths = [...new Set(paths)];
  for (const k of ["command", "cmd", "script", "shell_command"]) {
    if (typeof a[k] === "string") {
      out.command = a[k];
      break;
    }
  }
  if (typeof a.workdir === "string") out.workdir = a.workdir;
  if (typeof a.cwd === "string") out.cwd = a.cwd;
  if (typeof a.content === "string" && a.content.length) out.contentBytes = a.content.length;
  if (out.paths?.length && out.contentBytes) out.wrotePaths = out.paths;
  // apply_patch 的补丁正文里包含被改文件；粗抽出 "*** Update File: xxx"
  if (typeof a.input === "string") {
    const m = [...a.input.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((x) => x[1].trim());
    if (m.length) {
      out.paths = [...new Set([...(out.paths ?? []), ...m])];
      out.wrotePaths = out.paths;
      out.patchBytes = a.input.length;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * 从工具结果里抽退出码 / 是否失败。
 * @param {unknown} result
 * @returns {{exitCode?: number, isError?: boolean, summary?: string}}
 */
export function extractResultData(result) {
  const out = {};
  if (result == null) return out;
  const text = typeof result === "string" ? result : JSON.stringify(result);
  // 两种形态都要认：
  //  1) 结构化 JSON：{"exit_code":0,...}（codex 的 custom_tool_call_output 多为此形态）
  //  2) 纯文本：    "Process exited with code 0"（function_call_output 的 string 形态）
  // 实测 223 条 call_output 里绝大多数是第2 种，只认第 1 种会让退出码大面积缺失，
  // 表现为交接简报里"命令 148 条，成功 0，失败 0"。
  const json = /"exit_code"\s*:\s*(-?\d+)/.exec(text);
  if (json) {
    out.exitCode = Number(json[1]);
  } else {
    // 覆盖 "exited with code N" / "exit code: N" / "exit status N" / "code=N"
    const human = /\b(?:exited with code|exit code|exit status|exit)\b[^0-9-]{0,12}(-?\d+)/i.exec(text);
    if (human) out.exitCode = Number(human[1]);
  }
  if (/"is_error"\s*:\s*true/.test(text) || /\b(?:Error|Exit code):\s*-?\d/.test(text)) {
    out.isError = true;
  }
  // 退出码非0 即视为失败——这是最可靠的信号，优先于任何文本启发式。
  if (out.exitCode != null && out.exitCode !== 0) out.isError = true;
  out.summary = text.slice(0, 300);
  return out;
}

/** 稳定的路径比较键：Windows 大小写不敏感 + 分隔符统一。 */
export function pathKey(p) {
  return String(p || "")
    .replace(/^\\\\\?\\/, "")
    .replace(/[\\/]+/g, "/")
    .toLowerCase();
}
