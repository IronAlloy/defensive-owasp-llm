#!/usr/bin/env python3
"""Reads data/generated/*.json and emits worker/seed.sql (D1 insert statements)."""
import json, pathlib
G = pathlib.Path(__file__).parent / "generated"
OUT = pathlib.Path(__file__).parent.parent / "worker" / "seed.sql"
load = lambda n: json.loads((G / f"{n}.json").read_text(encoding="utf-8"))
def q(v):
    if v is None: return "NULL"
    if isinstance(v, (int, float)): return str(v)
    return "'" + str(v).replace("'", "''") + "'"
lines = ["-- Generated seed. Do not edit by hand. All data fictional."]
def ins(table, cols, rows):
    for r in rows:
        vals = ", ".join(q(r.get(c)) for c in cols)
        lines.append(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({vals});")

ins("kb", ["id","tier","title","body"], load("kb"))
ins("customers", ["customer_id","name","name_native","email","phone","address","dob","club_tier","card_last4","since","notes"], load("customers"))
orders = load("orders")
for o in orders: o["items"] = json.dumps(o["items"], ensure_ascii=False)
ins("orders", ["order_id","customer_id","date","items","total_usd","status","ship_to"], orders)
ins("b2b", ["account_id","company","type","state","contact","contact_email","contact_phone","payment_terms","negotiated_discount_pct","credit_limit_usd","open_invoices_usd"], load("b2b_accounts"))
ins("product_costs", ["sku","cogs_usd","wholesale_usd","distributor_usd","dtc_margin_pct","wholesale_margin_pct"], load("product_costs"))
OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"seed.sql: {len(lines)-1} inserts -> {OUT}")
