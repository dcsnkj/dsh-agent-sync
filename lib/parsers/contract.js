// dsh-agent-sync — 外部 agent 来源（external source）适配器契约。
//
// 一个 source 负责三件事：发现会话文件、增量解析出新事件、把事件交给总线。
// 目前有两个源头，格式完全不同，所以各自一个模块：
//   codex.js     ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl      （Codex Desktop/CLI）
//   workbuddy.js ~/.workbuddy/projects/<project-slug>/<uuid>.jsonl （WorkBuddy，Claude-Code 方言）
//
// 实现者必须遵守：
//  1. 只产出 lib/contract.js 的 makeEvent() 信封，不要自造字段。
//  2. 增量：同一条源记录重复解析不得产生第二条事件（靠 sourceId/sourceOffset）。
//  3. 绝不把密钥/令牌写进 text 或 data（`.codex/auth*.json`、`config.toml` 里的 token 一律不读）。
//  4. execute() 不得抛异常穿透到调用方：单个损坏文件/半行 JSON 必须被静默跳过。

/**
 * @typedef {object} SourceAdapter
 * @property {string} participant                      'codex' | 'workbuddy'
 * @property {() => Promise<SessionSummary[]>} listSessions
 *   列出可发现的会话（按最近活动倒序）。用于“全量历史只拉摘要/索引”。
 * @property {() => Promise<SessionSummary|null>} findActive
 *   当前正在推进的活跃会话（最近被写入的那个），用于实时跟随。
 * @property {(session: SessionSummary, opts?: {sinceOffset?: number}) => Promise<{events: object[], offset: number}>} readSession
 *   解析一个会话文件；`offset` 是读完后的字节位置，用于下次增量。
 * @property {(session: SessionSummary, onEvents: (evs: object[]) => void, signal?: AbortSignal) => Promise<void>} follow
 *   实时跟随：会话文件增长时调用 onEvents（增量批次）。直到 signal abort 才返回。
 *   实现可轮询；建议间隔 1000-2000ms，避免空转。
 */

/**
 * @typedef {object} SessionSummary
 * @property {string} participant
 * @property {string} sessionId
 * @property {string} [title]
 * @property {string} [cwd]
 * @property {string} file                             源文件绝对路径
 * @property {number} mtime                            epoch ms
 * @property {number} bytes
 * @property {number} events                           该会话已解析出的事件数（摘要级）
 * @property {string[]} [filesTouched]                 关键操作：改过的文件
 * @property {string[]} [commands]                     关键操作：跑过的命令
 */

export const SOURCE_CONTRACT_VERSION = 1;
