-- Test fixtures for the SQLite tests and e2e checks:
--   sqlite3 /tmp/app_dev.db < scripts/setup-test-db.sqlite.sql
-- (The integration tests build a fresh file from this script themselves.)
CREATE TABLE orders (id INTEGER PRIMARY KEY, total NUMERIC, created_at TEXT);
INSERT INTO orders VALUES (9007199254740993, 129.95, '2026-11-10 14:10:00');

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open',
  note VARCHAR(50) DEFAULT 'it''s',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_status ON customers (status);

CREATE TABLE "Order Items" (id INTEGER PRIMARY KEY, "Unit Price" DECIMAL(10, 2) NOT NULL);
CREATE VIEW paid_orders AS SELECT id, total FROM orders;

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  kind VARCHAR(20) NOT NULL,
  amount DECIMAL(10, 2),
  created_at TEXT NOT NULL
);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500)
INSERT INTO events
SELECT i,
       CASE i % 3 WHEN 0 THEN 'click' WHEN 1 THEN 'view' ELSE 'buy' END,
       CASE WHEN i % 10 = 0 THEN NULL ELSE printf('%.2f', i * 1.5) END,
       strftime('%Y-%m-%d %H:%M:%S', '2026-01-01 00:00:00', '+' || i || ' minutes')
  FROM n;

CREATE TABLE value_types (
  id INTEGER PRIMARY KEY,
  big INTEGER,
  doc TEXT,
  payload BLOB,
  real_value REAL,
  body TEXT,
  missing TEXT,
  total INTEGER GENERATED ALWAYS AS (big + 1) VIRTUAL
);
INSERT INTO value_types (id, big, doc, payload, real_value, body, missing) VALUES
  (1, 9007199254740993, '{"a": 1, "b": [true, null]}', x'deadbeef', 0.1, printf('%.*c', 5000, 'x'), NULL);

CREATE TABLE "we""ird" (id INTEGER PRIMARY KEY, label TEXT);
INSERT INTO "we""ird" VALUES (1, 'ok');

CREATE TABLE counter (n INTEGER);

CREATE TABLE editable (
  id INTEGER PRIMARY KEY,
  name VARCHAR(20) NOT NULL,
  qty INTEGER,
  note VARCHAR(50) DEFAULT 'n/a'
);
INSERT INTO editable (name, qty, note) VALUES ('appel', 3, 'rood'), ('peer', 5, NULL), ('kiwi', 7, 'groen');

CREATE TABLE pairs (a INTEGER, b INTEGER, v TEXT, PRIMARY KEY (a, b));
INSERT INTO pairs VALUES (1, 1, 'een'), (1, 2, 'twee');

CREATE TABLE nopk (x INTEGER);

CREATE TABLE "wat?" (id INTEGER PRIMARY KEY, label TEXT);
INSERT INTO "wat?" VALUES (1, 'echt?'), (2, 'ja');
