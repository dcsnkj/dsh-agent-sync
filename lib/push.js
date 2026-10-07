// dsh-agent-sync — 反向推送（总线 → 外部 agent 可读的收件箱）。
//
// 我们无法直接改 Codex / WorkBuddy 的 prompt 组装，所以采用“共享收件箱”方案：
// DSH 把自己的关键动作物化成 markdown 收件箱文件，外部 agent 通过
//   (a) 在对话里让 Codex/WorkBuddy 读这个文件，或
//   (b) 它们自己的 hook（Codex 的 hooks.json / WorkBuddy 的 settings）调用我们生成的脚本
// 把内容带进它们的上下文。收件箱是幂等的、可裁剪的，并且带未读游标。

import { mkdir, readFile, writeFile, rename, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { PARTICIPANT_LABEL } from "./contract.js";

const oneLine = (s, n = 220) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 一行渲染，和 injector 保持同一风格，便于双方对照。 */
function renderLine(ev) {
  const who = PARTICIPANT_LABEL[ev.participant] ?? ev.participant;
  const t = new Date(ev.ts).toLocaleString("zh-CN", { hour12: false });
  const d = ev.data ?? {};
  switch (ev.kind) {
    case "file_write":
      return `- ${t} **改文件** ${(d.wrotePaths ?? d.paths ?? []).join(", ") || "?"}`;
    case "command":
      return `- ${t} **命令** \`${oneLine(d.command, 180)}\`${d.exitCode != null ? ` → exit ${d.exitCode}` : ""}`;
    case "assistant":
      return `- ${t} **结论** ${oneLine(ev.text, 500)}`;
    case "user":
      return `- ${t} **用户指令** ${oneLine(ev.text, 400)}`;
    case "plan":
      return `- ${t} **计划** ${oneLine(ev.text, 300)}`;
    case "turn":
      return `- ${t} ${oneLine(ev.text, 120)}`;
    default:
      return `- ${t} ${ev.kind} ${oneLine(ev.text, 220)}`;
  }
}

export function createPush({ bus, store, dir, participant = "codex", log = () => {} }) {
  const inboxFile = join(dir, "inbox", `${participant}.md`);
  const hooksDir = join(dir, "hooks");
  let lastPushedSeq = 0;
  /**
   * 上次推送时"哪些会话以什么权限可见"的指纹。
   * 只靠 seq 增量是不够的：会话把模式从 off 改成 both 后，它此前写出、
   * 但当时因权限不足而被过滤掉的事件，seq 早于 lastPushedSeq，
   * 永远不会出现在 fresh 里 —— 收件箱就会停在旧内容上，直到对方恰好
   * 产生一条新事件才被顺带刷新。把权限指纹纳入判断即可覆盖这种变化。
   */
  let lastFilterSig = "";

  /**
   * 生成/更新收件箱。只推“DSH 写出的、且该 participant 在写名单里的”事件。
   */
  async function pushOnce({ windowMs = 24 * 3600 * 1000, maxLines = 80 } = {}) {
    const now = Date.now();
    const candidates = bus.query({ participants: ["dsh"], since: now - windowMs, limit: 4000, tail: true });
    // 只保留那些“本会话允许写给该 participant”的事件
    const events = candidates.filter((ev) => store.settingsFor(ev.sessionId).writeParticipants.includes(participant));
    const filterSig = candidates
      .map((ev) => `${ev.sessionId}:${store.settingsFor(ev.sessionId).writeParticipants.join("+")}`)
      .sort()
      .join("|");
    const fresh = events.filter((ev) => ev.seq > lastPushedSeq);
    const permChanged = filterSig !== lastFilterSig;
    // 首次推送（lastPushedSeq===0）或有权限变化时都要重写文件
    if (!fresh.length && lastPushedSeq !== 0 && !permChanged) return { pushed: 0, file: inboxFile };

    const body = [
      `# 来自 DeepSeek Harness 的同步收件箱`,
      ``,
      `> 这是 DSH 在**共享工作目录**里的真实操作记录，供 ${PARTICIPANT_LABEL[participant] ?? participant} 避让与协作。`,
      `> 目的：避免重复执行同一件事造成误差。动手前扫一眼，尤其是改文件与跑命令。`,
      ``,
      `更新时间：${new Date(now).toLocaleString("zh-CN", { hour12: false })}`,
      `未读新增：${fresh.length} 条`,
      ``,
      `## 最近动作`,
      ``,
      ...events.slice(-maxLines).map(renderLine),
      ``,
      events.length ? `` : `（当前没有可共享的操作记录；DSH 侧的会话可能处于 off 模式。）\n`,
      `## 怎么用`,
      ``,
      `在需要时把本文件内容纳入上下文即可；也可以用 hooks 自动带上（见同目录 hooks/README.md）。`,
      ``,
    ].join("\n");

    await mkdir(join(dir, "inbox"), { recursive: true });
    const tmp = `${inboxFile}.tmp`;
    await writeFile(tmp, body, "utf8");
    await rename(tmp, inboxFile);
    // 只能推进到"本 participant 实际可见的事件"的最大 seq。
    // 用 bus.head()（全局最大 seq）会把别的 participant 的事件也算进来，
    // 下一轮真正的 dsh 新事件若 seq 较小就会被误判为已推送而丢失。
    lastPushedSeq = events.length ? Math.max(...events.map((e) => e.seq)) : lastPushedSeq;
    lastFilterSig = filterSig;
    return { pushed: fresh.length, file: inboxFile };
  }

  /** 生成供外部 agent hooks 调用的脚本（只生成一次，可重复调用覆盖）。 */
  async function ensureHooks() {
    await mkdir(hooksDir, { recursive: true });
    const ps1 = join(hooksDir, "read-inbox.ps1");
    await writeFile(
      ps1,
      [
        `# dsh-agent-sync — 把 DSH 同步收件箱打印到 stdout，供 Codex/WorkBuddy hook 带入上下文。`,
        `param([string]$Participant = "${participant}")`,
        `$root = Join-Path $env:USERPROFILE ".dsh\\agent-sync"`,
        `$f = Join-Path $root "inbox\\$Participant.md"`,
        `if (Test-Path $f) {`,
        `  $age = (Get-Date) - (Get-Item $f).LastWriteTime`,
        `  if ($age.TotalHours -lt 24) { Get-Content $f -Raw }`,
        `}`,
        ``,
      ].join("\n"),
      "utf8",
    );
    const sh = join(hooksDir, "read-inbox.sh");
    await writeFile(
      sh,
      [
        `#!/usr/bin/env bash`,
        `# dsh-agent-sync — 打印 DSH 同步收件箱（POSIX 版，供 bash hook 使用）。`,
        `set -euo pipefail`,
        `P="\${1:-${participant}}"`,
        `F="$HOME/.dsh/agent-sync/inbox/$P.md"`,
        `[ -f "$F" ] && cat "$F" || true`,
        ``,
      ].join("\n"),
      "utf8",
    );
    const readme = join(hooksDir, "README.md");
    await writeFile(
      readme,
      [
        `# 让 Codex / WorkBuddy 自动带上 DSH 的操作记录`,
        ``,
        `DSH 会把它的关键操作写进 \`~/.dsh/agent-sync/inbox/<agent>.md\`。`,
        `两种接入方式，任选：`,
        ``,
        `## 方式一：对话里直接读（零配置，立刻可用）`,
        ``,
        `在 Codex / WorkBuddy 里说：`,
        ``,
        `> 读 ~/.dsh/agent-sync/inbox/codex.md，看 DeepSeek Harness 最近做了什么，然后继续我的实验。`,
        ``,
        `## 方式二：hook 自动带上（需要改它们各自的 hooks 配置）`,
        ``,
        `Codex：在 \`~/.codex/hooks.json\` 的某个事件（如 Stop）里加一条 command：`,
        ``,
        '```json',
        `{ "hooks": { "Stop": [ { "hooks": [ { "type": "command",`,
        `  "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \\"%USERPROFILE%\\\\.dsh\\\\agent-sync\\\\hooks\\\\read-inbox.ps1\\" -Participant codex" } ] } ] } }`,
        '```',
        ``,
        `WorkBuddy：同样在它的 hooks 配置里指向 \`read-inbox.ps1 -Participant workbuddy\`。`,
        ``,
        `注意：hook 会在它们每次事件触发时执行，读到的内容是否进入模型上下文取决于对方实现；`,
        `如果不确定，用方式一最稳。`,
        ``,
      ].join("\n"),
      "utf8",
    );
    return { hooksDir };
  }

  return { pushOnce, ensureHooks, inboxFile, hooksDir };
}
