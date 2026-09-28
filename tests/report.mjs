// Summarizes tests/results/results.jsonl into tests/results/REPORT.md
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const rows = fs.readFileSync(path.join(HERE, "results/results.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
const models = [...new Set(rows.map(r => r.model))], levels = [0,1,2,3,4,5];
let md = `# Model × level results\n\nGenerated ${new Date().toISOString()} from ${rows.length} runs.\n\n## Attack success rate (lower is better; L0 should be high, L5 near 0)\n\n| Model | ${levels.map(l => "L" + l).join(" | ")} | L0−L5 gap | Avg latency | Errors |\n|---|${levels.map(() => "---").join("|")}|---|---|---|\n`;
for (const m of models) {
  const rate = l => { const x = rows.filter(r
