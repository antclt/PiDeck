import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const [asarPath] = process.argv.slice(2);
const list = asar.listPackage(asarPath).join("\n");
const pkgs = ["cordis-plugin-group","dsh-anonymous-user-id","dsh-atomic-write","dsh-bash-local","dsh-code-runtime","dsh-compaction","dsh-fs","dsh-invariants","dsh-output-retention","dsh-sandbox","dsh-scope","dsh-session-telemetry","dsh-session-title-llm","dsh-shell","dsh-spill","dsh-subagent-in-process-driver","dsh-subprocess","dsh-timeout","dsh-workflow"];
const sep = String.fromCharCode(92);
let missing = 0;
for (const p of pkgs) {
  const ok = list.includes("@deepseek-ai" + sep + p + sep) || list.includes("@deepseek-ai/" + p + "/");
  console.log(p.padEnd(32), ok ? "OK" : "MISSING");
  if (!ok) missing++;
}
console.log(missing === 0 ? "OK all 19 present" : "MISSING " + missing);
