// 校验 desktop profile 的 cordis.patch.yml 能否被 yaml 正确解析，
// 并确认 agent-sync 那条 insert 的结构符合 loader 期望。
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let yaml;
try {
  yaml = require("yaml");
} catch {
  yaml = await import("yaml");
}

const p = process.argv[2];
const raw = fs.readFileSync(p, "utf8");
const doc = yaml.parse(raw);
console.log("YAML OK; entries =", doc.length);
for (const [i, e] of doc.entries()) {
  const kind = e.insert ? `insert(${e.insert.length})` : `entry id=${e.id}`;
  console.log(`  [${i}] ${kind} ${e.insert ? e.insert.map((x) => x.name).join(", ") : e.name}`);
}
const last = doc[doc.length - 1];
console.log("last entry:", JSON.stringify(last, null, 1));
