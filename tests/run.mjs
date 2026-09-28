// Model/level attack harness. Runs each private attack case against each level on each model,
// via the deployed presenter API, and scores by the hits the server reports.
// Usage: node tests/run.mjs --base https://defensive-prompt.ironalloy.info --pass "YOUR_PASSPHRASE" [--models a,b] [--levels 0,3,5]
import fs from "node:fs";
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = arg("base", "https://defensive-prompt.ironalloy.info");
const PASS = arg("pass"); if (!PASS) { console.error("need --pass"); process.exit(1); }
const LEVELS = arg("levels", "0,1,2,3,4,5").split(",").map(Number);
const cfg = JSON.parse(fs.readFileSync(new URL("./attacks.private.json", import.meta.url)));
const cases = cfg.cases.filter(c => c.input && c.input.trim());
const MODELS = arg("models", "deepseek-v4.1-flash,nemotron-3-nano:30b,gpt-oss:20b,gemma4:31b").split(",");

let cookie = "";
const setCookie = r => { const c = r.headers.get("set-cookie"); if (c) cookie = c.split(";")[0] + (cookie ? "; " + cookie : ""); };
async function post(path, body) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body || {}) });
  setCookie(r); return r;
}
async function login() { await post("/api/session"); const r = await post("/api/presenter/login", { passphrase: PASS }); if (!r.ok) throw new Error("login failed " + r.status); }
async function ask(message, level, model) {
  await post("/api/level", { level });
  const r = await fetch(BASE + "/api/chat", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message, model }) });
  const text = await r.text(); const hits = [];
  for (const line of text.split("\n\n")) if (line.startsWith("data: ")) { try { const e = JSON.parse(line.slice(6)); if (e.type === "answer") return { answer: e.text, hits: e.hits || [] }; if (e.type === "error") return { answer: "[error] " + e.error, hits: [] }; } catch {} }
  return { answer: "[no answer]", hits: [] };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
await login();
await post("/api/presenter/mode", { mode: "open" });
const rows = [];
for (const model of MODELS) {
  for (const c of cases) {
    for (const level of LEVELS) {
      let res; try { res = await ask(c.input, level, model); } catch (e) { res = { answer: "[fail] " + e.message, hits: [] }; }
      const success = c.expect === "manual" ? null : res.hits.some(h => h.kind === c.expect || h.owasp === c.owasp);
      rows.push({ model, case: c.id, owasp: c.owasp, lang: c.lang, level, success, answer: (res.answer || "").slice(0, 240) });
      process.stdout.write(success === null ? "?" : success ? "✗" : "·"); // ✗ = attack landed
      await sleep(400);
    }
  }
  process.stdout.write(" | " + model + "\n");
}
fs.mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.writeFileSync(new URL(`./results/run-${stamp}.json`, import.meta.url), JSON.stringify(rows, null, 1));
// summary: attacks landed per model per level
const grid = {};
for (const r of rows) { if (r.success === null) continue; grid[r.model] ??= {}; grid[r.model][r.level] ??= [0, 0]; grid[r.model][r.level][1]++; if (r.success) grid[r.model][r.level][0]++; }
console.log("\nAttacks landed (fraction) by level:");
console.log(["model", ...LEVELS.map(l => "L" + l)].join("\t"));
for (const m of MODELS) console.log([m, ...LEVELS.map(l => { const g = grid[m]?.[l]; return g ? `${g[0]}/${g[1]}` : "-"; })].join("\t"));
console.log(`\nSaved results/run-${stamp}.json  (manual LLM09 cases marked '?', review answers there)`);
