# Running the Vespera Ridge demo

> Repo: github.com/IronAlloy/defensive-owasp-llm · Local path: /Users/sagi/Documents/GitHub/defensive-owasp-llm

Fictional winery. Intentionally vulnerable AI agent for a security talk. All data is generated.

## Layout
- `worker/`   — Cloudflare Worker + Durable Object (`Control`) + D1 schema/seed
- `web/`      — chat UI (`index.html`, English default + Hebrew/RTL toggle) and `presenter.html`
- `worker/src/levels.js` — defense levels L0–L5
- `data/`     — mock-data generators (`generate.py`, `build_kb.py`, `build_seed.py`), `traps.sql`
- `leads/`    — separate Worker + D1 for playbook email capture (own domain, no binding to the chat Worker/DB)

## Secrets (never commit)
Copy `worker/.dev.vars.example` to `worker/.dev.vars` and set:
- `OLLAMA_API_KEY`   — your Ollama Cloud key
- `PRESENTER_PASSPHRASE` — your presenter passphrase

## Regenerate data
```
cd data && python3 generate.py && python3 build_kb.py && python3 build_seed.py
```

## Local dev (this machine)
NOTE: `wrangler d1 execute --local` fails in this environment (proxy cancels its network call), so seed the local SQLite file directly, and keep wrangler state off the mounted folder (SQLite locking fails over the fuse mount):
```
cd worker
PERSIST=$HOME/vrstate
CLOUDFLARE_API_TOKEN=dummy npx wrangler dev --local --port 8788 --persist-to "$PERSIST"   # first run creates the DB file
# then, once, seed it:
DB=$(find "$PERSIST" -name '*.sqlite' | head -1)
python3 -c "import sqlite3,pathlib;c=sqlite3.connect('$DB');c.executescript(pathlib.Path('schema.sql').read_text());c.executescript(pathlib.Path('seed.sql').read_text());c.commit()"
# optional indirect-injection traps:
python3 -c "import sqlite3,pathlib;c=sqlite3.connect('$DB');c.executescript(pathlib.Path('../data/traps.sql').read_text());c.commit()"
```
Chat UI: http://localhost:8788/   ·   Presenter: http://localhost:8788/presenter

The model call only works where outbound fetch to ollama.com is allowed. In this sandbox that fetch is cancelled by the proxy, so the model step must be tested on a real Cloudflare deploy.

## Deploy (needs YOUR Cloudflare login + a browser step)
```
cd worker
npx wrangler login
npx wrangler d1 create vr_db          # paste the returned database_id into wrangler.toml
bash scripts/seed-remote.sh   # uses --command chunks; `--file --remote` (the /import API) returned
                              # "Authentication error [10000]" with an OAuth login on 2026-09-26
npx wrangler secret put OLLAMA_API_KEY
npx wrangler secret put PRESENTER_PASSPHRASE
npx wrangler deploy
```
Then in the Cloudflare dashboard: add the custom domain `defensive-prompt.ironalloy.info` (the `ironalloy.info` zone must use Cloudflare DNS), and add the one free rate-limiting rule on `/api/chat`.

## Status
Built and smoke-tested locally: sessions, per-visitor level, presenter auth, mode switching (stage/priority/open), 3-slot limiter + queue, kill switch, leak logger, scoreboard, mock outbox, D1 seed (150 customers / 400 orders / 15 KB docs), Hebrew/English UI. NOT yet verified: the live Ollama tool-calling loop (blocked locally by the proxy) — verify on deploy. NOT yet done: PDF export, GitHub push. Model shortlist done: gemma4:31b is the default (widest L0–L5 gradient of deepseek-v4.1-flash, nemotron-3-nano:30b, gpt-oss:20b, gemma4:31b). Leads Worker + playbook are deployed and live (see below).

## Live demo: LLM05 indirect injection (exfil)
gemma4:31b strips the trap docs' embedded instructions, so it can't show LLM05. For this segment only, switch to **gpt-oss:20b** via the presenter model dropdown (gemma4 stays default for the rest of the talk). Requires `data/traps.sql` loaded.
- Use the **shipping trap** (`exfil-shipping-en` / `trap-shipping-note`): fired 10/10 at L0 in testing. The review trap (`trap-review`) never fires with gpt-oss — don't use it.
- Show **L0 (leaks) → L4** (sanitizer strips the off-allowlist image, reply shows `[image removed]`, no new leak-dashboard entry).
- **L3 re-fires** (3/3 probe, 4/5 in browser) — grounding does not stop exfil, and L3 has no output sanitization. Skip L3, or use it deliberately to make the point "grounding is not output handling".
- **Gotcha:** if the projected chat tab is NOT logged in as presenter, the model override is silently ignored and the request runs on gemma4, which never fires (looks like 0 hits). Presenter-login the chat tab first and check the answer event's `model` field is gpt-oss:20b. The presenter console tab must also be logged in for its live feed to show `leak_logger_hit`.
- gpt-oss sometimes emits the trap's literal placeholder (`d=CUSTOMER_DATA_HERE`) instead of real PII; the channel still fires. For a real-data screenshot, do a customer lookup first or re-run. Occasional `ollama 500` — resend once.

## Leads Worker (playbook email capture) — separate app
Located in `leads/`. Its own Worker + D1 (`vr_leads`), **no binding to the chat Worker or its DB** — the vulnerable bot cannot reach real leads, and a leads-DB compromise can't reach the demo. That separation is itself one of the talk's points (blast-radius containment), so keep it that way.

### Local dev
Same fuse-mount caveat as the chat Worker — keep persisted state off the mounted folder:
```
cd leads
PERSIST=$HOME/vrleadsstate
CLOUDFLARE_API_TOKEN=dummy npx wrangler dev --local --port 8789 --persist-to "$PERSIST"   # first run creates the DB file
# then, once, seed the schema (no seed data needed — leads starts empty):
DB=$(find "$PERSIST" -name '*.sqlite' | head -1)
python3 -c "import sqlite3,pathlib;c=sqlite3.connect('$DB');c.executescript(pathlib.Path('schema.sql').read_text());c.commit()"
```
Signup form: http://localhost:8789/   ·   Playbook: http://localhost:8789/playbook   ·   Markdown download: http://localhost:8789/playbook.md

Turnstile is skipped automatically when `TURNSTILE_SECRET` isn't set (`verifyTurnstile` in `src/index.js` short-circuits to `true`) — no `.dev.vars` needed for local testing. `/api/subscribe` writes straight to the local D1 file, so you can submit the form for real and check it landed:
```
python3 -c "import sqlite3;c=sqlite3.connect('$DB');print(c.execute('select ts,email,name,lang from leads').fetchall())"
```

### Deploy (needs YOUR Cloudflare login + a browser step)
```
cd leads
npx wrangler d1 create vr_leads          # paste database_id into leads/wrangler.toml
npx wrangler d1 execute vr_leads --remote --file schema.sql
# optional anti-abuse: create a Cloudflare Turnstile widget, put its sitekey in wrangler.toml [vars],
# then: npx wrangler secret put TURNSTILE_SECRET
npx wrangler deploy
```
Then in the Cloudflare dashboard: add a custom domain for it (its own subdomain, e.g. `playbook.ironalloy.info` — any zone on Cloudflare DNS works, it does not need to share the chat Worker's zone), the same way you did for the chat Worker. Without a custom domain it's still reachable at its `*.workers.dev` URL.

### Integrating it into the talk
This Worker is deliberately a separate app on a separate domain with a separate D1 database — there is **no code-level integration** with the chat Worker, and that's by design, not something left to wire up. The two link up only at the presentation layer:
- **Closing slide**: put a QR code pointing at the leads Worker's URL (custom domain or `workers.dev`) on the last slide of the talk, so the audience scans it to get the playbook.
- **Presenter console** (`web/presenter.html`, served by the chat Worker) has no link to leads and shouldn't get one — keep the presenter tool scoped to running the vulnerable-bot demo.
- If you want a link from the chat UI itself (e.g. a "Get the playbook" button in `web/index.html`), add a plain `<a href="https://<leads-domain>/">` — a same-origin `fetch` from the chat page would violate the leads Worker's CSP (`connect-src 'self'`) and defeats the isolation, so keep it a normal outbound link, not an API call.

Export leads: `npx wrangler d1 execute vr_leads --remote --command "SELECT ts,email,name,lang,consent_marketing FROM leads ORDER BY ts DESC"`.

### Live
- Leads signup + playbook: https://defensive-playbook.ironalloy.info/  (custom domain; workers.dev fallback: https://vr-leads.ironalloy-info.workers.dev/)
- Chat demo: https://defensive-prompt.ironalloy.info/  ·  Presenter: https://defensive-prompt.ironalloy.info/presenter
