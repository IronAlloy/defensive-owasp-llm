// vr-leads: playbook signup + storage. Separate origin, separate D1, no link to the chat demo.
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true; // disabled in dev
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token || "");
  if (ip) body.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    return (await r.json()).success === true;
  } catch { return false; }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/api/subscribe" && req.method === "POST") {
      let b; try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
      const email = String(b.email || "").trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400);
      if (!b.consent_playbook) return json({ error: "consent_required" }, 400);
      const ok = await verifyTurnstile(env, b.turnstile, req.headers.get("cf-connecting-ip"));
      if (!ok) return json({ error: "turnstile_failed" }, 400);
      const name = (b.name ? String(b.name) : "").slice(0, 120);
      const lang = b.lang === "he" ? "he" : "en";
      try {
        await env.LEADS_DB.prepare(
          `INSERT INTO leads (ts,email,name,lang,consent_playbook,consent_marketing,consent_text_version,source)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(email) DO UPDATE SET
             name=excluded.name, lang=excluded.lang,
             consent_playbook=excluded.consent_playbook, consent_marketing=excluded.consent_marketing,
             consent_text_version=excluded.consent_text_version, ts=excluded.ts`
        ).bind(Date.now(), email, name, lang, b.consent_playbook ? 1 : 0, b.consent_marketing ? 1 : 0,
               env.CONSENT_TEXT_VERSION || "", "talk").run();
      } catch (e) { return json({ error: "store_failed", detail: (e.message || "").slice(0, 120) }, 500); }
      return json({ ok: true, playbook: "/playbook", download: "/playbook.md" });
    }

    // config for the form (sitekey only; never the secret)
    if (p === "/api/config") return json({ turnstileSitekey: env.TURNSTILE_SITEKEY || "" });

    const res = await env.ASSETS.fetch(req);
    const h = new Headers(res.headers);
    if ((h.get("content-type") || "").includes("text/html")) {
      h.set("content-security-policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self'");
    }
    return new Response(res.body, { status: res.status, headers: h });
  },
};
