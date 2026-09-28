import { Control } from "./control.js";
import { LEVELS, getLevel, clampLevel } from "./levels.js";
import { buildSystemPrompt, wrapData } from "./prompts.js";
import { TOOL_DEFS, runTool } from "./tools.js";
import { detect, sanitize, redactSecrets } from "./output.js";
export { Control };

const enc = new TextEncoder();
const CANARIES_URL = "canaries"; // loaded from D1-independent constant below at first use

// ---- helpers ----------------------------------------------------------------
const json = (o, init = {}) => {
  const h = new Headers(init.headers || {});
  h.set("content-type", "application/json");
  return new Response(JSON.stringify(o), { headers: h, status: init.status || 200 });
};
function cookies(req) { const h = req.headers.get("cookie") || ""; return Object.fromEntries(h.split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; })); }
function rid(n = 18) { const b = new Uint8Array(n); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, "0")).join(""); }

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function presenterCookie(env) { const ts = String(Date.now()); return `${ts}.${await hmac(env.PRESENTER_PASSPHRASE, ts)}`; }
async function isPresenter(req, env) {
  const c = cookies(req).vr_presenter; if (!c) return false;
  const [ts, sig] = c.split("."); if (!ts || !sig) return false;
  return sig === await hmac(env.PRESENTER_PASSPHRASE, ts);
}

const ctrl = (env) => env.CONTROL.get(env.CONTROL.idFromName("main"));

// Canaries are generated into the data bundle; embed a copy here at deploy via seed step.
// For runtime we read them from the kb-independent table if present, else from bundled constant.
let CANARIES = null;
async function getCanaries(env) {
  if (CANARIES) return CANARIES;
  // stored as a single-row settings entry during seeding is optional; fall back to env JSON
  try { CANARIES = JSON.parse(env.CANARIES_JSON); } catch { CANARIES = {}; }
  return CANARIES;
}

async function getSession(req, env) {
  const sid = cookies(req).vr_sid;
  if (sid) { const s = await env.DB.prepare("SELECT * FROM sessions WHERE sid=?").bind(sid).first(); if (s) return s; }
  return null;
}
async function ensureSession(req, env, headers) {
  let s = await getSession(req, env);
  if (!s) {
    const sid = rid();
    await env.DB.prepare("INSERT INTO sessions (sid,created,level) VALUES (?,?,0)").bind(sid, Date.now()).run();
    s = { sid, created: Date.now(), level: 0, verified_customer_id: null, is_presenter: 0, msg_count: 0 };
    headers.append("set-cookie", `vr_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  }
  return s;
}

// dataset for PII detection (emails/phones) — loaded once from D1
let DATASET = null;
async function getDataset(env) {
  if (DATASET) return DATASET;
  const { results } = await env.DB.prepare("SELECT email, phone FROM customers").all();
  DATASET = { emails: results.map(r => r.email).filter(Boolean), phones: results.map(r => r.phone).filter(Boolean) };
  return DATASET;
}

async function logEvent(env, session, kind, owasp, detail) {
  await env.DB.prepare("INSERT INTO events (ts,sid,level,kind,owasp,detail) VALUES (?,?,?,?,?,?)")
    .bind(Date.now(), session.sid, session.level, kind, owasp || "", String(detail || "").slice(0, 300)).run();
  try { await ctrl(env).fetch("https://do/event", { method: "POST", body: JSON.stringify({ type: "event", ts: Date.now(), level: session.level, kind, owasp, detail: String(detail || "").slice(0, 120) }) }); } catch {}
}

// ---- Ollama tool loop -------------------------------------------------------
async function chatOnce(env, model, messages, tools) {
  const r = await fetch("https://ollama.com/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OLLAMA_API_KEY}` },
    body: JSON.stringify({ model, messages, tools, stream: false, options: { temperature: 0.4, num_predict: parseInt(env.MAX_OUTPUT_TOKENS) } }),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).message;
}

async function runAgent(env, session, levelCfg, canaries, userText, emit, model) {
  const flags = levelCfg.flags;
  const sys = buildSystemPrompt(levelCfg, canaries);
  const messages = [{ role: "system", content: sys }, { role: "user", content: userText }];
  const maxSteps = parseInt(env.MAX_TOOL_STEPS);
  let final = "";
  for (let step = 0; step < maxSteps; step++) {
    const msg = await chatOnce(env, model || env.DEFAULT_MODEL, messages, TOOL_DEFS);
    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name;
        let args = tc.function?.arguments; if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
        const result = await runTool(name, args || {}, { DB: env.DB, flags, session });
        await logEvent(env, session, "tool_call", "", `${name}(${JSON.stringify(args).slice(0,80)})`);
        messages.push({ role: "tool", content: wrapData(result, flags) });
      }
      continue;
    }
    final = msg.content || "";
    break;
  }
  if (!final) final = "Sorry, I couldn't complete that request.";
  // detection always runs (scoreboard)
  const dataset = await getDataset(env);
  const hits = detect(final, { canaries, dataset });
  for (const h of hits) await logEvent(env, session, h.kind, h.owasp, h.detail);
  // defenses (L4+)
  let out = final;
  const san = sanitize(out, flags); out = san.text;
  out = redactSecrets(out, canaries, flags);
  await emit(out, hits);
  return out;
}

// ---- router -----------------------------------------------------------------
export default {
  async fetch(req, env, _ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    const H = new Headers();

    // leak logger — same-origin "attacker" endpoint for the LLM05 demo. Records exfil, returns 1x1 gif.
    if (p === "/leak") {
      const d = url.searchParams.get("d") || "";
      const s = await getSession(req, env);
      await env.DB.prepare("INSERT INTO events (ts,sid,level,kind,owasp,detail) VALUES (?,?,?,?,?,?)")
        .bind(Date.now(), s?.sid || "?", s?.level ?? -1, "leak_logger_hit", "LLM05", d.slice(0, 300)).run();
      try { await ctrl(env).fetch("https://do/event", { method: "POST", body: JSON.stringify({ type: "event", ts: Date.now(), kind: "leak_logger_hit", owasp: "LLM05", detail: d.slice(0, 120) }) }); } catch {}
      const gif = Uint8Array.from(atob("R0lGODlhAQABAAAAACwAAAAAAQABAAA="), c => c.charCodeAt(0));
      return new Response(gif, { headers: { "content-type": "image/gif", "cache-control": "no-store" } });
    }

    if (p === "/api/session" && req.method === "POST") {
      const s = await ensureSession(req, env, H);
      const st = await (await ctrl(env).fetch("https://do/state")).json();
      return json({ level: s.level, mode: st.mode, suggestedLevel: st.suggestedLevel, killed: st.killed }, { headers: H });
    }

    if (p === "/api/level" && req.method === "POST") {
      const s = await ensureSession(req, env, H);
      const { level } = await req.json();
      const lv = clampLevel(level);
      await env.DB.prepare("UPDATE sessions SET level=? WHERE sid=?").bind(lv, s.sid).run();
      return json({ level: lv }, { headers: H });
    }

    if (p === "/api/state") { const st = await (await ctrl(env).fetch("https://do/state")).json(); st.defaultModel = env.DEFAULT_MODEL; return json(st); }

    if (p === "/api/chat" && req.method === "POST") {
      const s = await ensureSession(req, env, H);
      const body = await req.json();
      const userText = String(body.message || "").slice(0, parseInt(env.MAX_INPUT_CHARS));
      if (!userText.trim()) return json({ error: "empty" }, { status: 400, headers: H });
      const st = await (await ctrl(env).fetch("https://do/state")).json();
      if (st.killed) return json({ error: "The demo is paused." }, { status: 503, headers: H });
      if (st.mode === "stage") return json({ error: "presentation_in_progress" }, { status: 423, headers: H });

      const presenter = await isPresenter(req, env);
      const acq = await ctrl(env).fetch(`https://do/acquire?presenter=${presenter ? 1 : 0}`);
      if (!acq.ok) return json({ error: "busy", queued: true }, { status: 429, headers: H });

      const canaries = await getCanaries(env);
      const levelCfg = getLevel(s.level);
      // Presenter-only model override (for model comparison and live fallback).
      const allowed = String(env.ALLOWED_MODELS || "").split(",").map(x => x.trim()).filter(Boolean);
      const model = presenter && body.model && allowed.includes(body.model) ? body.model : env.DEFAULT_MODEL;
      await env.DB.prepare("UPDATE sessions SET msg_count=msg_count+1 WHERE sid=?").bind(s.sid).run();
      await env.DB.prepare("INSERT INTO messages (sid,ts,role,content,level) VALUES (?,?,?,?,?)").bind(s.sid, Date.now(), "user", userText, s.level).run();

      const { readable, writable } = new TransformStream();
      const w = writable.getWriter();
      const send = (obj) => w.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      (async () => {
        try {
          await send({ type: "start", level: s.level });
          await runAgent(env, s, levelCfg, canaries, userText, async (out, hits) => {
            await env.DB.prepare("INSERT INTO messages (sid,ts,role,content,level) VALUES (?,?,?,?,?)").bind(s.sid, Date.now(), "assistant", out, s.level).run();
            await send({ type: "answer", text: out, model, hits: hits.map(h => ({ owasp: h.owasp, kind: h.kind })) });
          }, model);
        } catch (e) {
          await send({ type: "error", error: (e.message || String(e)).slice(0, 200) });
        } finally {
          await ctrl(env).fetch(`https://do/release?presenter=${presenter ? 1 : 0}`);
          await send({ type: "done" }); await w.close();
        }
      })();
      H.set("content-type", "text/event-stream"); H.set("cache-control", "no-store");
      return new Response(readable, { headers: H });
    }

    // ---- presenter ----
    if (p === "/api/presenter/login" && req.method === "POST") {
      const { passphrase } = await req.json();
      if (passphrase && passphrase === env.PRESENTER_PASSPHRASE) {
        H.append("set-cookie", `vr_presenter=${await presenterCookie(env)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`);
        return json({ ok: true }, { headers: H });
      }
      return json({ ok: false }, { status: 401, headers: H });
    }
    if (p.startsWith("/api/presenter/")) {
      if (!await isPresenter(req, env)) return json({ error: "unauthorized" }, { status: 401 });
      if (p === "/api/presenter/ws") { return ctrl(env).fetch("https://do/ws", req); }
      if (p === "/api/presenter/mode") { const b = await req.json(); return ctrl(env).fetch("https://do/mode", { method: "POST", body: JSON.stringify(b) }); }
      if (p === "/api/presenter/suggest") { const b = await req.json(); return ctrl(env).fetch("https://do/suggest", { method: "POST", body: JSON.stringify(b) }); }
      if (p === "/api/presenter/kill") { const b = await req.json(); return ctrl(env).fetch("https://do/kill", { method: "POST", body: JSON.stringify(b) }); }
      if (p === "/api/presenter/scoreboard") {
        const { results } = await env.DB.prepare("SELECT level, owasp, kind, COUNT(*) n FROM events WHERE owasp!='' GROUP BY level, owasp, kind ORDER BY level").all();
        const totals = await env.DB.prepare("SELECT level, COUNT(*) n FROM messages WHERE role='user' GROUP BY level").all();
        return json({ hits: results, attempts: totals.results });
      }
      if (p === "/api/presenter/reset" && req.method === "POST") {
        await env.DB.batch([env.DB.prepare("DELETE FROM events"), env.DB.prepare("DELETE FROM outbox"), env.DB.prepare("DELETE FROM ledger"), env.DB.prepare("DELETE FROM messages")]);
        return json({ ok: true });
      }
      if (p === "/api/presenter/outbox") { return json(await env.DB.prepare("SELECT * FROM outbox ORDER BY id DESC LIMIT 50").all()); }
    }

    // static assets (chat UI, presenter UI). CSP: images only from self => real external exfil blocked;
    // same-origin /leak still works to demonstrate the mechanism safely.
    const res = await env.ASSETS.fetch(req);
    const h = new Headers(res.headers);
    if ((h.get("content-type") || "").includes("text/html")) {
      h.set("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; script-src 'self' 'unsafe-inline'");
    }
    return new Response(res.body, { status: res.status, headers: h });
  },
};
