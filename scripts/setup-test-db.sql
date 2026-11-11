-- Test fixtures for `npm run test:integration`. Run as root:
--   mysql -h 127.0.0.1 -u root -p < scripts/setup-test-db.sql
CREATE DATABASE IF NOT EXISTS app_dev;
CREATE DATABASE IF NOT EXISTS secret_db;

CREATE USER IF NOT EXISTS 'viewer'@'%' IDENTIFIED BY 'test123';
CREATE USER IF NOT EXISTS 'viewer'@'localhost' IDENTIFIED BY 'test123';
GRANT ALL ON app_dev.* TO 'viewer'@'%';
GRANT ALL ON app_dev.* TO 'viewer'@'localhost';
FLUSH PRIVILEGES;

CREATE TABLE IF NOT EXISTS app_dev.orders (
  id BIGINT PRIMARY KEY,
  total DECIMAL(20, 2),
  created_at DATETIME
);
-- 2^53 + 1: would lose precision as a JavaScript number.
REPLACE INTO app_dev.orders VALUES (9007199254740993, 129.95, '2026-11-10 14:10:00');

-- Schema fixtures (step 2): keys, defaults, a view, routines and an awkward table name.
CREATE TABLE IF NOT EXISTS app_dev.customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  status ENUM('open', 'closed') NOT NULL DEFAULT 'open',
  note VARCHAR(50) DEFAULT 'it''s',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_status (status)
) COMMENT = 'Klanten';

CREATE TABLE IF NOT EXISTS app_dev.`Order Items` (
  id INT PRIMARY KEY,
  `Unit Price` DECIMAL(10, 2) NOT NULL
);

CREATE OR REPLACE VIEW app_dev.paid_orders AS SELECT id, total FROM app_dev.orders;

DROP PROCEDURE IF EXISTS app_dev.refresh_stats;
CREATE PROCEDURE app_dev.refresh_stats() SELECT 1;

DROP FUNCTION IF EXISTS app_dev.order_count;
CREATE FUNCTION app_dev.order_count() RETURNS INT READS SQL DATA RETURN (SELECT COUNT(*) FROM app_dev.orders);

-- Must stay invisible to the viewer user.
CREATE TABLE IF NOT EXISTS secret_db.hidden (id INT PRIMARY KEY);

-- Data fixtures (step 3): enough rows to page and scroll, and every awkward kind of value.
DROP TABLE IF EXISTS app_dev.events;
CREATE TABLE app_dev.events (
  id INT PRIMARY KEY,
  kind VARCHAR(20) NOT NULL,
  amount DECIMAL(10, 2),
  created_at DATETIME NOT NULL
);
INSERT INTO app_dev.events (id, kind, amount, created_at)
SELECT n,
       ELT(1 + n % 3, 'click', 'view', 'buy'),
       CASE WHEN n % 10 = 0 THEN NULL ELSE ROUND(n * 1.5, 2) END,
       TIMESTAMPADD(MINUTE, n, '2026-01-01 00:00:00')
  FROM (SELECT a.d + 10 * b.d + 100 * c.d + 1000 * e.d + 1 AS n
          FROM (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
                UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a,
               (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
                UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b,
               (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
                UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c,
               (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2) e) numbers
 WHERE n <= 2500;

DROP TABLE IF EXISTS app_dev.value_types;
CREATE TABLE app_dev.value_types (
  id INT PRIMARY KEY,
  big BIGINT UNSIGNED,
  doc JSON,
  payload BLOB,
  flags BIT(8),
  body LONGTEXT,
  missing VARCHAR(10)
);
INSERT INTO app_dev.value_types VALUES
  (1, 18446744073709551615, '{"a": 1, "b": [true, null]}', UNHEX('DEADBEEF'), b'10100101', REPEAT('x', 5000), NULL);

-- A table name containing a backtick: must be quoted correctly, never injectable.
DROP TABLE IF EXISTS app_dev.`we``ird`;
CREATE TABLE app_dev.`we``ird` (id INT PRIMARY KEY, label VARCHAR(10));
INSERT INTO app_dev.`we``ird` VALUES (1, 'ok');
