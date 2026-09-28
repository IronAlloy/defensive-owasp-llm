// Control Durable Object: single source of truth for presentation mode, suggested level,
// the 3-slot Ollama concurrency limiter + FIFO queue, and live fan-out to the presenter view.
const MAX_SLOTS = 3;                 // Ollama Cloud Pro concurrency
const PRESENTER_RESERVED = 1;        // reserved slot in "priority" mode

export class Control {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.mode = "open";              // stage | priority | open
    this.suggestedLevel = 0;
    this.killed = false;
    this.active = 0;                 // in-flight audience requests
    this.presenterActive = 0;
    this.queue = [];                 // [{resolve, isPresenter}]
    this.sockets = new Set();        // presenter dashboards
    this.state.blockConcurrencyWhile(async () => {
      this.mode = (await state.storage.get("mode")) || "open";
      this.suggestedLevel = (await state.storage.get("suggestedLevel")) || 0;
      this.killed = (await state.storage.get("killed")) || false;
    });
  }

  slotsForAudience() {
    return this.mode === "priority" ? MAX_SLOTS - PRESENTER_RESERVED
         : this.mode === "stage" ? 0 : MAX_SLOTS;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/ws") { // presenter dashboard live feed
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      this.sockets.add(pair[1]);
      pair[1].send(JSON.stringify({ type: "state", mode: this.mode, suggestedLevel: this.suggestedLevel, killed: this.killed, active: this.active, queued: this.queue.length }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (p === "/state") {
      return Response.json({ mode: this.mode, suggestedLevel: this.suggestedLevel, killed: this.killed,
        active: this.active, queued: this.queue.length, slotsForAudience: this.slotsForAudience() });
    }
    if (p === "/mode") {
      const { mode } = await req.json(); this.mode = mode; await this.state.storage.put("mode", mode);
      this.broadcast({ type: "state", mode: this.mode, suggestedLevel: this.suggestedLevel, killed: this.killed });
      this.pump(); return Response.json({ ok: true });
    }
    if (p === "/suggest") {
      const { level } = await req.json(); this.suggestedLevel = level; await this.state.storage.put("suggestedLevel", level);
      this.broadcast({ type: "suggest", level }); return Response.json({ ok: true });
    }
    if (p === "/kill") {
      const { killed } = await req.json(); this.killed = killed; await this.state.storage.put("killed", killed);
      this.broadcast({ type: "state", killed }); this.pump(); return Response.json({ ok: true });
    }
    if (p === "/event") { // relay a scoring/chat event to presenter dashboards
      this.broadcast(await req.json()); return Response.json({ ok: true });
    }
    if (p === "/acquire") {
      const isPresenter = url.searchParams.get("presenter") === "1";
      if (this.killed && !isPresenter) return new Response("killed", { status: 503 });
      const ok = await this.acquire(isPresenter);
      return ok ? Response.json({ ok: true }) : new Response("busy", { status: 429 });
    }
    if (p === "/release") {
      const isPresenter = url.searchParams.get("presenter") === "1";
      if (isPresenter) this.presenterActive = Math.max(0, this.presenterActive - 1);
      else this.active = Math.max(0, this.active - 1);
      this.pump(); this.broadcast({ type: "state", active: this.active, queued: this.queue.length });
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }

  acquire(isPresenter) {
    return new Promise((resolve) => {
      if (isPresenter) {
        // presenter always gets a slot up to MAX_SLOTS
        if (this.presenterActive + this.active < 100) { this.presenterActive++; return resolve(true); }
      }
      if (this.active < this.slotsForAudience()) { this.active++; this.broadcast({ type: "state", active: this.active, queued: this.queue.length }); return resolve(true); }
      // queue with a timeout so nobody waits forever
      const entry = { resolve, isPresenter, t: Date.now() };
      this.queue.push(entry);
      this.broadcast({ type: "state", active: this.active, queued: this.queue.length });
      setTimeout(() => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) { this.queue.splice(i, 1); resolve(false); }
      }, 25000);
    });
  }

  pump() {
    while (this.queue.length && this.active < this.slotsForAudience()) {
      const e = this.queue.shift(); this.active++; e.resolve(true);
    }
    this.broadcast({ type: "state", active: this.active, queued: this.queue.length });
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.sockets) { try { ws.send(s); } catch {} }
  }
  webSocketClose(ws) { this.sockets.delete(ws); }
  webSocketError(ws) { this.sockets.delete(ws); }
}
