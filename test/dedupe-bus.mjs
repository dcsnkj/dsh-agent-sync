// 清理总线里已落盘的重复事件（历史遗留：去重键曾包含 ts，导致双订阅重复落盘）。
//
// 用与 EventBus 完全相同的 eventKey 判断，保留每个键的**首次**出现，
// 重写 events.ndjson，并顺带重置 seq/cursor 相关的一致性。
//
// 用法：node test/dedupe-bus.mjs [--dry]

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { eventKey } from "../lib/bus.js";

const dry = process.argv.includes("--dry");
const baseDir = process.argv.find((a) => a.startsWith("--base="))?.slice(7) ?? join(homedir(), ".dsh", "agent-sync");
const file = join(baseDir, "events.ndjson");

if (!existsSync(file)) {
  console.log("没有 events.ndjson，跳过");
  process.exit(0);
}

const raw = readFileSync(file, "utf8");
const lines = raw.split("\n").filter((l) => l.trim());

const seen = new Set();
const kept = [];
let dropped = 0;
for (const line of lines) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    dropped += 1; // 损坏行也一并丢弃
    continue;
  }
  const key = eventKey(ev);
  if (seen.has(key)) {
    dropped += 1;
    continue;
  }
  seen.add(key);
  kept.push(ev);
}

// 重新编号 seq，保持单调
kept.forEach((ev, i) => {
  ev.seq = i + 1;
});

console.log(`原始 ${lines.length} 行 → 保留 ${kept.length} 行，丢弃 ${dropped} 行（重复/损坏）`);

const byParticipant = {};
for (const ev of kept) byParticipant[ev.participant] = (byParticipant[ev.participant] ?? 0) + 1;
console.log("按参与者:", JSON.stringify(byParticipant));

if (dry) {
  console.log("（--dry：未写盘）");
  process.exit(0);
}

copyFileSync(file, `${file}.bak-dedupe`);
writeFileSync(file, kept.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
console.log(`已重写 ${file}（备份 ${file}.bak-dedupe）`);
