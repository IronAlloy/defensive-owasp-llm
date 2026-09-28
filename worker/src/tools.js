// Tool implementations over D1. Behavior tightens with level flags.
export const TOOL_DEFS = [
  { type: "function", function: { name: "search_kb",
    description: "Search the Vespera Ridge knowledge base for policies, catalog, club and FAQ.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "lookup_customer",
    description: "Look up a customer by email or name.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "lookup_order",
    description: "Look up an order by order id.",
    parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] } } },
  { type: "function", function: { name: "get_b2b_account",
    description: "Get a wholesale/trade account by company name.",
    parameters: { type: "object", properties: { company: { type: "string" } }, required: ["company"] } } },
  { type: "function", function: { name: "send_email",
    description: "Send an email to a customer (writes to a mock outbox; never really sends).",
    parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to","subject","body"] } } },
  { type: "function", function: { name: "issue_refund",
    description: "Issue a refund on an order (writes to a mock ledger).",
    parameters: { type: "object", properties: { order_id: { type: "string" }, amount_usd: { type: "number" } }, required: ["order_id","amount_usd"] } } },
];

const j = (o) => JSON.stringify(o);

export async function runTool(name, args, ctx) {
  const { DB, flags, session } = ctx;
  try {
    if (name === "search_kb") {
      const terms = String(args.query || "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
      // L5: separate indexes — public bot may only retrieve public docs.
      const tierClause = flags.separateIndexes ? "tier = 'public'" : "1=1";
      const { results } = await DB.prepare(`SELECT id,tier,title,body FROM kb WHERE ${tierClause}`).all();
      const scored = results.map(d => {
        const hay = (d.title + " " + d.body).toLowerCase();
        return { d, score: terms.reduce((s,t)=> s + (hay.includes(t)?1:0), 0) };
      }).filter(x => x.score > 0).sort((a,b)=>b.score-a.score).slice(0, 3);
      if (!scored.length) return "No matching documents.";
      return scored.map(x => `# ${x.d.title} [${x.d.tier}]\n${x.d.body}`).join("\n\n");
    }
    if (name === "lookup_customer") {
      if (flags.sessionScopedTools && !session.verified_customer_id)
        return "Customer lookup requires a verified session. Ask the customer to sign in.";
      const qy = `%${String(args.query||"").trim()}%`;
      let row;
      if (flags.sessionScopedTools) {
        row = await DB.prepare("SELECT * FROM customers WHERE customer_id=?").bind(session.verified_customer_id).first();
      } else {
        row = await DB.prepare("SELECT * FROM customers WHERE email LIKE ? OR name LIKE ? OR name_native LIKE ? LIMIT 1")
          .bind(qy, qy, qy).first();
      }
      return row ? j(row) : "No customer found.";
    }
    if (name === "lookup_order") {
      const row = await DB.prepare("SELECT * FROM orders WHERE order_id=?").bind(String(args.order_id||"")).first();
      if (!row) return "No order found.";
      if (flags.sessionScopedTools && row.customer_id !== session.verified_customer_id)
        return "That order belongs to another customer. Access denied.";
      return j(row);
    }
    if (name === "get_b2b_account") {
      if (flags.separateIndexes) return "B2B account details are not available through this assistant.";
      const row = await DB.prepare("SELECT * FROM b2b WHERE company LIKE ? LIMIT 1").bind(`%${String(args.company||"")}%`).first();
      return row ? j(row) : "No account found.";
    }
    if (name === "send_email") {
      if (flags.approvalTools) {
        await DB.prepare("INSERT INTO events (ts,sid,level,kind,owasp,detail) VALUES (?,?,?,?,?,?)")
          .bind(Date.now(), session.sid, session.level, "email_queued", "LLM06", j(args)).run();
        return "Email queued for staff approval (not sent).";
      }
      await DB.prepare("INSERT INTO outbox (ts,sid,to_addr,subject,body) VALUES (?,?,?,?,?)")
        .bind(Date.now(), session.sid, String(args.to||""), String(args.subject||""), String(args.body||"")).run();
      return `Email sent to ${args.to}. (mock outbox)`;
    }
    if (name === "issue_refund") {
      if (flags.approvalTools) {
        await DB.prepare("INSERT INTO events (ts,sid,level,kind,owasp,detail) VALUES (?,?,?,?,?,?)")
          .bind(Date.now(), session.sid, session.level, "refund_queued", "LLM06", j(args)).run();
        return "Refund queued for staff approval (not issued).";
      }
      await DB.prepare("INSERT INTO ledger (ts,sid,order_id,amount_usd) VALUES (?,?,?,?)")
        .bind(Date.now(), session.sid, String(args.order_id||""), Number(args.amount_usd||0)).run();
      return `Refund of $${args.amount_usd} issued on ${args.order_id}. (mock ledger)`;
    }
    return "Unknown tool.";
  } catch (e) {
    return "Tool error: " + (e.message || String(e));
  }
}
