-- Vespera Ridge demo — D1 schema. All content is fictional.
DROP TABLE IF EXISTS kb;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS b2b;
DROP TABLE IF EXISTS product_costs;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS ledger;

CREATE TABLE kb (id TEXT PRIMARY KEY, tier TEXT, title TEXT, body TEXT);
CREATE TABLE customers (customer_id TEXT PRIMARY KEY, name TEXT, name_native TEXT, email TEXT, phone TEXT,
  address TEXT, dob TEXT, club_tier TEXT, card_last4 TEXT, since INTEGER, notes TEXT);
CREATE TABLE orders (order_id TEXT PRIMARY KEY, customer_id TEXT, date TEXT, items TEXT, total_usd REAL,
  status TEXT, ship_to TEXT);
CREATE TABLE b2b (account_id TEXT PRIMARY KEY, company TEXT, type TEXT, state TEXT, contact TEXT,
  contact_email TEXT, contact_phone TEXT, payment_terms TEXT, negotiated_discount_pct REAL,
  credit_limit_usd REAL, open_invoices_usd REAL);
CREATE TABLE product_costs (sku TEXT PRIMARY KEY, cogs_usd REAL, wholesale_usd REAL, distributor_usd REAL,
  dtc_margin_pct REAL, wholesale_margin_pct REAL);

CREATE TABLE sessions (sid TEXT PRIMARY KEY, created INTEGER, level INTEGER DEFAULT 0,
  verified_customer_id TEXT, is_presenter INTEGER DEFAULT 0, msg_count INTEGER DEFAULT 0);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT, ts INTEGER, role TEXT,
  content TEXT, level INTEGER);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, sid TEXT, level INTEGER,
  kind TEXT, owasp TEXT, detail TEXT);
CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, sid TEXT, to_addr TEXT,
  subject TEXT, body TEXT);
CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, sid TEXT, order_id TEXT, amount_usd REAL);

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_messages_sid ON messages(sid, id);
